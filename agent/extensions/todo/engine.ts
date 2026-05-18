/**
 * @fileoverview Todo action engine, validation rules, and selectors.
 */

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { cloneTodos, createSnapshot, pruneTodoHistory, type TodoState } from "./state";
import { filteredTodoPool, listText, statusLabel, unfinishedBlockers } from "./presenters";
export { filteredTodoPool, listText, statusLabel, unfinishedBlockers } from "./presenters";
import type {
	TodoAction,
	TodoEventMeta,
	TodoEventType,
	TodoItem,
	TodoPriority,
	TodoResult,
	TodoStatus,
	TodoView,
} from "./types";

export interface TodoExecuteParams {
	action: TodoAction;
	id?: number;
	title?: string;
	description?: string;
	tags?: string[];
	priority?: TodoPriority;
	effort?: TodoItem["effort"];
	parentId?: number;
	blockerIds?: number[];
	addBlockerIds?: number[];
	removeBlockerIds?: number[];
	clearParent?: boolean;
	toStatus?: TodoStatus;
	view?: TodoView;
	includeArchived?: boolean;
	status?: TodoStatus;
	tag?: string;
	archived?: boolean;
	limit?: number;
	historyLimit?: number;
}

const allowedParams: Record<TodoAction, Set<string>> = {
	list: new Set(["view", "includeArchived", "status", "tag"]),
	add: new Set(["title", "description", "tags", "priority", "effort", "parentId", "blockerIds"]),
	update: new Set(["id", "title", "description", "tags", "priority", "effort", "parentId", "blockerIds"]),
	toggle: new Set(["id", "toStatus"]),
	read: new Set(["id"]),
	archive: new Set(["id", "archived"]),
	link: new Set(["id", "parentId", "addBlockerIds"]),
	unlink: new Set(["id", "clearParent", "removeBlockerIds"]),
	history: new Set(["id", "historyLimit"]),
	clear: new Set([]),
	set_wip_limit: new Set(["limit"]),
};

const TODO_OUTPUT_MAX_LINES = Math.min(DEFAULT_MAX_LINES, 700);
const TODO_OUTPUT_MAX_BYTES = Math.min(DEFAULT_MAX_BYTES, 30 * 1024);

function truncateTodoOutput(text: string): string {
	const truncation = truncateHead(text, {
		maxLines: TODO_OUTPUT_MAX_LINES,
		maxBytes: TODO_OUTPUT_MAX_BYTES,
	});
	if (!truncation.truncated) return truncation.content;

	const omittedLines = truncation.totalLines - truncation.outputLines;
	const omittedBytes = truncation.totalBytes - truncation.outputBytes;
	const notice = `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ${omittedLines} lines (${formatSize(omittedBytes)}) omitted.]`;
	return `${truncation.content}\n\n${notice}`;
}

function now(): string {
	return new Date().toISOString();
}

function cloneState(state: TodoState): TodoState {
	return {
		todos: cloneTodos(state.todos),
		nextId: state.nextId,
		wipLimit: state.wipLimit,
	};
}

function addHistory(todo: TodoItem, type: TodoEventType, meta?: TodoEventMeta) {
	const timestamp = now();
	todo.history.push({ timestamp, type, todoId: todo.id, meta });
	todo.history = pruneTodoHistory(todo.history);
	todo.updatedAt = timestamp;
}

export function findTodo(state: TodoState, id: number): TodoItem | undefined {
	return state.todos.find((todo) => todo.id === id);
}

function dependentsOf(state: TodoState, id: number): TodoItem[] {
	return state.todos.filter((todo) => !todo.archived && todo.blockerIds.includes(id));
}

function inProgressCount(state: TodoState): number {
	return state.todos.filter((todo) => !todo.archived && todo.status === "in-progress").length;
}

function childrenOf(state: TodoState, id: number): TodoItem[] {
	return state.todos.filter((todo) => todo.parentId === id && !todo.archived);
}

function hasOpenChildren(state: TodoState, id: number): boolean {
	return childrenOf(state, id).some((todo) => todo.status !== "done");
}

