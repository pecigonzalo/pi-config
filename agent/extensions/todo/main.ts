/**
 * Todo Extension - Stateful todo graph with dependencies
 *
 * State is persisted in tool result details (not external files), which enables
 * branch-aware reconstruction from session history.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	TodoBrowserComponent,
	type TodoBrowserAction,
	TodoDetailComponent,
	type TodoDetailAction,
	TodoPanelWidgetComponent,
} from "./components";
import { parseTodoWidgetMode, parseTodosCommandArgs, parseTodosCommandRoute } from "./commands";
import { executeTodoAction, findTodo as findTodoInState, resultText as getTodoResultText, type TodoExecuteParams } from "./engine";
import {
	buildTodoBrowserRows,
	buildTodoCommandTitle,
	buildTodoPanelRows,
	statusLabel,
} from "./presenters";
import {
	applyPersistedDetails as applyPersistedTodoDetails,
	createTodoState,
	reconstructTodoSession,
	type TodoState,
} from "./state";
import {
	type TodoDetailField,
	type TodoEffort,
	type TodoItem,
	type TodoPriority,
	TodoParams,
	type TodoResult,
	type TodoStatus,
} from "./types";

function isTodoPriority(value: string): value is TodoPriority {
	return value === "low" || value === "med" || value === "high";
}

function isTodoEffort(value: string): value is TodoEffort {
	return value === "S" || value === "M" || value === "L";
}

function isTodoStatus(value: unknown): value is TodoStatus {
	return value === "todo" || value === "in-progress" || value === "done";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

export default function (pi: ExtensionAPI) {
	const initialState = createTodoState();
	let todos: TodoItem[] = initialState.todos;
	let nextId = initialState.nextId;
	let wipLimit = initialState.wipLimit;
	let widgetVisible = false;
	let requestTodoWidgetRender: (() => void) | undefined;

	const getState = (): TodoState => ({ todos, nextId, wipLimit });
	const setState = (state: TodoState) => {
		todos = state.todos;
		nextId = state.nextId;
		wipLimit = state.wipLimit;
	};
	const runTodoAction = (params: TodoExecuteParams): TodoResult => {
		const outcome = executeTodoAction(getState(), params);
		setState(outcome.state);
		return outcome.result;
	};

	const findTodo = (id: number): TodoItem | undefined => findTodoInState(getState(), id);

	const applyPersistedDetails = (details: unknown) => {
		setState(applyPersistedTodoDetails(getState(), details));
	};

	const reconstructState = (ctx: ExtensionContext) => {
		const reconstructed = reconstructTodoSession(ctx.sessionManager.getBranch());
		setState(reconstructed.state);
		widgetVisible = reconstructed.widgetVisible;
	};

	const installTodoWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!widgetVisible) {
			requestTodoWidgetRender = undefined;
			ctx.ui.setWidget("todo-panel", undefined);
			return;
		}

		ctx.ui.setWidget(
			"todo-panel",
			(tui) => {
				requestTodoWidgetRender = () => tui.requestRender();
				return new TodoPanelWidgetComponent(
					ctx.ui.theme,
					"Todos",
					() => buildTodoPanelRows(getState(), ctx.ui.theme),
					"/todos widget off to hide · /todos to browse",
				);
			},
			{ placement: "belowEditor" },
		);
		requestTodoWidgetRender?.();
	};

	const refreshTodoWidget = () => {
		requestTodoWidgetRender?.();
	};

	const handleTodoWidgetCommand = async (args: string, ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("/todos widget requires interactive mode", "error");
			return;
		}

		const parsed = parseTodoWidgetMode(args);
		if (parsed.error) {
			ctx.ui.notify(parsed.error, "error");
			return;
		}

		if (parsed.mode === "status") {
			ctx.ui.notify(`Todo widget: ${widgetVisible ? "on" : "off"}`, "info");
			return;
		}

		const nextVisible = parsed.mode === "toggle" ? !widgetVisible : parsed.mode === "on";
		if (nextVisible === widgetVisible) {
			ctx.ui.notify(`Todo widget already ${widgetVisible ? "on" : "off"}`, "info");
			return;
		}

		widgetVisible = nextVisible;
		pi.appendEntry("todo-widget-state", { visible: widgetVisible });
		installTodoWidget(ctx);
		ctx.ui.notify(`Todo widget ${widgetVisible ? "enabled" : "disabled"}`, "info");
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
				if (!nextPriority || !isTodoPriority(nextPriority) || nextPriority === todo.priority) return;
				result = updateTodoAction({ id: todo.id, priority: nextPriority });
				break;
			}
			case "effort": {
				const nextEffort = await ctx.ui.select(`Effort for #${todo.id}`, ["S", "M", "L"]);
				if (!nextEffort || !isTodoEffort(nextEffort) || nextEffort === todo.effort) return;
				result = updateTodoAction({ id: todo.id, effort: nextEffort });
				break;
			}
			case "status": {
				const nextStatus = await ctx.ui.select(`Status for #${todo.id}`, ["todo", "in-progress", "done"]);
				if (!isTodoStatus(nextStatus) || nextStatus === todo.status) return;
				result = toggleTodoAction(todo.id, nextStatus);
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

		const route = parseTodosCommandRoute(args);
		if (route.kind === "widget") {
			await handleTodoWidgetCommand(route.widgetArgs, ctx);
			return;
		}

		const { view, includeArchived, status, tag, invalidTokens } = parseTodosCommandArgs(route.listArgs);

		if (invalidTokens.length > 0) {
			const label = invalidTokens.length === 1 ? "token" : "tokens";
			ctx.ui.notify(
				`Unsupported /todos ${label}: ${invalidTokens.join(", ")}. Usage: /todos [ready] [all] [todo|in-progress|done] [tag:<name>] | /todos widget [on|off|toggle|status]`,
				"error",
			);
			return;
		}

		while (true) {
			const title = buildTodoCommandTitle(view, includeArchived, status, tag);
			const action = await ctx.ui.custom<TodoBrowserAction>((_tui, theme, _kb, done) => {
				return new TodoBrowserComponent(buildTodoBrowserRows(getState(), view, includeArchived, status, tag, theme), title, theme, done);
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

	const resultText = getTodoResultText;

	const applyInteractiveResult = (result: TodoResult, ctx: ExtensionContext) => {
		if (result.details.error) {
			ctx.ui.notify(resultText(result), "error");
			return;
		}
		pi.appendEntry("todo-state", result.details);
		refreshTodoWidget();
		ctx.ui.notify(resultText(result), "info");
	};

	const updateTodoAction = (params: {
		id: number;
		title?: string;
		description?: string;
		tags?: string[];
		priority?: TodoPriority;
		effort?: TodoEffort;
		parentId?: number;
		blockerIds?: number[];
	}) => runTodoAction({ action: "update", ...params });

	const toggleTodoAction = (id: number, toStatus?: TodoStatus) => runTodoAction({ action: "toggle", id, toStatus });

	const archiveTodoAction = (id: number, archived?: boolean) => runTodoAction({ action: "archive", id, archived });

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		installTodoWidget(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		installTodoWidget(ctx);
	});
	pi.on("tool_result", async (event, _ctx) => {
		if (!isRecord(event) || event.toolName !== "todo") return;
		applyPersistedDetails(event.details);
		refreshTodoWidget();
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		requestTodoWidgetRender = undefined;
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("todo-panel", undefined);
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a todo graph. Actions: list, add, update, toggle, read, archive, link, unlink, history, clear, set_wip_limit",
		promptSnippet: "Track multi-step work with a persistent todo graph.",
		promptGuidelines: [
			"Use the `todo` tool only for genuinely multi-step work where progress tracking is useful, such as investigation followed by implementation and verification, changes spanning multiple files with coordination, or tasks with blockers and dependencies.",
			"Do not use the `todo` tool for small or straightforward work, including single-file edits, review-and-commit requests, simple checks or verification runs, quick follow-up fixes, or purely conversational responses.",
			"Before starting complex multi-step work, use the `todo` tool to create or update the relevant todo items so progress stays visible throughout the turn.",
			"Keep `todo` tool work focused and use the `todo` tool to update status promptly when a task starts, pauses, or finishes.",
			"Use the `todo` tool parent and blocker links when sequencing matters or one task depends on another.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			return runTodoAction(params as TodoExecuteParams);
		},

		renderCall(args, theme, _context) {
			const callArgs: Record<string, unknown> = isRecord(args) ? args : {};
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", String(callArgs.action ?? ""));
			if (typeof callArgs.id === "number") text += " " + theme.fg("accent", `#${callArgs.id}`);
			if (typeof callArgs.title === "string") text += " " + theme.fg("dim", `"${callArgs.title}"`);
			if (callArgs.action === "toggle" && isTodoStatus(callArgs.toStatus)) {
				text += " " + theme.fg("muted", `→ ${statusLabel(callArgs.toStatus)}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme, _context) {
			const details = isRecord(result.details) ? result.details : undefined;
			if (typeof details?.error === "string") return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show todos or manage widget. Usage: /todos [ready] [all] [todo|in-progress|done] [tag:<name>] | /todos widget [on|off|toggle|status]",
		handler: handleTodosCommand,
	});
}
