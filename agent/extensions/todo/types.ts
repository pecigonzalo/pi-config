import { StringEnum, type JsonValue } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export type TodoStatus = "todo" | "in-progress" | "done";
export type TodoPriority = "low" | "med" | "high";
export type TodoEffort = "S" | "M" | "L";

export type TodoAction =
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

export type TodoEventType =
	| "created"
	| "updated"
	| "status_changed"
	| "archived"
	| "unarchived"
	| "linked"
	| "unlinked"
	| "read"
	| "cleared";

export type TodoEventMetaValue = string | number | boolean | null | TodoEventMeta | TodoEventMetaValue[];

export interface TodoEventMeta {
	[key: string]: TodoEventMetaValue | undefined;
}

export interface TodoEvent {
	timestamp: string;
	type: TodoEventType;
	todoId: number;
	meta?: TodoEventMeta;
}

export interface TodoItem {
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

export interface TodoDetails {
	action: TodoAction;
	todos: TodoItem[];
	nextId: number;
	wipLimit: number;
	error?: string;
}

export type TodoResult = {
	content: [{ type: "text"; text: string }];
	details: TodoDetails;
	structuredContent?: JsonValue;
	isError?: boolean;
};

export const TodoMutationParams = Type.Object(
	{
		action: StringEnum(
			["add", "update", "toggle", "archive", "link", "unlink", "clear", "set_wip_limit"] as const,
			{
				description:
					"Mutation to perform. Each action has a strict parameter set; omit fields that are not listed for the selected action.",
			},
		),
		id: Type.Optional(
			Type.Number({ description: "Todo ID. Required for update, toggle, archive, link, and unlink." }),
		),
		title: Type.Optional(Type.String({ description: "Short title. Required for add; optional for update." })),
		description: Type.Optional(Type.String({ description: "Long description. Use with add or update." })),
		tags: Type.Optional(Type.Array(Type.String(), { description: "Tags. Use with add or update." })),
		priority: Type.Optional(
			StringEnum(["low", "med", "high"] as const, {
				description: "Priority. Use only with add or update, not toggle.",
			}),
		),
		effort: Type.Optional(
			StringEnum(["S", "M", "L"] as const, {
				description: "Estimated effort. Use only with add or update, not toggle.",
			}),
		),
		parentId: Type.Optional(Type.Number({ description: "Parent todo ID. Use with add, update, or link." })),
		blockerIds: Type.Optional(
			Type.Array(Type.Number(), { description: "Blocking todo IDs to replace. Use with add or update." }),
		),
		addBlockerIds: Type.Optional(
			Type.Array(Type.Number(), { description: "Blocking todo IDs to add. Use only with link." }),
		),
		removeBlockerIds: Type.Optional(
			Type.Array(Type.Number(), { description: "Blocking todo IDs to remove. Use only with unlink." }),
		),
		clearParent: Type.Optional(
			Type.Boolean({ description: "Clear the parent relationship. Use only with unlink." }),
		),
		toStatus: Type.Optional(
			StringEnum(["todo", "in-progress", "done"] as const, {
				description: "Target status for toggle. Do not use with update, add, or any other action.",
			}),
		),
		archived: Type.Optional(
			Type.Boolean({ description: "Archive (true) or unarchive (false). Use only with archive." }),
		),
		limit: Type.Optional(Type.Number({ description: "Positive WIP limit. Use only with set_wip_limit." })),
	},
	{
		description:
			"Manage a persistent todo graph. Mutations only; use todo_query to list, read, or inspect history. The action determines which parameters are valid.",
	},
);

export const TodoQueryParams = Type.Object(
	{
		action: StringEnum(["list", "read", "history"] as const, {
			description: "Read-only action: list, read, or history.",
		}),
		id: Type.Optional(Type.Number({ description: "Todo ID. Required for read; optional for history." })),
		view: Type.Optional(
			StringEnum(["default", "tree", "ready"] as const, { description: "List view. Use only with list." }),
		),
		includeArchived: Type.Optional(Type.Boolean({ description: "Include archived todos. Use only with list." })),
		status: Type.Optional(
			StringEnum(["todo", "in-progress", "done"] as const, { description: "Status filter. Use only with list." }),
		),
		tag: Type.Optional(Type.String({ description: "Tag filter. Use only with list." })),
		historyLimit: Type.Optional(Type.Number({ description: "Maximum history entries. Use only with history." })),
	},
	{
		description: "Read the persistent todo graph without modifying it.",
	},
);

const TodoHistoryEntrySchema = Type.Object({
	timestamp: Type.String(),
	type: StringEnum([
		"created",
		"updated",
		"status_changed",
		"archived",
		"unarchived",
		"linked",
		"unlinked",
		"read",
		"cleared",
	] as const),
	todoId: Type.Number(),
	meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const TodoItemSchema = Type.Object({
	id: Type.Number(),
	title: Type.String(),
	description: Type.Optional(Type.String()),
	status: StringEnum(["todo", "in-progress", "done"] as const),
	tags: Type.Array(Type.String()),
	priority: StringEnum(["low", "med", "high"] as const),
	effort: StringEnum(["S", "M", "L"] as const),
	parentId: Type.Optional(Type.Number()),
	blockerIds: Type.Array(Type.Number()),
	archived: Type.Boolean(),
	history: Type.Array(TodoHistoryEntrySchema),
	createdAt: Type.String(),
	updatedAt: Type.String(),
});

/** Structured shape returned to programmatic callers such as codemode scripts. */
export const TodoDetailsSchema = Type.Object({
	action: StringEnum([
		"list",
		"add",
		"update",
		"toggle",
		"read",
		"archive",
		"link",
		"unlink",
		"history",
		"clear",
		"set_wip_limit",
	] as const),
	todos: Type.Array(TodoItemSchema),
	nextId: Type.Number(),
	wipLimit: Type.Number(),
	error: Type.Optional(Type.String()),
});

export type TodoView = "default" | "tree" | "ready";

export type TodoDetailField = "title" | "description" | "status" | "priority" | "effort" | "tags";