export function wouldCreateParentCycle(state: TodoState, todoId: number, nextParentId: number | undefined): boolean {
	let current = nextParentId;
	const visited = new Set<number>();
	while (current !== undefined) {
		if (current === todoId || visited.has(current)) return true;
		visited.add(current);
		current = findTodo(state, current)?.parentId;
	}
	return false;
}

function dependsOn(state: TodoState, startId: number, targetId: number, visited = new Set<number>()): boolean {
	if (startId === targetId) return true;
	if (visited.has(startId)) return false;
	visited.add(startId);
	const start = findTodo(state, startId);
	if (!start) return false;
	for (const blockerId of start.blockerIds) {
		if (dependsOn(state, blockerId, targetId, visited)) return true;
	}
	return false;
}

function isAllowedTransition(from: TodoStatus, to: TodoStatus): boolean {
	if (from === to) return true;
	if (from === "todo" && to === "in-progress") return true;
	if (from === "in-progress" && to === "done") return true;
	if (from === "in-progress" && to === "todo") return true;
	if (from === "done" && to === "todo") return true;
	return false;
}

function cycleStatus(status: TodoStatus): TodoStatus {
	switch (status) {
		case "todo":
			return "in-progress";
		case "in-progress":
			return "done";
		case "done":
			return "todo";
	}
}

function allowedTransitionsFrom(from: TodoStatus): TodoStatus[] {
	return (["todo", "in-progress", "done"] as const).filter((to) => to !== from && isAllowedTransition(from, to));
}

function invalidTransitionMessage(from: TodoStatus): string {
	const valid = allowedTransitionsFrom(from).map(statusLabel).join(", ");
	return `Invalid transition. Valid from ${statusLabel(from)}: ${valid}`;
}

function todoLabel(todo: TodoItem): string {
	return `Todo #${todo.id}: ${todo.title}`;
}

function ok(state: TodoState, action: TodoAction, text: string): TodoResult {
	return {
		content: [{ type: "text", text }],
		details: createSnapshot(state, action),
	};
}

function fail(state: TodoState, action: TodoAction, text: string, error: string): TodoResult {
	return {
		content: [{ type: "text", text }],
		details: createSnapshot(state, action, error),
	};
}

export function resultText(result: TodoResult): string {
	const text = result.content[0];
	return text?.type === "text" ? text.text : "";
}

function validateActionParams(
	state: TodoState,
	action: TodoAction,
	params: TodoExecuteParams,
): { ok: true } | { ok: false; result: TodoResult } {
	const invalid = Object.keys(params)
		.filter((key) => key !== "action" && !allowedParams[action].has(key))
		.sort();
	if (invalid.length === 0) return { ok: true };
	const label = invalid.length === 1 ? "parameter" : "parameters";
	const names = invalid.join(", ");
	return {
		ok: false,
		result: fail(state, action, `Error: unsupported ${label} for ${action}: ${names}`, `unsupported ${label} for ${action}: ${names}`),
	};
}

function validateParentAndBlockers(
	state: TodoState,
	todoId: number,
	parentId: number | undefined,
	blockerIds: number[],
	action: TodoAction,
): { ok: true } | { ok: false; result: TodoResult } {
	if (parentId !== undefined) {
		if (!findTodo(state, parentId)) {
			return {
				ok: false,
				result: fail(state, action, `Parent #${parentId} not found`, `parent #${parentId} not found`),
			};
		}
		if (wouldCreateParentCycle(state, todoId, parentId)) {
			return { ok: false, result: fail(state, action, "Parent cycle detected", "parent cycle detected") };
		}
	}

	for (const blockerId of blockerIds) {
		if (!findTodo(state, blockerId)) {
			return {
				ok: false,
				result: fail(state, action, `Blocker #${blockerId} not found`, `blocker #${blockerId} not found`),
			};
		}
		if (blockerId === todoId || dependsOn(state, blockerId, todoId)) {
			return { ok: false, result: fail(state, action, "Dependency cycle detected", "dependency cycle detected") };
		}
	}

	return { ok: true };
}

