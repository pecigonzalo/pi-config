/**
 * Todo Extension - Stateful todo graph with dependencies
 *
 * State is persisted in tool result details (not external files), which enables
 * branch-aware reconstruction from session history.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

type TodoStatus = "todo" | "in_progress" | "done";
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
	toStatus: Type.Optional(StringEnum(["todo", "in_progress", "done"] as const)),
	view: Type.Optional(StringEnum(["default", "tree", "ready"] as const)),
	includeArchived: Type.Optional(Type.Boolean()),
	status: Type.Optional(StringEnum(["todo", "in_progress", "done"] as const)),
	tag: Type.Optional(Type.String()),
	archived: Type.Optional(Type.Boolean({ description: "Archive (true) or unarchive (false)" })),
	limit: Type.Optional(Type.Number({ description: "WIP limit for in_progress todos" })),
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
			raw.status === "todo" || raw.status === "in_progress" || raw.status === "done"
				? raw.status
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
				? [...new Set(raw.blockerIds.filter((x: unknown) => typeof x === "number"))]
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

	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;
		wipLimit = 2;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as Partial<TodoDetails> | undefined;
			if (!details || !Array.isArray(details.todos)) continue;

			todos = details.todos.map((t) => normalizeTodo(t)).filter((t): t is TodoItem => t !== null);
			nextId = typeof details.nextId === "number" ? details.nextId : Math.max(0, ...todos.map((t) => t.id)) + 1;
			wipLimit = typeof details.wipLimit === "number" && details.wipLimit > 0 ? Math.floor(details.wipLimit) : 2;
		}
	};

	const inProgressCount = () => todos.filter((t) => !t.archived && t.status === "in_progress").length;

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
		if (from === "todo" && to === "in_progress") return true;
		if (from === "in_progress" && to === "done") return true;
		if (from === "in_progress" && to === "todo") return true;
		if (from === "done" && to === "todo") return true;
		return false;
	};

	const cycleStatus = (status: TodoStatus): TodoStatus => {
		switch (status) {
			case "todo":
				return "in_progress";
			case "in_progress":
				return "done";
			case "done":
				return "todo";
		}
	};

	const statusLabel = (s: TodoStatus) => (s === "in_progress" ? "in progress" : s);
	const byId = (a: TodoItem, b: TodoItem) => a.id - b.id;

	const summaryLine = (t: TodoItem): string => {
		const statusIcon = t.status === "done" ? "✓" : t.status === "in_progress" ? "▶" : "○";
		const tags = t.tags.length ? ` [${t.tags.join(",")}]` : "";
		const archived = t.archived ? " (archived)" : "";
		return `[${statusIcon}] #${t.id} ${t.title}${tags} (${t.priority}/${t.effort})${archived}`;
	};

	const relationshipLines = (t: TodoItem, showParent = true): string[] => {
		const lines: string[] = [];
		if (showParent && t.parentId !== undefined) lines.push(`↳ parent: #${t.parentId}`);
		const blockers = unfinishedBlockers(t);
		if (blockers.length) lines.push(`↳ blocked by: ${blockers.map((id) => `#${id}`).join(", ")}`);
		return lines;
	};

	const renderFlatTodo = (t: TodoItem, indent = "  ", showParent = true): string[] => [
		`${indent}${summaryLine(t)}`,
		...relationshipLines(t, showParent).map((line) => `${indent}  ${line}`),
	];

	const listText = (
		view: "default" | "tree" | "ready",
		includeArchived: boolean,
		status?: TodoStatus,
		tag?: string,
	): string => {
		let pool = todos.filter((t) => includeArchived || !t.archived);
		if (status) pool = pool.filter((t) => t.status === status);
		if (tag) pool = pool.filter((t) => t.tags.includes(tag));
		pool = [...pool].sort(byId);

		if (view === "ready") {
			const ready = pool.filter((t) => t.status === "todo" && !hasUnfinishedBlockers(t));
			return ready.length ? ready.flatMap((t) => renderFlatTodo(t)).join("\n") : "No ready todos";
		}

		if (view === "tree") {
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
				lines.push(prefix + summaryLine(item));
				for (const line of relationshipLines(item, showParent)) lines.push(childPrefix + line);
				const children = childMap.get(item.id) ?? [];
				children.forEach((child, index) => {
					const last = index === children.length - 1;
					walk(child, `${childPrefix}${last ? "└─ " : "├─ "}`, `${childPrefix}${last ? "   " : "│  "}`, false);
				});
			};
			for (const root of roots) walk(root, "", "  ", root.parentId !== undefined && !idSet.has(root.parentId));
			return lines.length ? lines.join("\n") : "No todos";
		}

		const groups: Record<TodoStatus, TodoItem[]> = {
			todo: pool.filter((t) => t.status === "todo"),
			in_progress: pool.filter((t) => t.status === "in_progress"),
			done: pool.filter((t) => t.status === "done"),
		};
		const lines: string[] = [];
		for (const key of ["todo", "in_progress", "done"] as const) {
			if (groups[key].length === 0) continue;
			if (lines.length > 0) lines.push("");
			lines.push(`${statusLabel(key).toUpperCase()} (${groups[key].length})`);
			for (const t of groups[key]) lines.push(...renderFlatTodo(t));
		}
		return lines.length ? lines.join("\n") : "No todos";
	};

	const snapshot = (action: TodoAction, error?: string): TodoDetails => ({
		action,
		todos: cloneTodos(todos),
		nextId,
		wipLimit,
		error,
	});

	const ok = (action: TodoAction, text: string) => ({
		content: [{ type: "text" as const, text }],
		details: snapshot(action),
	});

	const fail = (action: TodoAction, text: string, error: string) => ({
		content: [{ type: "text" as const, text }],
		details: snapshot(action, error),
	});

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

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a todo graph. Actions: list, add, update, toggle, read, archive, link, unlink, history, clear, set_wip_limit",
		promptSnippet: "Track multi-step work with a persistent todo graph.",
		promptGuidelines: [
			"Use `todo` for non-trivial requests with multiple meaningful steps, multiple files, or investigation followed by implementation and verification.",
			"Create or update todos before substantive work so progress stays visible throughout the turn.",
			"Keep in-progress work focused and update todo status promptly when a task starts, pauses, or finishes.",
			"Use parent and blocker links when sequencing matters or one task depends on another.",
			"Skip `todo` for trivial single-step requests or purely conversational answers.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
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
					const blockerIds = [...new Set(params.blockerIds ?? [])];
					const validation = validateParentAndBlockers(id, parentId, blockerIds, "add");
					if (!validation.ok) return validation.result;

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
					const todo = findTodo(params.id);
					if (!todo) return fail("update", `Todo #${params.id} not found`, `#${params.id} not found`);

					const nextParentId = params.parentId !== undefined ? params.parentId : todo.parentId;
					const nextBlockers = params.blockerIds !== undefined ? [...new Set(params.blockerIds)] : [...todo.blockerIds];
					const validation = validateParentAndBlockers(todo.id, nextParentId, nextBlockers, "update");
					if (!validation.ok) return validation.result;

					if (params.title !== undefined) todo.title = params.title;
					if (params.description !== undefined) todo.description = params.description;
					if (params.tags !== undefined) todo.tags = params.tags;
					if (params.priority !== undefined) todo.priority = params.priority;
					if (params.effort !== undefined) todo.effort = params.effort;
					if (params.parentId !== undefined) todo.parentId = params.parentId;
					if (params.blockerIds !== undefined) todo.blockerIds = nextBlockers;

					addHistory(todo, "updated", {
						title: params.title,
						tags: params.tags,
						priority: params.priority,
						effort: params.effort,
						parentId: params.parentId,
						blockerIds: params.blockerIds,
					});
					return ok("update", `Updated todo #${todo.id}`);
				}

				case "link": {
					if (params.id === undefined) return fail("link", "Error: id required", "id required");
					const todo = findTodo(params.id);
					if (!todo) return fail("link", `Todo #${params.id} not found`, `#${params.id} not found`);

					const nextParentId = params.parentId !== undefined ? params.parentId : todo.parentId;
					const nextBlockers = [...new Set([...(todo.blockerIds ?? []), ...(params.addBlockerIds ?? [])])];
					const validation = validateParentAndBlockers(todo.id, nextParentId, nextBlockers, "link");
					if (!validation.ok) return validation.result;

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
					const todo = findTodo(params.id);
					if (!todo) return fail("toggle", `Todo #${params.id} not found`, `#${params.id} not found`);
					if (todo.archived) return fail("toggle", `Todo #${todo.id} is archived`, "cannot toggle archived todo");

					const prev = todo.status;
					const nextStatus = params.toStatus ?? cycleStatus(prev);

					if (!isAllowedTransition(prev, nextStatus)) {
						return fail("toggle", `Invalid transition: ${statusLabel(prev)} → ${statusLabel(nextStatus)}`, "invalid transition");
					}
					if (prev === nextStatus) return ok("toggle", `Todo #${todo.id} already ${statusLabel(nextStatus)}`);

					if (nextStatus === "in_progress") {
						const blockers = unfinishedBlockers(todo);
						if (blockers.length) {
							return fail("toggle", `Todo #${todo.id} is blocked by ${blockers.map((b) => `#${b}`).join(", ")}`, "unfinished blockers");
						}
						if (prev !== "in_progress" && inProgressCount() >= wipLimit) {
							return fail("toggle", `WIP limit reached (${wipLimit}). Finish or pause another in-progress todo first.`, "wip limit reached");
						}
					}

					if (nextStatus === "done") {
						const blockers = unfinishedBlockers(todo);
						if (blockers.length) {
							return fail("toggle", `Todo #${todo.id} cannot be done while blocked by ${blockers.map((b) => `#${b}`).join(", ")}`, "unfinished blockers");
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
				}

				case "read": {
					if (params.id === undefined) return fail("read", "Error: id required", "id required");
					const todo = findTodo(params.id);
					if (!todo) return fail("read", `Todo #${params.id} not found`, `#${params.id} not found`);

					addHistory(todo, "read");
					const text = [
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
					return ok("read", text);
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
					const todo = findTodo(params.id);
					if (!todo) return fail("archive", `Todo #${params.id} not found`, `#${params.id} not found`);
					const nextArchived = params.archived ?? true;
					if (nextArchived && todo.status !== "done") {
						return fail("archive", "Only done todos can be archived", "archive requires done status");
					}
					todo.archived = nextArchived;
					addHistory(todo, nextArchived ? "archived" : "unarchived");
					return ok("archive", `${nextArchived ? "Archived" : "Unarchived"} todo #${todo.id}`);
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
			if (typeof a.toStatus === "string") text += " " + theme.fg("muted", `→ ${String(a.toStatus)}`);
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
		description: "Show todos. Usage: /todos [default|tree|ready] [all] [todo|in_progress|done] [tag:<name>]",
		handler: async (args, ctx) => {
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

			for (const token of tokens) {
				if (token === "default" || token === "tree" || token === "ready") view = token;
				else if (token === "all") includeArchived = true;
				else if (token === "todo" || token === "in_progress" || token === "done") status = token;
				else if (token.startsWith("tag:")) tag = token.slice(4);
			}

			const text = listText(view, includeArchived, status, tag);
			const lines = text === "No todos" ? [] : text.split("\n");
			const title = `Todos • ${view}${includeArchived ? " • all" : ""}${status ? ` • ${status}` : ""}${tag ? ` • tag:${tag}` : ""}`;

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new TodoListComponent(lines, title, theme, () => done()));
		},
	});
}
