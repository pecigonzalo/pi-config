import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

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
};

export const TodoParams = Type.Object({
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

export type TodoView = "default" | "tree" | "ready";

export type TodoDetailField = "title" | "description" | "status" | "priority" | "effort" | "tags";
