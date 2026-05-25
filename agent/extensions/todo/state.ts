/**
 * @fileoverview Todo state normalization, reconstruction, and snapshot helpers.
 */

import type {
	TodoAction,
	TodoDetails,
	TodoEvent,
	TodoEventMeta,
	TodoEventMetaValue,
	TodoEventType,
	TodoItem,
} from "./types";

export interface TodoState {
	todos: TodoItem[];
	nextId: number;
	wipLimit: number;
}

export interface TodoSessionEntry {
	type: string;
	message?: {
		role?: string;
		toolName?: string;
		details?: unknown;
	};
	customType?: string;
	data?: unknown;
}

export interface ReconstructedTodoSession {
	state: TodoState;
	widgetVisible: boolean;
}

export const DEFAULT_WIP_LIMIT = 2;
export const MAX_PERSISTED_HISTORY_ENTRIES = 50;

function now(): string {
	return new Date().toISOString();
}

export function createTodoState(): TodoState {
	return {
		todos: [],
		nextId: 1,
		wipLimit: DEFAULT_WIP_LIMIT,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function cloneTodoMetaValue(value: TodoEventMetaValue): TodoEventMetaValue {
	if (Array.isArray(value)) return value.map((item) => cloneTodoMetaValue(item));
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
		return value;
	}
	return cloneTodoMeta(value);
}

function cloneTodoMeta(meta: TodoEventMeta): TodoEventMeta {
	const clone: TodoEventMeta = {};
	for (const [key, value] of Object.entries(meta)) {
		if (value !== undefined) clone[key] = cloneTodoMetaValue(value);
	}
	return clone;
}

function normalizeTodoMetaValue(value: unknown): TodoEventMetaValue | undefined {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
		return value;
	}
	if (Array.isArray(value)) {
		const normalized: TodoEventMetaValue[] = [];
		for (const item of value) {
			const normalizedItem = normalizeTodoMetaValue(item);
			if (normalizedItem !== undefined) normalized.push(normalizedItem);
		}
		return normalized;
	}
	if (isRecord(value)) return normalizeTodoMeta(value);
	return undefined;
}

function normalizeTodoMeta(value: unknown): TodoEventMeta | undefined {
	if (!isRecord(value)) return undefined;
	const normalized: TodoEventMeta = {};
	for (const [key, entryValue] of Object.entries(value)) {
		const normalizedValue = normalizeTodoMetaValue(entryValue);
		if (normalizedValue !== undefined) normalized[key] = normalizedValue;
	}
	return normalized;
}

export function pruneTodoHistory(history: TodoItem["history"]): TodoItem["history"] {
	return history.length > MAX_PERSISTED_HISTORY_ENTRIES ? history.slice(-MAX_PERSISTED_HISTORY_ENTRIES) : history;
}

export function cloneTodos(items: TodoItem[]): TodoItem[] {
	return items.map((todo) => ({
		...todo,
		tags: [...todo.tags],
		blockerIds: [...todo.blockerIds],
		history: pruneTodoHistory(todo.history).map((entry) => ({
			...entry,
			meta: entry.meta ? cloneTodoMeta(entry.meta) : undefined,
		})),
	}));
}

export function normalizeTodo(raw: unknown): TodoItem | null {
	if (!isRecord(raw) || typeof raw.id !== "number") return null;
	const value = raw;
	const id = raw.id;

	const createdAt = typeof value.createdAt === "string" ? value.createdAt : now();
	const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : createdAt;
	const title =
		typeof value.title === "string"
			? value.title
			: typeof value.text === "string"
				? value.text
				: `Todo #${id}`;
	const status = normalizeStatus(value.status, value.done);
	const history = normalizeHistory(value.history, id);

	return {
		id,
		title,
		description: typeof value.description === "string" ? value.description : undefined,
		status,
		tags: Array.isArray(value.tags) ? value.tags.filter((item): item is string => typeof item === "string") : [],
		priority: value.priority === "low" || value.priority === "med" || value.priority === "high" ? value.priority : "med",
		effort: value.effort === "S" || value.effort === "M" || value.effort === "L" ? value.effort : "M",
		parentId: typeof value.parentId === "number" ? value.parentId : undefined,
		blockerIds: Array.isArray(value.blockerIds)
			? [...new Set(value.blockerIds.filter((item): item is number => typeof item === "number"))]
			: [],
		archived: Boolean(value.archived),
		history,
		createdAt,
		updatedAt,
	};
}

function normalizeStatus(status: unknown, done: unknown): TodoItem["status"] {
	if (status === "todo" || status === "in-progress" || status === "done") return status;
	if (status === "in_progress") return "in-progress";
	if (done === true) return "done";
	return "todo";
}

function isTodoEventType(value: unknown): value is TodoEventType {
	return (
		value === "created" ||
		value === "updated" ||
		value === "status_changed" ||
		value === "archived" ||
		value === "unarchived" ||
		value === "linked" ||
		value === "unlinked" ||
		value === "read" ||
		value === "cleared"
	);
}

function normalizeHistory(history: unknown, todoId: number): TodoItem["history"] {
	if (!Array.isArray(history)) return [];

	const normalized: TodoEvent[] = history
		.filter(
			(entry): entry is Record<string, unknown> & { timestamp: string; type: TodoEventType } =>
				isRecord(entry) && typeof entry.timestamp === "string" && isTodoEventType(entry.type),
		)
		.map((entry) => ({
			timestamp: entry.timestamp,
			type: entry.type,
			todoId: typeof entry.todoId === "number" ? entry.todoId : todoId,
			meta: normalizeTodoMeta(entry.meta),
		}));
	return pruneTodoHistory(normalized);
}

export function applyPersistedDetails(state: TodoState, details: unknown): TodoState {
	if (!isRecord(details) || !Array.isArray(details.todos)) return state;

	const todos = details.todos.map((todo) => normalizeTodo(todo)).filter((todo): todo is TodoItem => todo !== null);
	return {
		todos,
		nextId: typeof details.nextId === "number" ? details.nextId : Math.max(0, ...todos.map((todo) => todo.id)) + 1,
		wipLimit:
			typeof details.wipLimit === "number" && details.wipLimit > 0 ? Math.floor(details.wipLimit) : DEFAULT_WIP_LIMIT,
	};
}

export function reconstructTodoSession(entries: readonly TodoSessionEntry[]): ReconstructedTodoSession {
	let state = createTodoState();
	let widgetVisible = false;

	for (const entry of entries) {
		if (entry.type === "message") {
			const message = entry.message;
			if (message?.role !== "toolResult" || message.toolName !== "todo") continue;
			state = applyPersistedDetails(state, message.details);
			continue;
		}

		if (entry.type === "custom" && entry.customType === "todo-state") {
			state = applyPersistedDetails(state, entry.data);
			continue;
		}

		if (entry.type === "custom" && entry.customType === "todo-widget-state") {
			widgetVisible = isRecord(entry.data) && Boolean(entry.data.visible);
		}
	}

	return { state, widgetVisible };
}

export function createSnapshot(state: TodoState, action: TodoAction, error?: string): TodoDetails {
	return {
		action,
		todos: cloneTodos(state.todos),
		nextId: state.nextId,
		wipLimit: state.wipLimit,
		error,
	};
}
