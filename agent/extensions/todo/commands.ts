import type { TodoStatus, TodoView } from "./types";

export type ParsedTodosRoute =
	| { kind: "list"; listArgs: string }
	| { kind: "widget"; widgetArgs: string };

export function parseTodosCommandRoute(args: string): ParsedTodosRoute {
	const trimmed = args.trim();
	if (!trimmed) return { kind: "list", listArgs: "" };
	const [head = "", ...rest] = trimmed.split(/\s+/);
	if (head.toLowerCase() === "widget") {
		return { kind: "widget", widgetArgs: rest.join(" ") };
	}
	return { kind: "list", listArgs: trimmed };
}

export interface ParsedTodosCommand {
	view: TodoView;
	includeArchived: boolean;
	status?: TodoStatus;
	tag?: string;
	invalidTokens: string[];
}

export function parseTodosCommandArgs(args: string): ParsedTodosCommand {
	const tokens = args
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((token) => token.toLowerCase());

	let view: TodoView = "default";
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

	return {
		view,
		includeArchived,
		status,
		tag,
		invalidTokens,
	};
}

export type TodoWidgetMode = "toggle" | "on" | "off" | "status";

export function parseTodoWidgetMode(rawArgs: string): { mode?: TodoWidgetMode; error?: string } {
	const value = rawArgs.trim().toLowerCase();
	if (!value || value === "toggle") return { mode: "toggle" };
	if (value === "on" || value === "show") return { mode: "on" };
	if (value === "off" || value === "hide") return { mode: "off" };
	if (value === "status") return { mode: "status" };
	return { error: `Unsupported mode: ${value}. Use on|off|toggle|status.` };
}