export function readTodoText(todo: TodoItem): string {
	return [
		`#${todo.id} ${todo.title}`,
		`Status: ${statusLabel(todo.status)}`,
		`Priority/Effort: ${todo.priority}/${todo.effort}`,
		`Tags: ${todo.tags.length ? todo.tags.join(", ") : "(none)"}`,
		`Parent: ${todo.parentId !== undefined ? `#${todo.parentId}` : "(none)"}`,
		`Blockers: ${todo.blockerIds.length ? todo.blockerIds.map((id) => `#${id}`).join(", ") : "(none)"}`,
		`Archived: ${todo.archived ? "yes" : "no"}`,
		"",
		"Description:",
		todo.description?.trim() ? todo.description : "(empty)",
	].join("\n");
}

export function executeTodoAction(
	state: TodoState,
	params: TodoExecuteParams,
): { state: TodoState; result: TodoResult } {
	const nextState = cloneState(state);
	const actionValidation = validateActionParams(nextState, params.action, params);
	if (actionValidation.ok === false) {
		return { state: nextState, result: actionValidation.result };
	}

	switch (params.action) {
		case "list": {
			const view = params.view ?? "default";
			const includeArchived = params.includeArchived ?? false;
			return {
				state: nextState,
				result: ok(nextState, "list", truncateTodoOutput(listText(nextState, view, includeArchived, params.status, params.tag))),
			};
		}

		case "add": {
			if (!params.title?.trim()) {
				return { state: nextState, result: fail(nextState, "add", "Error: title required for add", "title required") };
			}
			const id = nextState.nextId++;
			const parentId = params.parentId;
			const blockerIds = [...new Set(params.blockerIds ?? [])];
			const validation = validateParentAndBlockers(nextState, id, parentId, blockerIds, "add");
			if (validation.ok === false) return { state: nextState, result: validation.result };

			const createdAt = now();
			const todo: TodoItem = {
				id,
				title: params.title.trim(),
				description: params.description,
				status: "todo",
				tags: params.tags ?? [],
				priority: params.priority ?? "med",
				effort: params.effort ?? "M",
				parentId,
				blockerIds,
				archived: false,
				history: [],
				createdAt,
				updatedAt: createdAt,
			};
			addHistory(todo, "created", { title: todo.title, parentId: todo.parentId, blockerIds: todo.blockerIds });
			nextState.todos.push(todo);
			return { state: nextState, result: ok(nextState, "add", `Added todo #${todo.id}: ${todo.title}`) };
		}

		case "update": {
			if (params.id === undefined) {
				return { state: nextState, result: fail(nextState, "update", "Error: id required", "id required") };
			}
			const todo = findTodo(nextState, params.id);
			if (!todo) {
				return { state: nextState, result: fail(nextState, "update", `Todo #${params.id} not found`, `#${params.id} not found`) };
			}
			if (params.title !== undefined && !params.title.trim()) {
				return { state: nextState, result: fail(nextState, "update", "Error: title required for update", "title required") };
			}

			const nextParentId = params.parentId !== undefined ? params.parentId : todo.parentId;
			const nextBlockers = params.blockerIds !== undefined ? [...new Set(params.blockerIds)] : [...todo.blockerIds];
			const validation = validateParentAndBlockers(nextState, todo.id, nextParentId, nextBlockers, "update");
			if (validation.ok === false) return { state: nextState, result: validation.result };

			if (params.title !== undefined) todo.title = params.title;
			if (params.description !== undefined) todo.description = params.description;
			if (params.tags !== undefined) todo.tags = params.tags;
			if (params.priority !== undefined) todo.priority = params.priority;
			if (params.effort !== undefined) todo.effort = params.effort;
			if (params.parentId !== undefined) todo.parentId = params.parentId;
			if (params.blockerIds !== undefined) todo.blockerIds = nextBlockers;

			addHistory(todo, "updated", {
				title: params.title,
				description: params.description,
				tags: params.tags,
				priority: params.priority,
				effort: params.effort,
				parentId: params.parentId,
				blockerIds: params.blockerIds,
			});
			return { state: nextState, result: ok(nextState, "update", `Updated todo #${todo.id}`) };
		}

		case "link": {
			if (params.id === undefined) {
				return { state: nextState, result: fail(nextState, "link", "Error: id required", "id required") };
			}
			const todo = findTodo(nextState, params.id);
			if (!todo) {
				return { state: nextState, result: fail(nextState, "link", `Todo #${params.id} not found`, `#${params.id} not found`) };
			}

			const nextParentId = params.parentId !== undefined ? params.parentId : todo.parentId;
			const nextBlockers = [...new Set([...(todo.blockerIds ?? []), ...(params.addBlockerIds ?? [])])];
			const validation = validateParentAndBlockers(nextState, todo.id, nextParentId, nextBlockers, "link");
			if (validation.ok === false) return { state: nextState, result: validation.result };

			todo.parentId = nextParentId;
			todo.blockerIds = nextBlockers;
			addHistory(todo, "linked", { parentId: params.parentId, addBlockerIds: params.addBlockerIds ?? [] });
			return { state: nextState, result: ok(nextState, "link", `Updated relationships for todo #${todo.id}`) };
		}

		case "unlink": {
			if (params.id === undefined) {
				return { state: nextState, result: fail(nextState, "unlink", "Error: id required", "id required") };
			}
			const todo = findTodo(nextState, params.id);
			if (!todo) {
				return { state: nextState, result: fail(nextState, "unlink", `Todo #${params.id} not found`, `#${params.id} not found`) };
			}

			const removeBlockerIds = params.removeBlockerIds ?? [];
			if (!params.clearParent && removeBlockerIds.length === 0) {
				return {
					state: nextState,
					result: fail(nextState, "unlink", "Error: provide clearParent and/or removeBlockerIds", "no unlink operation provided"),
				};
			}

			if (params.clearParent) todo.parentId = undefined;
			if (removeBlockerIds.length > 0) {
				const removeSet = new Set(removeBlockerIds);
				todo.blockerIds = todo.blockerIds.filter((id) => !removeSet.has(id));
			}
			addHistory(todo, "unlinked", { clearParent: Boolean(params.clearParent), removeBlockerIds });
			return { state: nextState, result: ok(nextState, "unlink", `Removed selected relationships from todo #${todo.id}`) };
		}

		case "toggle": {
			if (params.id === undefined) {
				return { state: nextState, result: fail(nextState, "toggle", "Error: id required", "id required") };
			}
			const todo = findTodo(nextState, params.id);
			if (!todo) {
				return { state: nextState, result: fail(nextState, "toggle", `Todo #${params.id} not found`, `#${params.id} not found`) };
			}
			if (todo.archived) {
				return { state: nextState, result: fail(nextState, "toggle", `${todoLabel(todo)} is archived`, "cannot toggle archived todo") };
			}

			const previousStatus = todo.status;
			const nextStatus = params.toStatus ?? cycleStatus(previousStatus);
			if (!isAllowedTransition(previousStatus, nextStatus)) {
				return { state: nextState, result: fail(nextState, "toggle", invalidTransitionMessage(previousStatus), "invalid transition") };
			}
			if (previousStatus === nextStatus) {
				return { state: nextState, result: ok(nextState, "toggle", `${todoLabel(todo)} already ${statusLabel(nextStatus)}`) };
			}

			if (nextStatus === "in-progress") {
				const blockers = unfinishedBlockers(nextState, todo);
				if (blockers.length) {
					return {
						state: nextState,
						result: fail(nextState, "toggle", `${todoLabel(todo)} is blocked by ${blockers.map((id) => `#${id}`).join(", ")}`, "unfinished blockers"),
					};
				}
				if (previousStatus !== "in-progress" && inProgressCount(nextState) >= nextState.wipLimit) {
					return {
						state: nextState,
						result: fail(
							nextState,
							"toggle",
							`WIP limit reached (${nextState.wipLimit}). Finish or pause another in-progress todo first.`,
							"wip limit reached",
						),
					};
				}
			}

			if (nextStatus === "done") {
				const blockers = unfinishedBlockers(nextState, todo);
				if (blockers.length) {
					return {
						state: nextState,
						result: fail(
							nextState,
							"toggle",
							`${todoLabel(todo)} cannot be done while blocked by ${blockers.map((id) => `#${id}`).join(", ")}`,
							"unfinished blockers",
						),
					};
				}
				if (hasOpenChildren(nextState, todo.id)) {
					return { state: nextState, result: fail(nextState, "toggle", `${todoLabel(todo)} has unfinished children`, "unfinished children") };
				}
			}

			if (previousStatus === "done" && nextStatus !== "done") {
				const activeDependents = dependentsOf(nextState, todo.id).filter((dependent) => dependent.status !== "todo");
				if (activeDependents.length) {
					return {
						state: nextState,
						result: fail(
							nextState,
							"toggle",
							`Cannot reopen ${todoLabel(todo)}; active dependents: ${activeDependents.map((dependent) => `#${dependent.id}`).join(", ")}`,
							"active dependents",
						),
					};
				}
			}

			todo.status = nextStatus;
			addHistory(todo, "status_changed", { from: previousStatus, to: nextStatus });
			return {
				state: nextState,
				result: ok(nextState, "toggle", `${todoLabel(todo)} moved ${statusLabel(previousStatus)} → ${statusLabel(nextStatus)}`),
			};
		}

		case "read": {
			if (params.id === undefined) {
				return { state: nextState, result: fail(nextState, "read", "Error: id required", "id required") };
			}
			const todo = findTodo(nextState, params.id);
			if (!todo) {
				return { state: nextState, result: fail(nextState, "read", `Todo #${params.id} not found`, `#${params.id} not found`) };
			}

			addHistory(todo, "read");
			return { state: nextState, result: ok(nextState, "read", truncateTodoOutput(readTodoText(todo))) };
		}

		case "history": {
			const limit = params.historyLimit && params.historyLimit > 0 ? Math.floor(params.historyLimit) : 20;
			if (params.id !== undefined) {
				const todo = findTodo(nextState, params.id);
				if (!todo) {
					return { state: nextState, result: fail(nextState, "history", `Todo #${params.id} not found`, `#${params.id} not found`) };
				}
				const lines = todo.history
					.slice(-limit)
					.map((entry) => `${entry.timestamp} ${entry.type}${entry.meta ? ` ${JSON.stringify(entry.meta)}` : ""}`);
				const historyText = lines.length ? lines.join("\n") : `No history for #${todo.id}`;
				return { state: nextState, result: ok(nextState, "history", truncateTodoOutput(historyText)) };
			}

			const all = nextState.todos
				.flatMap((todo) => todo.history.map((entry) => ({ ...entry, title: todo.title })))
				.sort((left, right) => left.timestamp.localeCompare(right.timestamp))
				.slice(-limit)
				.map((entry) => `${entry.timestamp} #${entry.todoId} ${entry.type} (${entry.title})`);
			const historyText = all.length ? all.join("\n") : "No history yet";
			return { state: nextState, result: ok(nextState, "history", truncateTodoOutput(historyText)) };
		}

		case "archive": {
			if (params.id === undefined) {
				return { state: nextState, result: fail(nextState, "archive", "Error: id required", "id required") };
			}
			const todo = findTodo(nextState, params.id);
			if (!todo) {
				return { state: nextState, result: fail(nextState, "archive", `Todo #${params.id} not found`, `#${params.id} not found`) };
			}

			const nextArchived = params.archived ?? true;
			if (nextArchived && todo.status !== "done") {
				return { state: nextState, result: fail(nextState, "archive", "Only done todos can be archived", "archive requires done status") };
			}
			todo.archived = nextArchived;
			addHistory(todo, nextArchived ? "archived" : "unarchived");
			return {
				state: nextState,
				result: ok(nextState, "archive", `${nextArchived ? "Archived" : "Unarchived"} todo #${todo.id}`),
			};
		}

		case "set_wip_limit": {
			if (params.limit === undefined || !Number.isFinite(params.limit) || params.limit < 1) {
				return { state: nextState, result: fail(nextState, "set_wip_limit", "Error: positive limit required", "invalid limit") };
			}
			nextState.wipLimit = Math.floor(params.limit);
			return { state: nextState, result: ok(nextState, "set_wip_limit", `Set WIP limit to ${nextState.wipLimit}`) };
		}

		case "clear": {
			const count = nextState.todos.length;
			nextState.todos = [];
			nextState.nextId = 1;
			return { state: nextState, result: ok(nextState, "clear", `Cleared ${count} todos`) };
		}
	}
}
