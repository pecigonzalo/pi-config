/**
 * Todo Extension - Stateful todo graph with dependencies
 *
 * State is persisted in tool result details (not external files), which enables
 * branch-aware reconstruction from session history.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

type TodoStatus = "todo" | "in-progress" | "done";
type TodoPriority = "low" | "med" | "high";
type TodoEffort = "S" | "M" | "L";

type TodoAction =
	| "list"
	| "add"
	| "update"
	| "toggle"
	| "read"
	| "archive"
	| "link"
	| "unlink"
	| "history"
	| "clear"
	| "set_wip_limit";

type TodoEventType =
	| "created"
	| "updated"
	| "status_changed"
	| "archived"
	| "unarchived"
	| "linked"
	| "unlinked"
	| "read"
	| "cleared";

interface TodoEvent {
	timestamp: string;
	type: TodoEventType;
	todoId: number;
	meta?: Record<string, unknown>;
}

interface TodoItem {
	id: number;
	title: string;
	description?: string;
	status: TodoStatus;
	tags: string[];
	priority: TodoPriority;
	effort: TodoEffort;
	parentId?: number;
	blockerIds: number[];
	archived: boolean;
	history: TodoEvent[];
	createdAt: string;
	updatedAt: string;
}

interface TodoDetails {
	action: TodoAction;
	todos: TodoItem[];
	nextId: number;
	wipLimit: number;
	error?: string;
}

type TodoResult = {
	content: [{ type: "text"; text: string }];
	details: TodoDetails;
};

const TodoParams = Type.Object({
	action: StringEnum(
		["list", "add", "update", "toggle", "read", "archive", "link", "unlink", "history", "clear", "set_wip_limit"] as const,
	),
	id: Type.Optional(Type.Number({ description: "Todo ID" })),
	title: Type.Optional(Type.String({ description: "Short title" })),
	description: Type.Optional(Type.String({ description: "Long description" })),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Tags" })),
	priority: Type.Optional(StringEnum(["low", "med", "high"] as const)),
	effort: Type.Optional(StringEnum(["S", "M", "L"] as const)),
	parentId: Type.Optional(Type.Number({ description: "Parent todo ID" })),
	blockerIds: Type.Optional(Type.Array(Type.Number(), { description: "Blocking todo IDs (replace set)" })),
	addBlockerIds: Type.Optional(Type.Array(Type.Number(), { description: "Blocking todo IDs to add" })),
	removeBlockerIds: Type.Optional(Type.Array(Type.Number(), { description: "Blocking todo IDs to remove" })),
	clearParent: Type.Optional(Type.Boolean({ description: "Clear parent relationship" })),
	toStatus: Type.Optional(StringEnum(["todo", "in-progress", "done"] as const, { description: "Target status for toggle action" })),
	view: Type.Optional(StringEnum(["default", "tree", "ready"] as const)),
	includeArchived: Type.Optional(Type.Boolean()),
	status: Type.Optional(StringEnum(["todo", "in-progress", "done"] as const)),
	tag: Type.Optional(Type.String()),
	archived: Type.Optional(Type.Boolean({ description: "Archive (true) or unarchive (false)" })),
	limit: Type.Optional(Type.Number({ description: "WIP limit for in-progress todos" })),
	historyLimit: Type.Optional(Type.Number({ description: "Max history entries" })),
});

class TodoListComponent {
	private lines: string[];
	private title: string;
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(lines: string[], title: string, theme: Theme, onClose: () => void) {
		this.lines = lines;
		this.title = title;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const out: string[] = [];
		out.push("");
		const title = th.fg("accent", ` ${this.title} `);
		const header = th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - this.title.length - 8)));
		out.push(truncateToWidth(header, width));
		out.push("");

		if (this.lines.length === 0) {
			out.push(truncateToWidth(`  ${th.fg("dim", "No todos")}`, width));
		} else {
			for (const line of this.lines) out.push(truncateToWidth(`  ${line}`, width));
		}

		out.push("");
		out.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		out.push("");

		this.cachedWidth = width;
		this.cachedLines = out;
		return out;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

interface TodoBrowserRow {
	todo: TodoItem;
	summary: string;
	details: string[];
	selectedLabel: string;
}

type TodoBrowserAction =
	| { type: "close" }
	| { type: "read"; id: number }
	| { type: "toggle"; id: number }
	| { type: "archive"; id: number };

type TodoDetailField = "title" | "description" | "status" | "priority" | "effort" | "tags";

type TodoDetailAction =
	| { type: "back"; selectedField: TodoDetailField }
	| { type: "edit"; id: number; field: TodoDetailField; selectedField: TodoDetailField }
	| { type: "toggle"; id: number; selectedField: TodoDetailField }
	| { type: "archive"; id: number; selectedField: TodoDetailField };

class TodoBrowserComponent {
	private rows: TodoBrowserRow[];
	private title: string;
	private theme: Theme;
	private onAction: (action: TodoBrowserAction) => void;
	private selectedIndex = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(rows: TodoBrowserRow[], title: string, theme: Theme, onAction: (action: TodoBrowserAction) => void) {
		this.rows = rows;
		this.title = title;
		this.theme = theme;
		this.onAction = onAction;
	}

	private getSelected(): TodoBrowserRow | undefined {
		return this.rows[this.selectedIndex];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onAction({ type: "close" });
			return;
		}

		if (this.rows.length === 0) return;

		if (matchesKey(data, "up") && this.selectedIndex > 0) {
			this.selectedIndex--;
			this.invalidate();
			return;
		}
		if (matchesKey(data, "down") && this.selectedIndex < this.rows.length - 1) {
			this.selectedIndex++;
			this.invalidate();
			return;
		}

		const selected = this.getSelected();
		if (!selected) return;

		if (matchesKey(data, "enter")) {
			this.onAction({ type: "read", id: selected.todo.id });
			return;
		}
		if (data === "t") {
			this.onAction({ type: "toggle", id: selected.todo.id });
			return;
		}
		if (data === "a") {
			this.onAction({ type: "archive", id: selected.todo.id });
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const out: string[] = [];
		out.push("");
		const title = th.fg("accent", ` ${this.title} `);
		const header = th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - this.title.length - 8)));
		out.push(truncateToWidth(header, width));
		out.push("");

		if (this.rows.length === 0) {
			out.push(truncateToWidth(`  ${th.fg("dim", "No todos")}`, width));
		} else {
			out.push(truncateToWidth(`  ${th.fg("dim", "↑↓ select · enter view · t status · a archive · esc close")}`, width));
			out.push("");
			this.rows.forEach((row, index) => {
				const selected = index === this.selectedIndex;
				const prefix = selected ? th.fg("accent", "› ") : "  ";
				const summary = truncateToWidth(`${prefix}${row.summary}`, width);
				out.push(selected ? th.bg("selectedBg", summary) : summary);

				for (const line of row.details) {
					out.push(truncateToWidth(`    ${line}`, width));
				}
			});
		}

		out.push("");
		const selected = this.getSelected();
		if (selected) {
			out.push(truncateToWidth(`  ${selected.selectedLabel}`, width));
		}
		out.push("");

		this.cachedWidth = width;
		this.cachedLines = out;
		return out;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

class TodoDetailComponent {
	private static readonly fields: TodoDetailField[] = ["title", "description", "status", "priority", "effort", "tags"];

	private todo: TodoItem;
	private theme: Theme;
	private onAction: (action: TodoDetailAction) => void;
	private selectedIndex: number;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todo: TodoItem, theme: Theme, selectedField: TodoDetailField, onAction: (action: TodoDetailAction) => void) {
		this.todo = todo;
		this.theme = theme;
		this.onAction = onAction;
		const index = TodoDetailComponent.fields.indexOf(selectedField);
		this.selectedIndex = index >= 0 ? index : 0;
	}

	private get selectedField(): TodoDetailField {
		return TodoDetailComponent.fields[this.selectedIndex] ?? "title";
	}

	private statusLabel(status: TodoStatus): string {
		return status === "in-progress" ? "in progress" : status;
	}

	private colorStatusIcon(status: TodoStatus): string {
		const icon = status === "done" ? "✓" : status === "in-progress" ? "▶" : "○";
		if (status === "done") return this.theme.fg("success", icon);
		if (status === "in-progress") return this.theme.fg("accent", icon);
		return this.theme.fg("muted", icon);
	}

	private colorPriority(priority: TodoPriority): string {
		if (priority === "high") return this.theme.fg("error", priority);
		if (priority === "med") return this.theme.fg("warning", priority);
		return this.theme.fg("success", priority);
	}

	private colorEffort(effort: TodoEffort): string {
		if (effort === "L") return this.theme.fg("warning", effort);
		if (effort === "M") return this.theme.fg("accent", effort);
		return this.theme.fg("muted", effort);
	}

	private styleTitle(title: string, status: TodoStatus): string {
		if (status === "in-progress") return this.theme.fg("accent", this.theme.bold(title));
		if (status === "done") return this.theme.fg("success", title);
		return title;
	}

	private selectPrev(): void {
		if (this.selectedIndex > 0) {
			this.selectedIndex--;
			this.invalidate();
		}
	}

	private selectNext(): void {
		if (this.selectedIndex < TodoDetailComponent.fields.length - 1) {
			this.selectedIndex++;
			this.invalidate();
		}
	}

	private renderField(width: number, label: string, value: string, selected: boolean): string[] {
		const th = this.theme;
		const prefix = selected ? th.fg("accent", "› ") : "  ";
		const header = truncateToWidth(`${prefix}${th.fg("muted", `${label}`)} ${th.fg("dim", "[editable]")}`, width);
		const valueIndent = "    ";
		const wrappedValue = wrapTextWithAnsi(value, Math.max(10, width - valueIndent.length));
		const valueLines = wrappedValue.length > 0 ? wrappedValue : [th.fg("dim", "(empty)")];
		return [
			selected ? th.bg("selectedBg", header) : header,
			...valueLines.map((line) => {
				const rendered = truncateToWidth(`${valueIndent}${line}`, width);
				return selected ? th.bg("selectedBg", rendered) : rendered;
			}),
		];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onAction({ type: "back", selectedField: this.selectedField });
			return;
		}
		if (matchesKey(data, "up")) {
			this.selectPrev();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selectNext();
			return;
		}
		if (matchesKey(data, "enter") || data === "e") {
			this.onAction({ type: "edit", id: this.todo.id, field: this.selectedField, selectedField: this.selectedField });
			return;
		}
		if (data === "t") {
			this.onAction({ type: "toggle", id: this.todo.id, selectedField: this.selectedField });
			return;
		}
		if (data === "a") {
			this.onAction({ type: "archive", id: this.todo.id, selectedField: this.selectedField });
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const out: string[] = [];
		out.push("");
		const title = th.fg("accent", ` Todo #${this.todo.id} `);
		const header = th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 17)));
		out.push(truncateToWidth(header, width));
		out.push("");
		out.push(truncateToWidth(`  ${th.fg("dim", "↑↓ select field · enter/e edit field · t cycle status · a archive · esc back")}`, width));
		out.push("");

		const rows: Array<{ field: TodoDetailField; label: string; value: string }> = [
			{ field: "title", label: "Title", value: this.styleTitle(this.todo.title, this.todo.status) },
			{
				field: "description",
				label: "Description",
				value: this.todo.description?.trim() ? this.todo.description : th.fg("dim", "(empty)"),
			},
			{ field: "status", label: "Status", value: this.colorStatusIcon(this.todo.status) + ` ${this.statusLabel(this.todo.status)}` },
			{ field: "priority", label: "Priority", value: this.colorPriority(this.todo.priority) },
			{ field: "effort", label: "Effort", value: this.colorEffort(this.todo.effort) },
			{
				field: "tags",
				label: "Tags",
				value: this.todo.tags.length ? th.fg("dim", `[${this.todo.tags.join(", ")}]`) : th.fg("dim", "(none)"),
			},
		];

		rows.forEach((row, index) => {
			out.push(...this.renderField(width, row.label, row.value, index === this.selectedIndex));
			out.push("");
		});

		out.push(truncateToWidth(`  ${th.fg("dim", "Readonly")}`, width));
		out.push(truncateToWidth(`  ${th.fg("muted", "Parent:")} ${this.todo.parentId !== undefined ? th.fg("accent", `#${this.todo.parentId}`) : th.fg("dim", "(none)")}`, width));
		out.push(
			truncateToWidth(
				`  ${th.fg("muted", "Blockers:")} ${this.todo.blockerIds.length ? this.todo.blockerIds.map((id) => th.fg("accent", `#${id}`)).join(", ") : th.fg("dim", "(none)")}`,
				width,
			),
		);
		out.push(truncateToWidth(`  ${th.fg("muted", "Archived:")} ${this.todo.archived ? th.fg("dim", "yes") : "no"}`, width));
		out.push("");

		this.cachedWidth = width;
		this.cachedLines = out;
		return out;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	let todos: TodoItem[] = [];
	let nextId = 1;
	let wipLimit = 2;

	const now = () => new Date().toISOString();

	const cloneTodos = (items: TodoItem[]): TodoItem[] =>
		items.map((t) => ({
			...t,
			tags: [...t.tags],
			blockerIds: [...t.blockerIds],
			history: t.history.map((h) => ({ ...h, meta: h.meta ? { ...h.meta } : undefined })),
		}));

	const addHistory = (todo: TodoItem, type: TodoEventType, meta?: Record<string, unknown>) => {
		todo.history.push({ timestamp: now(), type, todoId: todo.id, meta });
		todo.updatedAt = now();
	};

	const findTodo = (id: number): TodoItem | undefined => todos.find((t) => t.id === id);
	const dependentsOf = (id: number): TodoItem[] => todos.filter((t) => !t.archived && t.blockerIds.includes(id));

	const normalizeTodo = (raw: any): TodoItem | null => {
		if (!raw || typeof raw !== "object" || typeof raw.id !== "number") return null;
		const created = typeof raw.createdAt === "string" ? raw.createdAt : now();
		const updated = typeof raw.updatedAt === "string" ? raw.updatedAt : created;
		const title = typeof raw.title === "string" ? raw.title : typeof raw.text === "string" ? raw.text : `Todo #${raw.id}`;
		const status: TodoStatus =
			raw.status === "todo" || raw.status === "in-progress" || raw.status === "done"
				? raw.status
				: raw.status === "in_progress"
					? "in-progress"
					: raw.done === true
						? "done"
						: "todo";
		return {
			id: raw.id,
			title,
			description: typeof raw.description === "string" ? raw.description : undefined,
			status,
			tags: Array.isArray(raw.tags) ? raw.tags.filter((x: unknown) => typeof x === "string") : [],
			priority: raw.priority === "low" || raw.priority === "med" || raw.priority === "high" ? raw.priority : "med",
			effort: raw.effort === "S" || raw.effort === "M" || raw.effort === "L" ? raw.effort : "M",
			parentId: typeof raw.parentId === "number" ? raw.parentId : undefined,
			blockerIds: Array.isArray(raw.blockerIds)
				? ([...new Set(raw.blockerIds.filter((x: unknown): x is number => typeof x === "number"))] as number[])
				: [],
			archived: Boolean(raw.archived),
			history: Array.isArray(raw.history)
				? raw.history
						.filter((x: any) => x && typeof x.timestamp === "string" && typeof x.type === "string")
						.map((x: any) => ({
							timestamp: x.timestamp,
							type: x.type as TodoEventType,
							todoId: typeof x.todoId === "number" ? x.todoId : raw.id,
							meta: x.meta && typeof x.meta === "object" ? x.meta : undefined,
						}))
				: [],
			createdAt: created,
			updatedAt: updated,
		};
	};

	const applyPersistedDetails = (details: Partial<TodoDetails> | undefined) => {
		if (!details || !Array.isArray(details.todos)) return;
		todos = details.todos.map((t) => normalizeTodo(t)).filter((t): t is TodoItem => t !== null);
		nextId = typeof details.nextId === "number" ? details.nextId : Math.max(0, ...todos.map((t) => t.id)) + 1;
		wipLimit = typeof details.wipLimit === "number" && details.wipLimit > 0 ? Math.floor(details.wipLimit) : 2;
	};

	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;
		wipLimit = 2;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message") {
				const msg = entry.message;
				if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
				applyPersistedDetails(msg.details as Partial<TodoDetails> | undefined);
				continue;
			}

			if (entry.type === "custom" && entry.customType === "todo-state") {
				applyPersistedDetails(entry.data as Partial<TodoDetails> | undefined);
			}
		}
	};

	const inProgressCount = () => todos.filter((t) => !t.archived && t.status === "in-progress").length;

	const unfinishedBlockers = (todo: TodoItem): number[] =>
		todo.blockerIds.filter((id) => {
			const blocker = findTodo(id);
			return blocker !== undefined && !blocker.archived && blocker.status !== "done";
		});

	const hasUnfinishedBlockers = (todo: TodoItem) => unfinishedBlockers(todo).length > 0;
	const childrenOf = (id: number) => todos.filter((t) => t.parentId === id && !t.archived);
	const hasOpenChildren = (id: number) => childrenOf(id).some((c) => c.status !== "done");

	const wouldCreateParentCycle = (todoId: number, nextParentId: number | undefined): boolean => {
		let current = nextParentId;
		while (current !== undefined) {
			if (current === todoId) return true;
			current = findTodo(current)?.parentId;
		}
		return false;
	};

	const dependsOn = (startId: number, targetId: number, visited = new Set<number>()): boolean => {
		if (startId === targetId) return true;
		if (visited.has(startId)) return false;
		visited.add(startId);
		const start = findTodo(startId);
		if (!start) return false;
		for (const blockerId of start.blockerIds) {
			if (dependsOn(blockerId, targetId, visited)) return true;
		}
		return false;
	};

	const isAllowedTransition = (from: TodoStatus, to: TodoStatus): boolean => {
		if (from === to) return true;
		if (from === "todo" && to === "in-progress") return true;
		if (from === "in-progress" && to === "done") return true;
		if (from === "in-progress" && to === "todo") return true;
		if (from === "done" && to === "todo") return true;
		return false;
	};

	const cycleStatus = (status: TodoStatus): TodoStatus => {
		switch (status) {
			case "todo":
				return "in-progress";
			case "in-progress":
				return "done";
			case "done":
				return "todo";
		}
	};

	const statusLabel = (s: TodoStatus) => (s === "in-progress" ? "in progress" : s);
	const allowedTransitionsFrom = (from: TodoStatus): TodoStatus[] =>
		(["todo", "in-progress", "done"] as const).filter((to) => to !== from && isAllowedTransition(from, to));
	const invalidTransitionMessage = (from: TodoStatus): string => {
		const valid = allowedTransitionsFrom(from).map(statusLabel).join(", ");
		return `Invalid transition. Valid from ${statusLabel(from)}: ${valid}`;
	};
	const byId = (a: TodoItem, b: TodoItem) => a.id - b.id;
	const priorityText = (priority: TodoPriority) => priority;
	const effortText = (effort: TodoEffort) => effort;
	const sep = (theme?: Theme) => (theme ? theme.fg("dim", " · ") : " · ");
	const colorPriority = (priority: TodoPriority, theme?: Theme) => {
		if (!theme) return priorityText(priority);
		if (priority === "high") return theme.fg("error", priorityText(priority));
		if (priority === "med") return theme.fg("warning", priorityText(priority));
		return theme.fg("success", priorityText(priority));
	};
	const colorEffort = (effort: TodoEffort, theme?: Theme) => {
		const text = effortText(effort);
		if (!theme) return text;
		if (effort === "L") return theme.fg("warning", text);
		if (effort === "M") return theme.fg("accent", text);
		return theme.fg("muted", text);
	};
	const colorStatusIcon = (status: TodoStatus, theme?: Theme) => {
		const icon = status === "done" ? "✓" : status === "in-progress" ? "▶" : "○";
		if (!theme) return icon;
		if (status === "done") return theme.fg("success", icon);
		if (status === "in-progress") return theme.fg("accent", icon);
		return theme.fg("muted", icon);
	};
	const styleTitle = (todo: TodoItem, theme?: Theme) => {
		if (!theme) return todo.title;
		if (todo.status === "in-progress") return theme.fg("accent", theme.bold(todo.title));
		if (todo.status === "done") return theme.fg("success", todo.title);
		return todo.title;
	};

	const summaryLine = (t: TodoItem, theme?: Theme): string => {
		const parts = [
			`[${colorStatusIcon(t.status, theme)}]`,
			theme ? theme.fg("accent", `#${t.id}`) : `#${t.id}`,
			styleTitle(t, theme),
		];
		const tags = t.tags.length ? (theme ? theme.fg("dim", `[${t.tags.join(",")}]`) : ` [${t.tags.join(",")}]`) : "";
		const meta = [colorPriority(t.priority, theme), colorEffort(t.effort, theme)].join(sep(theme));
		const archived = t.archived ? (theme ? theme.fg("dim", "archived") : "archived") : "";
		const suffix = [tags, meta, archived].filter(Boolean).join(sep(theme));
		return `${parts.join(" ")}${suffix ? ` ${suffix}` : ""}`;
	};

	const relationshipLines = (t: TodoItem, showParent = true, theme?: Theme): string[] => {
		const lines: string[] = [];
		const branch = theme ? theme.fg("dim", "↳") : "↳";
		if (showParent && t.parentId !== undefined) {
			const label = theme ? theme.fg("muted", "parent") : "parent";
			const parentId = theme ? theme.fg("accent", `#${t.parentId}`) : `#${t.parentId}`;
			lines.push(`${branch} ${label}: ${parentId}`);
		}
		const blockers = unfinishedBlockers(t);
		if (blockers.length) {
			const label = theme ? theme.fg("warning", "blocked by") : "blocked by";
			const refs = blockers.map((id) => (theme ? theme.fg("accent", `#${id}`) : `#${id}`)).join(", ");
			lines.push(`${branch} ${label}: ${refs}`);
		}
		return lines;
	};

	const renderFlatTodo = (t: TodoItem, indent = "  ", showParent = true, theme?: Theme): string[] => [
		`${indent}${summaryLine(t, theme)}`,
		...relationshipLines(t, showParent, theme).map((line) => `${indent}  ${line}`),
	];

	const renderHierarchy = (pool: TodoItem[], theme?: Theme): string[] => {
		const idSet = new Set(pool.map((t) => t.id));
		const childMap = new Map<number, TodoItem[]>();
		for (const item of pool) {
			if (item.parentId !== undefined && idSet.has(item.parentId)) {
				const arr = childMap.get(item.parentId) ?? [];
				arr.push(item);
				childMap.set(item.parentId, arr.sort(byId));
			}
		}
		const roots = pool.filter((t) => t.parentId === undefined || !idSet.has(t.parentId)).sort(byId);
		const lines: string[] = [];
		const walk = (item: TodoItem, prefix: string, childPrefix: string, showParent: boolean) => {
			lines.push(prefix + summaryLine(item, theme));
			for (const line of relationshipLines(item, showParent, theme)) lines.push(childPrefix + line);
			const children = childMap.get(item.id) ?? [];
			children.forEach((child, index) => {
				const last = index === children.length - 1;
				const branch = theme ? theme.fg("dim", last ? "└─ " : "├─ ") : last ? "└─ " : "├─ ";
				const trunk = theme ? theme.fg("dim", last ? "   " : "│  ") : last ? "   " : "│  ";
				walk(child, `${childPrefix}${branch}`, `${childPrefix}${trunk}`, false);
			});
		};
		for (const root of roots) walk(root, "", "  ", root.parentId !== undefined && !idSet.has(root.parentId));
		return lines;
	};

	const listText = (
		view: "default" | "tree" | "ready",
		includeArchived: boolean,
		status?: TodoStatus,
		tag?: string,
		theme?: Theme,
	): string => {
		let pool = todos.filter((t) => includeArchived || !t.archived);
		if (status) pool = pool.filter((t) => t.status === status);
		if (tag) pool = pool.filter((t) => t.tags.includes(tag));
		pool = [...pool].sort(byId);

		if (view === "ready") {
			const ready = pool.filter((t) => t.status === "todo" && !hasUnfinishedBlockers(t));
			return ready.length ? ready.flatMap((t) => renderFlatTodo(t, "  ", true, theme)).join("\n") : "No ready todos";
		}

		const lines = renderHierarchy(pool, theme);
		return lines.length ? lines.join("\n") : "No todos";
	};

	const buildCommandTitle = (
		view: "default" | "tree" | "ready",
		includeArchived: boolean,
		status?: TodoStatus,
		tag?: string,
	) => `Todos${includeArchived ? " • all" : ""}${status ? ` • ${statusLabel(status)}` : ""}${tag ? ` • tag:${tag}` : ""}${view === "ready" ? " • ready" : ""}`;

	const filteredTodoPool = (
		view: "default" | "tree" | "ready",
		includeArchived: boolean,
		status?: TodoStatus,
		tag?: string,
	): TodoItem[] => {
		let pool = todos.filter((t) => includeArchived || !t.archived);
		if (status) pool = pool.filter((t) => t.status === status);
		if (tag) pool = pool.filter((t) => t.tags.includes(tag));
		pool = [...pool].sort(byId);
		if (view === "ready") return pool.filter((t) => t.status === "todo" && !hasUnfinishedBlockers(t));
		return pool;
	};

	const buildTodoBrowserRows = (
		view: "default" | "tree" | "ready",
		includeArchived: boolean,
		status?: TodoStatus,
		tag?: string,
		theme?: Theme,
	): TodoBrowserRow[] => {
		const pool = filteredTodoPool(view, includeArchived, status, tag);
		if (view === "ready") {
			return pool.map((todo) => ({
				todo,
				summary: summaryLine(todo, theme),
				details: relationshipLines(todo, true, theme).map((line) => `  ${line}`),
				selectedLabel: `${theme ? theme.fg("muted", `#${todo.id}`) : `#${todo.id}`} ${styleTitle(todo, theme)} ${theme ? theme.fg("dim", `(${statusLabel(todo.status)})`) : `(${statusLabel(todo.status)})`}`,
			}));
		}

		const idSet = new Set(pool.map((t) => t.id));
		const childMap = new Map<number, TodoItem[]>();
		for (const item of pool) {
			if (item.parentId !== undefined && idSet.has(item.parentId)) {
				const arr = childMap.get(item.parentId) ?? [];
				arr.push(item);
				childMap.set(item.parentId, arr.sort(byId));
			}
		}
		const roots = pool.filter((t) => t.parentId === undefined || !idSet.has(t.parentId)).sort(byId);
		const rows: TodoBrowserRow[] = [];
		const walk = (item: TodoItem, prefix: string, childPrefix: string, showParent: boolean) => {
			rows.push({
				todo: item,
				summary: `${prefix}${summaryLine(item, theme)}`,
				details: relationshipLines(item, showParent, theme).map((line) => `${childPrefix}${line}`),
				selectedLabel: `${theme ? theme.fg("muted", `#${item.id}`) : `#${item.id}`} ${styleTitle(item, theme)} ${theme ? theme.fg("dim", `(${statusLabel(item.status)})`) : `(${statusLabel(item.status)})`}`,
			});
			const children = childMap.get(item.id) ?? [];
			children.forEach((child, index) => {
				const last = index === children.length - 1;
				const branch = last ? "└─ " : "├─ ";
				const trunk = last ? "   " : "│  ";
				walk(child, `${childPrefix}${branch}`, `${childPrefix}${trunk}`, false);
			});
		};
		for (const root of roots) walk(root, "", "  ", root.parentId !== undefined && !idSet.has(root.parentId));
		return rows;
	};

	const editTodoFieldFromCommand = async (todo: TodoItem, field: TodoDetailField, ctx: ExtensionContext) => {
		let result: TodoResult | undefined;
		switch (field) {
			case "title": {
				const nextTitle = await ctx.ui.editor(`Title for #${todo.id}`, todo.title);
				if (nextTitle === undefined) return;
				const normalizedTitle = nextTitle
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean)
					.join(" ");
				if (normalizedTitle === todo.title) return;
				if (!normalizedTitle) {
					ctx.ui.notify("Title cannot be empty", "error");
					return;
				}
				result = updateTodoAction({ id: todo.id, title: normalizedTitle });
				break;
			}
			case "description": {
				const nextDescription = await ctx.ui.editor(`Description for #${todo.id}`, todo.description ?? "");
				if (nextDescription === undefined || nextDescription === (todo.description ?? "")) return;
				result = updateTodoAction({ id: todo.id, description: nextDescription });
				break;
			}
			case "tags": {
				const nextTags = await ctx.ui.editor(`Tags for #${todo.id} (comma separated)`, todo.tags.join(", "));
				if (nextTags === undefined) return;
				const parsed = nextTags
					.replace(/\n/g, ",")
					.split(",")
					.map((tag) => tag.trim())
					.filter(Boolean);
				if (parsed.join(",") === todo.tags.join(",")) return;
				result = updateTodoAction({ id: todo.id, tags: parsed });
				break;
			}
			case "priority": {
				const nextPriority = await ctx.ui.select(`Priority for #${todo.id}`, ["low", "med", "high"]);
				if (!nextPriority || nextPriority === todo.priority) return;
				result = updateTodoAction({ id: todo.id, priority: nextPriority as TodoPriority });
				break;
			}
			case "effort": {
				const nextEffort = await ctx.ui.select(`Effort for #${todo.id}`, ["S", "M", "L"]);
				if (!nextEffort || nextEffort === todo.effort) return;
				result = updateTodoAction({ id: todo.id, effort: nextEffort as TodoEffort });
				break;
			}
			case "status": {
				const nextStatus = await ctx.ui.select(`Status for #${todo.id}`, ["todo", "in-progress", "done"]);
				if (!nextStatus || nextStatus === todo.status) return;
				result = toggleTodoAction(todo.id, nextStatus as TodoStatus);
				break;
			}
		}

		if (result) applyInteractiveResult(result, ctx);
	};

	const showTodoDetails = async (id: number, ctx: ExtensionContext) => {
		let selectedField: TodoDetailField = "title";
		while (true) {
			const todo = findTodo(id);
			if (!todo) {
				ctx.ui.notify(`Todo #${id} not found`, "error");
				return;
			}

			const action = await ctx.ui.custom<TodoDetailAction>((_tui, theme, _kb, done) => {
				return new TodoDetailComponent(todo, theme, selectedField, done);
			});
			selectedField = action.selectedField;

			if (action.type === "back") return;
			if (action.type === "edit") {
				await editTodoFieldFromCommand(todo, action.field, ctx);
				continue;
			}
			if (action.type === "toggle") {
				applyInteractiveResult(toggleTodoAction(id), ctx);
				continue;
			}
			applyInteractiveResult(archiveTodoAction(id, !todo.archived), ctx);
		}
	};

	const handleTodosCommand = async (args: string, ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("/todos requires interactive mode", "error");
			return;
		}

		const tokens = args
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.map((t) => t.toLowerCase());

		let view: "default" | "tree" | "ready" = "default";
		let includeArchived = false;
		let status: TodoStatus | undefined;
		let tag: string | undefined;
		const invalidTokens: string[] = [];

		for (const token of tokens) {
			if (token === "default" || token === "tree") view = token;
			else if (token === "ready") view = token;
			else if (token === "all") includeArchived = true;
			else if (token === "todo" || token === "done") status = token;
			else if (token === "in-progress" || token === "in_progress") status = "in-progress";
			else if (token.startsWith("tag:")) tag = token.slice(4);
			else invalidTokens.push(token);
		}

		if (invalidTokens.length > 0) {
			const label = invalidTokens.length === 1 ? "token" : "tokens";
			ctx.ui.notify(
				`Unsupported /todos ${label}: ${invalidTokens.join(", ")}. Usage: /todos [ready] [all] [todo|in-progress|done] [tag:<name>]`,
				"error",
			);
			return;
		}

		while (true) {
			const title = buildCommandTitle(view, includeArchived, status, tag);
			const action = await ctx.ui.custom<TodoBrowserAction>((_tui, theme, _kb, done) => {
				return new TodoBrowserComponent(buildTodoBrowserRows(view, includeArchived, status, tag, theme), title, theme, done);
			});

			if (action.type === "close") return;

			const todo = findTodo(action.id);
			if (!todo) {
				ctx.ui.notify(`Todo #${action.id} not found`, "error");
				continue;
			}

			if (action.type === "read") {
				await showTodoDetails(todo.id, ctx);
				continue;
			}

			if (action.type === "toggle") {
				applyInteractiveResult(toggleTodoAction(todo.id), ctx);
				continue;
			}

			const nextArchived = !todo.archived;
			applyInteractiveResult(archiveTodoAction(todo.id, nextArchived), ctx);
		}
	};

	const snapshot = (action: TodoAction, error?: string): TodoDetails => ({
		action,
		todos: cloneTodos(todos),
		nextId,
		wipLimit,
		error,
	});

	const ok = (action: TodoAction, text: string): TodoResult => ({
		content: [{ type: "text", text }],
		details: snapshot(action),
	});

	const fail = (action: TodoAction, text: string, error: string): TodoResult => ({
		content: [{ type: "text", text }],
		details: snapshot(action, error),
	});

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

	const validateActionParams = (
		action: TodoAction,
		params: Record<string, unknown>,
	): { ok: true } | { ok: false; result: ReturnType<typeof fail> } => {
		const invalid = Object.keys(params)
			.filter((key) => key !== "action" && !allowedParams[action].has(key))
			.sort();
		if (invalid.length === 0) return { ok: true };
		const label = invalid.length === 1 ? "parameter" : "parameters";
		const names = invalid.join(", ");
		return {
			ok: false,
			result: fail(action, `Error: unsupported ${label} for ${action}: ${names}`, `unsupported ${label} for ${action}: ${names}`),
		};
	};

	const validateParentAndBlockers = (
		todoId: number,
		parentId: number | undefined,
		blockerIds: number[],
		action: TodoAction,
	): { ok: true } | { ok: false; result: ReturnType<typeof fail> } => {
		if (parentId !== undefined) {
			if (!findTodo(parentId)) {
				return { ok: false, result: fail(action, `Parent #${parentId} not found`, `parent #${parentId} not found`) };
			}
			if (wouldCreateParentCycle(todoId, parentId)) {
				return { ok: false, result: fail(action, "Parent cycle detected", "parent cycle detected") };
			}
		}

		for (const blockerId of blockerIds) {
			if (!findTodo(blockerId)) {
				return { ok: false, result: fail(action, `Blocker #${blockerId} not found`, `blocker #${blockerId} not found`) };
			}
			if (blockerId === todoId || dependsOn(blockerId, todoId)) {
				return { ok: false, result: fail(action, "Dependency cycle detected", "dependency cycle detected") };
			}
		}

		return { ok: true };
	};

	const resultText = (result: TodoResult) => {
		const text = result.content[0];
		return text?.type === "text" ? text.text : "";
	};

	const applyInteractiveResult = (result: TodoResult, ctx: ExtensionContext) => {
		if (result.details.error) {
			ctx.ui.notify(resultText(result), "error");
			return;
		}
		pi.appendEntry("todo-state", result.details);
		ctx.ui.notify(resultText(result), "info");
	};

	const readTodoText = (todo: TodoItem): string =>
		[
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

	const updateTodoAction = (params: {
		id: number;
		title?: string;
		description?: string;
		tags?: string[];
		priority?: TodoPriority;
		effort?: TodoEffort;
		parentId?: number;
		blockerIds?: number[];
	}) => {
		const todo = findTodo(params.id);
		if (!todo) return fail("update", `Todo #${params.id} not found`, `#${params.id} not found`);

		const nextParentId = params.parentId !== undefined ? params.parentId : todo.parentId;
		const nextBlockers = params.blockerIds !== undefined ? [...new Set(params.blockerIds)] : [...todo.blockerIds];
		const validation = validateParentAndBlockers(todo.id, nextParentId, nextBlockers, "update");
		if (validation.ok === false) return validation.result;

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
		return ok("update", `Updated todo #${todo.id}`);
	};

	const toggleTodoAction = (id: number, toStatus?: TodoStatus) => {
		const todo = findTodo(id);
		if (!todo) return fail("toggle", `Todo #${id} not found`, `#${id} not found`);
		if (todo.archived) return fail("toggle", `Todo #${todo.id} is archived`, "cannot toggle archived todo");

		const prev = todo.status;
		const nextStatus = toStatus ?? cycleStatus(prev);

		if (!isAllowedTransition(prev, nextStatus)) {
			return fail("toggle", invalidTransitionMessage(prev), "invalid transition");
		}
		if (prev === nextStatus) return ok("toggle", `Todo #${todo.id} already ${statusLabel(nextStatus)}`);

		if (nextStatus === "in-progress") {
			const blockers = unfinishedBlockers(todo);
			if (blockers.length) {
				return fail("toggle", `Todo #${todo.id} is blocked by ${blockers.map((b) => `#${b}`).join(", ")}`, "unfinished blockers");
			}
			if (prev !== "in-progress" && inProgressCount() >= wipLimit) {
				return fail("toggle", `WIP limit reached (${wipLimit}). Finish or pause another in-progress todo first.`, "wip limit reached");
			}
		}

		if (nextStatus === "done") {
			const blockers = unfinishedBlockers(todo);
			if (blockers.length) {
				return fail(
					"toggle",
					`Todo #${todo.id} cannot be done while blocked by ${blockers.map((b) => `#${b}`).join(", ")}`,
					"unfinished blockers",
				);
			}
			if (hasOpenChildren(todo.id)) {
				return fail("toggle", `Todo #${todo.id} has unfinished children`, "unfinished children");
			}
		}

		if (prev === "done" && nextStatus !== "done") {
			const activeDependents = dependentsOf(todo.id).filter((d) => d.status !== "todo");
			if (activeDependents.length) {
				return fail(
					"toggle",
					`Cannot reopen #${todo.id}; active dependents: ${activeDependents.map((d) => `#${d.id}`).join(", ")}`,
					"active dependents",
				);
			}
		}

		todo.status = nextStatus;
		addHistory(todo, "status_changed", { from: prev, to: nextStatus });
		return ok("toggle", `Todo #${todo.id} moved ${statusLabel(prev)} → ${statusLabel(nextStatus)}`);
	};

	const archiveTodoAction = (id: number, archived?: boolean) => {
		const todo = findTodo(id);
		if (!todo) return fail("archive", `Todo #${id} not found`, `#${id} not found`);
		const nextArchived = archived ?? true;
		if (nextArchived && todo.status !== "done") {
			return fail("archive", "Only done todos can be archived", "archive requires done status");
		}
		todo.archived = nextArchived;
		addHistory(todo, nextArchived ? "archived" : "unarchived");
		return ok("archive", `${nextArchived ? "Archived" : "Unarchived"} todo #${todo.id}`);
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a todo graph. Actions: list, add, update, toggle, read, archive, link, unlink, history, clear, set_wip_limit",
		promptSnippet: "Track multi-step work with a persistent todo graph.",
		promptGuidelines: [
			"Use `todo` only for genuinely multi-step work where progress tracking is useful, such as investigation followed by implementation and verification, changes spanning multiple files with coordination, or tasks with blockers and dependencies.",
			"Do not use `todo` for small or straightforward work, including single-file edits, review-and-commit requests, simple checks or verification runs, quick follow-up fixes, or purely conversational responses.",
			"Before starting complex multi-step work, create or update the relevant todo items so progress stays visible throughout the turn.",
			"Keep in-progress work focused and update todo status promptly when a task starts, pauses, or finishes.",
			"Use parent and blocker links when sequencing matters or one task depends on another.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const actionValidation = validateActionParams(params.action, params as Record<string, unknown>);
			if (actionValidation.ok === false) return actionValidation.result;

			switch (params.action) {
				case "list": {
					const view = params.view ?? "default";
					const includeArchived = params.includeArchived ?? false;
					return ok("list", listText(view, includeArchived, params.status, params.tag));
				}

				case "add": {
					if (!params.title?.trim()) return fail("add", "Error: title required for add", "title required");
					const id = nextId++;
					const parentId = params.parentId;
					const blockerIds: number[] = [...new Set((params.blockerIds ?? []) as number[])];
					const validation = validateParentAndBlockers(id, parentId, blockerIds, "add");
					if (validation.ok === false) return validation.result;

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
					todos.push(todo);
					return ok("add", `Added todo #${todo.id}: ${todo.title}`);
				}

				case "update": {
					if (params.id === undefined) return fail("update", "Error: id required", "id required");
					return updateTodoAction({
						id: params.id,
						title: params.title,
						description: params.description,
						tags: params.tags,
						priority: params.priority,
						effort: params.effort,
						parentId: params.parentId,
						blockerIds: params.blockerIds,
					});
				}

				case "link": {
					if (params.id === undefined) return fail("link", "Error: id required", "id required");
					const todo = findTodo(params.id);
					if (!todo) return fail("link", `Todo #${params.id} not found`, `#${params.id} not found`);

					const nextParentId = params.parentId !== undefined ? params.parentId : todo.parentId;
					const nextBlockers = [...new Set([...(todo.blockerIds ?? []), ...(params.addBlockerIds ?? [])])];
					const validation = validateParentAndBlockers(todo.id, nextParentId, nextBlockers, "link");
					if (validation.ok === false) return validation.result;

					todo.parentId = nextParentId;
					todo.blockerIds = nextBlockers;
					addHistory(todo, "linked", { parentId: params.parentId, addBlockerIds: params.addBlockerIds ?? [] });
					return ok("link", `Updated relationships for todo #${todo.id}`);
				}

				case "unlink": {
					if (params.id === undefined) return fail("unlink", "Error: id required", "id required");
					const todo = findTodo(params.id);
					if (!todo) return fail("unlink", `Todo #${params.id} not found`, `#${params.id} not found`);

					const removeBlockerIds = params.removeBlockerIds ?? [];
					if (!params.clearParent && removeBlockerIds.length === 0) {
						return fail("unlink", "Error: provide clearParent and/or removeBlockerIds", "no unlink operation provided");
					}

					if (params.clearParent) todo.parentId = undefined;
					if (removeBlockerIds.length > 0) {
						const removeSet = new Set(removeBlockerIds);
						todo.blockerIds = todo.blockerIds.filter((id) => !removeSet.has(id));
					}
					addHistory(todo, "unlinked", { clearParent: Boolean(params.clearParent), removeBlockerIds });
					return ok("unlink", `Removed selected relationships from todo #${todo.id}`);
				}

				case "toggle": {
					if (params.id === undefined) return fail("toggle", "Error: id required", "id required");
					return toggleTodoAction(params.id, params.toStatus);
				}

				case "read": {
					if (params.id === undefined) return fail("read", "Error: id required", "id required");
					const todo = findTodo(params.id);
					if (!todo) return fail("read", `Todo #${params.id} not found`, `#${params.id} not found`);

					addHistory(todo, "read");
					return ok("read", readTodoText(todo));
				}

				case "history": {
					const limit = params.historyLimit && params.historyLimit > 0 ? Math.floor(params.historyLimit) : 20;
					if (params.id !== undefined) {
						const todo = findTodo(params.id);
						if (!todo) return fail("history", `Todo #${params.id} not found`, `#${params.id} not found`);
						const lines = todo.history
							.slice(-limit)
							.map((h) => `${h.timestamp} ${h.type}${h.meta ? ` ${JSON.stringify(h.meta)}` : ""}`);
						return ok("history", lines.length ? lines.join("\n") : `No history for #${todo.id}`);
					}

					const all = todos
						.flatMap((t) => t.history.map((h) => ({ ...h, title: t.title })))
						.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
						.slice(-limit)
						.map((h) => `${h.timestamp} #${h.todoId} ${h.type} (${h.title})`);
					return ok("history", all.length ? all.join("\n") : "No history yet");
				}

				case "archive": {
					if (params.id === undefined) return fail("archive", "Error: id required", "id required");
					return archiveTodoAction(params.id, params.archived);
				}

				case "set_wip_limit": {
					if (params.limit === undefined || !Number.isFinite(params.limit) || params.limit < 1) {
						return fail("set_wip_limit", "Error: positive limit required", "invalid limit");
					}
					wipLimit = Math.floor(params.limit);
					return ok("set_wip_limit", `Set WIP limit to ${wipLimit}`);
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					return ok("clear", `Cleared ${count} todos`);
				}
			}
		},

		renderCall(args, theme, _context) {
			const a = args as Record<string, unknown>;
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", String(a.action ?? ""));
			if (typeof a.id === "number") text += " " + theme.fg("accent", `#${a.id}`);
			if (typeof a.title === "string") text += " " + theme.fg("dim", `"${a.title}"`);
			if (a.action === "toggle" && (a.toStatus === "todo" || a.toStatus === "in-progress" || a.toStatus === "done")) {
				text += " " + theme.fg("muted", `→ ${statusLabel(a.toStatus)}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show todos. Usage: /todos [ready] [all] [todo|in-progress|done] [tag:<name>]",
		handler: handleTodosCommand,
	});
}
