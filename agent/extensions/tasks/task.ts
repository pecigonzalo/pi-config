/**
 * Task Tool - Delegate work to specialized agents
 *
 * Spawns a separate `pi` process for each delegated task,
 * with fresh/fork child-session context and optional persisted sessions.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from delegated agents.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	type ExtensionAPI,
	type SessionEntry,
	SessionManager,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { MAIN_SESSION_AGENT_CUSTOM_TYPE } from "../agent-state";
import {
	type AgentConfig,
	type AgentScope,
	type ContextMode,
	type EffortConfig,
	type ProfileConfig,
	type ResourceDiscoveryResult,
	discoverResources,
	resolveSkillPaths,
} from "./agents.js";
import { parseTasksCommand, resolveTaskSelector, type TasksScope } from "./task-command-utils.js";
import {
	applyTaskTerminalAttachment,
	formatTaskTerminalAttachment,
	getTaskAttachActionLabel,
	getTaskTerminalAttachment,
	parseTaskTerminalBackendPreference,
	resolveConfiguredTaskTerminalBackend,
	resolveTaskTerminalBackendById,
	type TaskTerminalAttachment,
} from "./task-terminal.js";
import {
	extractMessagePreviewText,
	formatTimestampCompact,
	getSnapshotEventTimestamp,
	getTaskOriginNavigationTarget,
	makeTaskRunStepKey,
	normalizeChildSessionSnapshot,
	reconstructCurrentTaskRuns,
	resolveTaskOriginForBranch,
	resolveTaskRunOriginSnapshot,
	toMillis,
	type ChildSessionSnapshot,
	type ChildSessionStatus,
	type TaskExecutionMode,
	type TaskOriginSnapshot,
	type TaskRunStatus,
	type TaskRunStepStatus,
	type TaskRunStepView,
	type TaskRunView,
} from "./task-runs.js";
import {
	clearLiveTaskControllers,
	deleteLiveTaskController,
	getLiveTaskController,
	listLiveTaskControllers,
	readLiveTaskRuntimeInfo,
	rejectPendingRpcResponses,
	sendLiveTaskRpcCommand,
	setLiveTaskController,
	type LiveTaskController,
	type LiveTaskRuntimeInfo,
	type RpcResponseEnvelope,
} from "./task-live.js";
import {
	TaskViewerOverlay,
	type TaskTranscriptPreview,
	type TaskViewerOverlayResult,
	type TaskViewerOverlayState,
} from "./task-viewer.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const TASK_SESSION_VERSION_FALLBACK = 3;
const TASK_CHILD_SESSION_CUSTOM_TYPE = "tasks.child-session";
const TASK_CHILD_SESSION_METADATA_VERSION = 1;
const TASKS_PARENT_SESSION_ROOT = path.join(getAgentDir(), "sessions");
const TASKS_CHILD_SESSION_RUNS_DIR = "task-runs";
const TASKS_CHILD_SESSION_FALLBACK_PARENT = "detached";
const TASKS_NO_CURRENT_RUNS_MESSAGE = "No task runs in current session.";
const TASKS_COMMAND_USAGE = [
	"/tasks",
	"/tasks list",
	"/tasks toggle",
	"/tasks parent",
	"/tasks show <selector>",
	"/tasks open <selector>",
	"/tasks attach <selector>",
	"/tasks view <selector>",
	"/tasks origin <selector>",
	"/tasks steer <selector> <message>",
].join(" | ");

const taskWidgetEnabledSessions = new Set<string>();

// Recursion depth guard
const DEFAULT_MAX_SUBAGENT_DEPTH = 2;

function checkSubagentDepth(): { blocked: boolean; depth: number; maxDepth: number } {
	const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const maxDepth = Number.isFinite(Number(process.env.PI_SUBAGENT_MAX_DEPTH))
		? Number(process.env.PI_SUBAGENT_MAX_DEPTH)
		: DEFAULT_MAX_SUBAGENT_DEPTH;
	return { blocked: Number.isFinite(depth) && depth >= maxDepth, depth, maxDepth };
}

function getSubagentDepthEnv(): Record<string, string> {
	const current = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const next = Number.isFinite(current) ? current + 1 : 1;
	const max = process.env.PI_SUBAGENT_MAX_DEPTH ?? String(DEFAULT_MAX_SUBAGENT_DEPTH);
	return { PI_SUBAGENT_DEPTH: String(next), PI_SUBAGENT_MAX_DEPTH: max };
}

// Output truncation
const MAX_OUTPUT_BYTES = 200 * 1024; // 200 KB
const MAX_OUTPUT_LINES = 5000;

function truncateOutput(text: string): string {
	const lines = text.split("\n");
	const bytes = Buffer.byteLength(text, "utf-8");
	if (bytes <= MAX_OUTPUT_BYTES && lines.length <= MAX_OUTPUT_LINES) return text;

	let truncated = lines.length > MAX_OUTPUT_LINES ? lines.slice(0, MAX_OUTPUT_LINES) : lines;
	let result = truncated.join("\n");
	if (Buffer.byteLength(result, "utf-8") > MAX_OUTPUT_BYTES) {
		let lo = 0;
		let hi = result.length;
		while (lo < hi) {
			const mid = Math.floor((lo + hi + 1) / 2);
			if (Buffer.byteLength(result.slice(0, mid), "utf-8") <= MAX_OUTPUT_BYTES) lo = mid;
			else hi = mid - 1;
		}
		result = result.slice(0, lo);
	}
	const keptLines = result.split("\n").length;
	const keptBytes = Buffer.byteLength(result, "utf-8");
	return `[TRUNCATED: showing first ${keptLines} of ${lines.length} lines, ${keptBytes} of ${bytes} bytes]\n${result}`;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatTaskExecutionSelection(
	selection: { profile?: string; effort?: string },
	themeFg: (color: any, text: string) => string,
): string {
	const parts: string[] = [];
	if (selection.profile) {
		parts.push(themeFg("muted", "profile: ") + themeFg("accent", selection.profile));
	}
	if (selection.effort) {
		parts.push(themeFg("muted", "effort: ") + themeFg("accent", selection.effort));
	}
	return parts.join(themeFg("muted", " · "));
}

function formatTaskExecutionContext(
	agentSource: string | undefined,
	sessionMode: ContextMode | undefined,
	themeFg: (color: any, text: string) => string,
): string {
	const source = agentSource ?? "unknown";
	const mode = sessionMode ?? "fresh";
	return themeFg("muted", ` (${source}:${mode})`);
}

function formatTaskExecutionMetadata(
	taskResult: { agentSource?: string; sessionMode?: ContextMode; profile?: string; effort?: string },
	themeFg: (color: any, text: string) => string,
): string {
	const context = formatTaskExecutionContext(taskResult.agentSource, taskResult.sessionMode, themeFg);
	const selection = formatTaskExecutionSelection(taskResult, themeFg);
	return selection ? `${context}${themeFg("muted", " · ")}${selection}` : context;
}

function formatTaskHeader(
	options: {
		agent: string;
		taskResult: { agentSource?: string; sessionMode?: ContextMode; profile?: string; effort?: string };
		prefix?: string;
		leadingIcon?: string;
		suffix?: string;
		agentColor?: any;
		boldAgent?: boolean;
	},
	theme: { fg: (color: any, text: string) => string; bold: (text: string) => string },
): string {
	const parts: string[] = [];
	if (options.leadingIcon) parts.push(`${options.leadingIcon} `);
	if (options.prefix) parts.push(options.prefix);
	const agentText = options.boldAgent ? theme.bold(options.agent) : options.agent;
	parts.push(theme.fg(options.agentColor ?? "accent", agentText));
	parts.push(formatTaskExecutionMetadata(options.taskResult, theme.fg.bind(theme)));
	if (options.suffix) parts.push(options.suffix);
	return parts.join("");
}

function formatTaskCallHeading(
	kind: "simple" | "chain" | "parallel",
	theme: { fg: (color: any, text: string) => string; bold: (text: string) => string },
	count?: number,
): string {
	let heading = theme.fg("toolTitle", theme.bold("task ")) + theme.fg("accent", kind);
	if (kind === "chain" && count !== undefined) heading += theme.fg("muted", ` (${count} steps)`);
	if (kind === "parallel" && count !== undefined) heading += theme.fg("muted", ` (${count} tasks)`);
	return heading;
}

function formatTaskSnippetLines(
	tasks: string[],
	themeFg: (color: any, text: string) => string,
	options: { numbered?: boolean; maxItems?: number; maxLength?: number } = {},
): string {
	const maxItems = options.maxItems ?? 3;
	const maxLength = options.maxLength ?? 50;
	let text = "";
	for (let i = 0; i < Math.min(tasks.length, maxItems); i++) {
		const preview = tasks[i].length > maxLength ? `${tasks[i].slice(0, maxLength)}...` : tasks[i];
		const index = options.numbered ? `${themeFg("muted", `${i + 1}.`)} ` : "";
		text += `\n  ${index}${themeFg("dim", preview)}`;
	}
	if (tasks.length > maxItems) text += `\n  ${themeFg("muted", `... +${tasks.length - maxItems} more`)}`;
	return text;
}

function appendTaskOutputSection(
	container: Container,
	displayItems: DisplayItem[],
	finalOutput: string,
	mdTheme: ReturnType<typeof getMarkdownTheme>,
	themeFg: (color: any, text: string) => string,
): void {
	if (displayItems.length === 0 && !finalOutput) {
		container.addChild(new Text(themeFg("muted", "(no output)"), 0, 0));
		return;
	}
	for (const item of displayItems) {
		if (item.type !== "toolCall") continue;
		container.addChild(new Text(themeFg("muted", "→ ") + formatToolCall(item.name, item.args, themeFg), 0, 0));
	}
	if (finalOutput) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
	}
}

function shortenHomePath(filePath: string): string {
	const home = os.homedir();
	return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenHomePath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenHomePath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenHomePath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenHomePath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenHomePath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenHomePath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface TaskStepConfig {
	agent?: string;
	profile?: string;
	effort?: string;
	task: string;
	cwd?: string;
	model?: string;
	skills?: string[];
	prompt?: string;
	context?: ContextMode;
}

interface TaskInlineNotice {
	level: TaskExtensionUiNotifyType;
	lines: string[];
	updatedAt: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	profile?: string;
	effort?: string;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	sessionMode?: ContextMode;
	sessionPersist?: boolean;
	sessionFile?: string;
	childSession?: ChildSessionSnapshot;
	uiNotices?: TaskInlineNotice[];
}

interface TaskDetails {
	mode: TaskExecutionMode;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	sessionRunId?: string;
	sessionRunRoot?: string;
	toolCallId?: string;
	childSessions?: ChildSessionSnapshot[];
}

type TaskExtensionUiNotifyType = "info" | "warning" | "error";
type TaskExtensionUiWidgetPlacement = "aboveEditor" | "belowEditor";

interface TaskExtensionUiRequest {
	type: "extension_ui_request";
	id: string;
	method: string;
	title?: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	timeout?: number;
	notifyType?: TaskExtensionUiNotifyType;
	statusKey?: string;
	statusText?: string;
	widgetKey?: string;
	widgetLines?: string[];
	widgetPlacement?: TaskExtensionUiWidgetPlacement;
	text?: string;
}

interface TaskRpcUiMethods {
	select?: (title: string, options: string[], dialogOptions?: { timeout?: number; signal?: AbortSignal }) => Promise<string | undefined>;
	confirm?: (title: string, message: string, dialogOptions?: { timeout?: number; signal?: AbortSignal }) => Promise<boolean>;
	input?: (title: string, placeholder?: string, dialogOptions?: { timeout?: number; signal?: AbortSignal }) => Promise<string | undefined>;
	editor?: (title: string, prefill?: string, dialogOptions?: { timeout?: number; signal?: AbortSignal }) => Promise<string | undefined>;
	notify?: (message: string, level?: TaskExtensionUiNotifyType) => void;
	setStatus?: (key: string, text?: string) => void;
	setWidget?: (key: string, lines?: string[], options?: { placement?: TaskExtensionUiWidgetPlacement }) => void;
	setTitle?: (title: string) => void;
	setEditorText?: (text: string) => void;
}

interface TaskRpcUiContext {
	hasUI?: boolean;
	ui?: TaskRpcUiMethods;
	sessionManager?: { getSessionFile?: () => string | undefined; getSessionId?: () => string | undefined };
	refreshTaskUiChrome?: () => void;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const textParts = msg.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
				.map((part) => part.text)
				.filter((text) => text.length > 0);
			if (textParts.length > 0) return textParts.join("\n");
		}
	}
	return "";
}

function getTaskResultOutput(result: SingleResult): string {
	const finalOutput = getFinalOutput(result.messages).trim();
	if (finalOutput) return finalOutput;
	const errorMessage = result.errorMessage?.trim();
	if (errorMessage) return errorMessage;
	const stderr = result.stderr.trim();
	if (stderr) return stderr;
	return "";
}

function formatTaskResultSection(result: SingleResult): string {
	const status = result.exitCode === -1 ? "running" : result.exitCode === 0 ? "completed" : "failed";
	const step = result.step !== undefined ? `Step ${result.step}` : "Task";
	const lines = [`### ${step} — ${result.agent} (${status})`];
	if (result.task) lines.push(`Task: ${createTaskPreview(result.task, 240)}`);
	const output = getTaskResultOutput(result);
	lines.push(output ? truncateOutput(output) : "(no output)");
	return lines.join("\n");
}

function formatParallelResults(results: SingleResult[]): string {
	const successCount = results.filter((result) => result.exitCode === 0).length;
	const sections = results.map(formatTaskResultSection);
	return [`Parallel: ${successCount}/${results.length} succeeded`, ...sections].join("\n\n");
}

function formatChainResults(results: SingleResult[]): string {
	if (results.length === 0) return "Chain: 0/0 succeeded";
	const successCount = results.filter((result) => result.exitCode === 0).length;
	const sections = results.map(formatTaskResultSection);
	return [`Chain: ${successCount}/${results.length} succeeded`, ...sections].join("\n\n");
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function createTaskPreview(task: string, maxLength = 120): string {
	const compact = task.replace(/\s+/g, " ").trim();
	if (!compact) return "(empty task)";
	return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function addTaskInlineNotice(result: SingleResult, message: string, level: TaskExtensionUiNotifyType): void {
	const lines = message
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) return;
	const nextNotice: TaskInlineNotice = { level, lines, updatedAt: Date.now() };
	const existing = result.uiNotices ?? [];
	const deduped = existing.filter((notice) => notice.lines.join("\n") !== nextNotice.lines.join("\n") || notice.level !== nextNotice.level);
	result.uiNotices = [...deduped, nextNotice].slice(-5);
}

function buildTaskInlineNoticeLines(notices: TaskInlineNotice[]): string[] {
	const lines: string[] = [];
	for (const notice of notices) {
		const icon = notice.level === "error" ? "✗" : notice.level === "warning" ? "!" : "ℹ";
		const [firstLine, ...rest] = notice.lines;
		if (!firstLine) continue;
		lines.push(`${icon} ${firstLine}`);
		for (const line of rest) lines.push(`  ${line}`);
	}
	return lines;
}

function formatTaskInlineNoticeLines(notices: TaskInlineNotice[], themeFg: (color: any, text: string) => string): string {
	return buildTaskInlineNoticeLines(notices)
		.map((line) => themeFg("muted", line))
		.join("\n");
}

function sanitizeTaskUiKeySegment(value: string | undefined, fallback: string): string {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return fallback;
	const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || fallback;
}

function getTaskUiLabel(controller: Pick<LiveTaskController, "agent" | "step">): string {
	return `Task ${controller.agent}${controller.step > 0 ? ` step ${controller.step}` : ""}`;
}

function getTaskUiPrefix(controller: Pick<LiveTaskController, "agent" | "step">): string {
	return `[${getTaskUiLabel(controller)}]`;
}

function formatTaskExtensionUiTitle(
	controller: Pick<LiveTaskController, "agent" | "step">,
	title: string | undefined,
): string {
	const label = getTaskUiLabel(controller);
	const trimmedTitle = title?.trim();
	return trimmedTitle ? `${label} · ${trimmedTitle}` : label;
}

function getTaskExtensionUiDialogOptions(timeout: unknown, signal: AbortSignal | undefined): { timeout?: number; signal?: AbortSignal } | undefined {
	const timeoutMs = typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : undefined;
	if (timeoutMs === undefined && !signal) return undefined;
	return {
		...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
		...(signal ? { signal } : {}),
	};
}

function isTaskExtensionUiNotifyType(value: unknown): value is TaskExtensionUiNotifyType {
	return value === "info" || value === "warning" || value === "error";
}

function getTaskStatusRelayKey(controller: Pick<LiveTaskController, "key">, statusKey: string | undefined): string {
	return `tasks.rpc.${sanitizeTaskUiKeySegment(controller.key, "task")}.status.${sanitizeTaskUiKeySegment(statusKey, "status")}`;
}

function getTaskWidgetRelayKey(controller: Pick<LiveTaskController, "key">, widgetKey: string | undefined): string {
	return `tasks.rpc.${sanitizeTaskUiKeySegment(controller.key, "task")}.widget.${sanitizeTaskUiKeySegment(widgetKey, "widget")}`;
}

async function relayTaskExtensionUiRequest(options: {
	request: TaskExtensionUiRequest;
	controller: Pick<LiveTaskController, "agent" | "step" | "key">;
	parentUi?: TaskRpcUiContext;
	dialogSignal?: AbortSignal;
	sendResponse: (payload: Record<string, unknown>) => Promise<void>;
	trackedStatusKeys?: Set<string>;
	trackedWidgetKeys?: Set<string>;
}): Promise<void> {
	const { request, controller, parentUi, dialogSignal, sendResponse, trackedStatusKeys, trackedWidgetKeys } = options;
	const hasParentUi = parentUi?.hasUI === true && parentUi.ui;
	const ui = parentUi?.ui;
	const title = formatTaskExtensionUiTitle(controller, request.title);
	const prefix = getTaskUiPrefix(controller);
	const dialogOptions = getTaskExtensionUiDialogOptions(request.timeout, dialogSignal);

	switch (request.method) {
		case "select": {
			if (!hasParentUi || typeof ui?.select !== "function") {
				await sendResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
				return;
			}
			const relayOptions = Array.isArray(request.options) ? request.options.filter((value): value is string => typeof value === "string") : [];
			const value = await ui.select(title, relayOptions, dialogOptions);
			await sendResponse(
				value !== undefined
					? { type: "extension_ui_response", id: request.id, value }
					: { type: "extension_ui_response", id: request.id, cancelled: true },
			);
			return;
		}
		case "confirm": {
			if (!hasParentUi || typeof ui?.confirm !== "function") {
				await sendResponse({ type: "extension_ui_response", id: request.id, confirmed: false });
				return;
			}
			const confirmed = await ui.confirm(title, typeof request.message === "string" ? request.message : "", dialogOptions);
			await sendResponse({ type: "extension_ui_response", id: request.id, confirmed });
			return;
		}
		case "input": {
			if (!hasParentUi || typeof ui?.input !== "function") {
				await sendResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
				return;
			}
			const value = await ui.input(title, request.placeholder, dialogOptions);
			await sendResponse(
				value !== undefined
					? { type: "extension_ui_response", id: request.id, value }
					: { type: "extension_ui_response", id: request.id, cancelled: true },
			);
			return;
		}
		case "editor": {
			if (!hasParentUi || typeof ui?.editor !== "function") {
				await sendResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
				return;
			}
			const value = await ui.editor(title, request.prefill, dialogOptions);
			await sendResponse(
				value !== undefined
					? { type: "extension_ui_response", id: request.id, value }
					: { type: "extension_ui_response", id: request.id, cancelled: true },
			);
			return;
		}
		case "notify": {
			return;
		}
		case "setStatus": {
			if (hasParentUi && typeof ui?.setStatus === "function") {
				const relayKey = getTaskStatusRelayKey(controller, request.statusKey);
				trackedStatusKeys?.add(relayKey);
				const statusText = typeof request.statusText === "string" && request.statusText.trim().length > 0
					? `${prefix} ${request.statusText}`
					: undefined;
				ui.setStatus(relayKey, statusText);
			}
			return;
		}
		case "setWidget": {
			if (hasParentUi && typeof ui?.setWidget === "function") {
				const relayKey = getTaskWidgetRelayKey(controller, request.widgetKey);
				trackedWidgetKeys?.add(relayKey);
				const widgetLines = Array.isArray(request.widgetLines)
					? request.widgetLines.filter((value): value is string => typeof value === "string")
					: undefined;
				const placement = request.widgetPlacement === "belowEditor" ? { placement: "belowEditor" as const } : undefined;
				ui.setWidget(
					relayKey,
					widgetLines && widgetLines.length > 0 ? widgetLines.map((line, index) => (index === 0 ? `${prefix} ${line}` : line)) : undefined,
					placement,
				);
			}
			return;
		}
		case "setTitle":
		case "set_editor_text": {
			return;
		}
		default: {
			await sendResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
		}
	}
}

function resolveChildSessionTerminalStatus(result: SingleResult): Exclude<ChildSessionStatus, "created"> {
	if (result.stopReason === "aborted") return "aborted";
	if (result.exitCode === 0 && result.stopReason !== "error") return "succeeded";
	return "failed";
}

function formatChildSessionStatus(
	status: ChildSessionStatus,
	themeFg: (color: any, text: string) => string,
): string {
	switch (status) {
		case "created":
			return themeFg("warning", status);
		case "succeeded":
			return themeFg("success", status);
		case "aborted":
			return themeFg("warning", status);
		default:
			return themeFg("error", status);
	}
}

function formatChildSessionCompact(snapshot: ChildSessionSnapshot, themeFg: (color: any, text: string) => string): string {
	const shortId = snapshot.childSessionId.slice(0, 8);
	return [
		themeFg("muted", "session: "),
		themeFg("accent", shortId),
		themeFg("muted", " · "),
		formatChildSessionStatus(snapshot.status, themeFg),
	].join("");
}

function formatChildSessionExpanded(snapshot: ChildSessionSnapshot, themeFg: (color: any, text: string) => string): string {
	const shortId = snapshot.childSessionId.slice(0, 8);
	const parts = [
		themeFg("muted", "session: "),
		themeFg("accent", shortId),
		themeFg("muted", " · "),
		formatChildSessionStatus(snapshot.status, themeFg),
		themeFg("muted", " · "),
		themeFg("dim", snapshot.effectiveContext),
		themeFg("muted", " · "),
		themeFg("dim", shortenHomePath(snapshot.childSessionPath)),
	];
	return parts.join("");
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-task-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function normalizeLegacyModelName(model: string | undefined): string | undefined {
	if (!model || model.includes("/")) return model;
	return model.replace(/(\d)-(\d)(?=(?:\D|$))/g, "$1.$2");
}

type OnUpdateCallback = (partial: AgentToolResult<TaskDetails>) => void;

interface ResolvedWorkerConfig {
	agent?: AgentConfig;
	profile?: ProfileConfig;
	effort?: EffortConfig;
	model?: string;
	skills?: string[];
	tools?: string[];
	context: {
		mode: ContextMode;
		project: boolean;
		skills: boolean;
	};
	persist: boolean;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	systemPrompt: string;
	systemPromptMode: "append" | "replace";
	displayAgentName: string;
}

function isTaskCallableAgent(agent: AgentConfig): boolean {
	return agent.enabled && (agent.availability === "task" || agent.availability === "both");
}

function getTaskCallableAgents(resources: ResourceDiscoveryResult): AgentConfig[] {
	return resources.agents.filter(isTaskCallableAgent);
}

function formatCallableAgentList(resources: ResourceDiscoveryResult): string {
	return getTaskCallableAgents(resources)
		.map((a) => `${a.name} (${a.source})`)
		.join(", ") || "none";
}

function formatProfileList(resources: ResourceDiscoveryResult): string {
	return resources.profiles.filter((profile) => profile.enabled).map((profile) => `${profile.name} (${profile.source})`).join(", ") || "none";
}

function formatEffortList(resources: ResourceDiscoveryResult): string {
	return resources.efforts.map((effort) => `${effort.name} (${effort.source})`).join(", ") || "none";
}

function composePromptLayers(...layers: string[]): string {
	const trimmed = layers.map((layer) => layer.trim()).filter(Boolean);
	return trimmed.join("\n\n---\n\n");
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
	for (const value of values) {
		if (value !== undefined) return value;
	}
	return undefined;
}

function buildEffortModelSpec(effort: EffortConfig): { model?: string; error?: string } {
	const normalizedModel = normalizeLegacyModelName(effort.model)?.trim();
	if (!normalizedModel) {
		return { error: `Effort "${effort.name}" has no model configured.` };
	}

	const slashIndex = normalizedModel.indexOf("/");
	if (slashIndex !== -1) {
		const modelProvider = normalizedModel.slice(0, slashIndex).trim();
		const modelId = normalizedModel.slice(slashIndex + 1).trim();
		if (!modelProvider || !modelId) {
			return { error: `Effort "${effort.name}" has an invalid model spec: "${effort.model}".` };
		}
		if (effort.provider && effort.provider !== modelProvider) {
			return {
				error: `Effort "${effort.name}" has provider "${effort.provider}" but model "${effort.model}" is qualified for provider "${modelProvider}".`,
			};
		}
		return { model: `${modelProvider}/${modelId}` };
	}

	if (effort.provider) {
		return { model: `${effort.provider}/${normalizedModel}` };
	}

	return { model: normalizedModel };
}

function resolveModelFromEffort(
	model: string | undefined,
	effortName: string | undefined,
	resources: ResourceDiscoveryResult,
): { model?: string; effort?: EffortConfig; error?: string } {
	if (model) return { model: normalizeLegacyModelName(model) };
	if (!effortName) return {};
	const effort = resources.efforts.find((candidate) => candidate.name === effortName);
	if (!effort) {
		return {
			error: `Unknown effort: "${effortName}". Available efforts: ${formatEffortList(resources)}.`,
		};
	}
	const resolvedModel = buildEffortModelSpec(effort);
	if (resolvedModel.error) return { error: resolvedModel.error };
	return { model: resolvedModel.model, effort };
}

function resolveWorkerConfig(
	step: TaskStepConfig,
	resources: ResourceDiscoveryResult,
	options: { requireBehavior?: boolean; context?: "task" | "main" } = {},
): { config?: ResolvedWorkerConfig; error?: string } {
	const context = options.context ?? "task";
	const agent = step.agent ? resources.agents.find((candidate) => candidate.name === step.agent) : undefined;
	if (step.agent) {
		if (!agent) {
			return {
				error:
					context === "main"
						? `Unknown agent: "${step.agent}". Available main-session agents: ${formatMainSessionAgentList(resources.agents)}.`
						: `Unknown agent: "${step.agent}". Available task agents: ${formatCallableAgentList(resources)}.`,
			};
		}
		if (!agent.enabled) return { error: `Agent "${step.agent}" is disabled.` };
		if (context === "task" && agent.availability === "main") {
			return { error: `Agent "${step.agent}" is not task-callable (availability: main).` };
		}
		if (context === "main" && agent.availability === "task") {
			return { error: `Agent "${step.agent}" is not main-session callable (availability: task).` };
		}
	}

	const profileName = step.profile ?? agent?.defaultProfile;
	const profile = profileName ? resources.profiles.find((candidate) => candidate.name === profileName) : undefined;
	if (profileName) {
		if (!profile) {
			return { error: `Unknown profile: "${profileName}". Available profiles: ${formatProfileList(resources)}.` };
		}
		if (!profile.enabled) return { error: `Profile "${profileName}" is disabled.` };
	}

	const resolvedModel = resolveModelFromEffort(step.model ?? agent?.model, step.effort ?? agent?.defaultEffort, resources);
	if (resolvedModel.error) return { error: resolvedModel.error };

	const skills = step.skills ?? agent?.defaultSkills;
	const prompt = composePromptLayers(profile?.systemPrompt ?? "", agent?.systemPrompt ?? "", step.prompt ?? "");
	const tools = agent?.tools ?? profile?.tools;
	const systemPromptMode = agent?.systemPromptMode ?? profile?.systemPromptMode ?? "append";
	const displayAgentName = agent?.name ?? "generic";

	const globalTaskDefaults = resources.globalTasksConfig;
	const projectTaskDefaults = resources.projectTasksConfig;

	const agentContextMode = agent?.context?.mode;
	const profileContextMode = profile?.context?.mode;
	const agentContextProject = firstDefined(agent?.context?.project, agent?.inheritProjectContext);
	const profileContextProject = firstDefined(profile?.context?.project, profile?.inheritProjectContext);
	const agentContextSkills = firstDefined(agent?.context?.skills, agent?.inheritSkills);
	const profileContextSkills = firstDefined(profile?.context?.skills, profile?.inheritSkills);
	const agentPersist = agent?.persist;
	const profilePersist = profile?.persist;

	const modeCandidates: Array<{
		source: string;
		mode?: ContextMode;
		invalidModeValue?: unknown;
		invalidShapeValue?: unknown;
	}> = [{
		source: "runtime step context",
		mode: step.context,
	}];
	if (agent) {
		modeCandidates.push({
			source: `agent "${agent.name}" (${agent.source})`,
			mode: agentContextMode,
			invalidModeValue: agent.context?.invalidModeValue,
			invalidShapeValue: agent.context?.invalidShapeValue,
		});
	}
	if (profile) {
		modeCandidates.push({
			source: `profile "${profile.name}" (${profile.source})`,
			mode: profileContextMode,
			invalidModeValue: profile.context?.invalidModeValue,
			invalidShapeValue: profile.context?.invalidShapeValue,
		});
	}
	if (projectTaskDefaults) {
		modeCandidates.push({
			source: `project tasks config (${projectTaskDefaults.filePath})`,
			mode: projectTaskDefaults.context?.mode,
			invalidModeValue: projectTaskDefaults.context?.invalidModeValue,
			invalidShapeValue: projectTaskDefaults.context?.invalidShapeValue,
		});
	}
	if (globalTaskDefaults) {
		modeCandidates.push({
			source: `global tasks config (${globalTaskDefaults.filePath})`,
			mode: globalTaskDefaults.context?.mode,
			invalidModeValue: globalTaskDefaults.context?.invalidModeValue,
			invalidShapeValue: globalTaskDefaults.context?.invalidShapeValue,
		});
	}

	let effectiveContextMode: ContextMode = "fresh";
	for (const candidate of modeCandidates) {
		if (context === "task" && candidate.invalidShapeValue !== undefined) {
			let rendered = "";
			if (typeof candidate.invalidShapeValue === "string") rendered = candidate.invalidShapeValue;
			else {
				try {
					rendered = JSON.stringify(candidate.invalidShapeValue) ?? String(candidate.invalidShapeValue);
				} catch {
					rendered = String(candidate.invalidShapeValue);
				}
			}
			return {
				error: `Invalid context from ${candidate.source}: "${rendered}". Expected an object with optional keys "mode", "project", and "skills".`,
			};
		}
		if (candidate.mode === "fresh" || candidate.mode === "fork") {
			effectiveContextMode = candidate.mode;
			break;
		}
		if (context === "task" && candidate.invalidModeValue !== undefined) {
			let rendered = "";
			if (typeof candidate.invalidModeValue === "string") rendered = candidate.invalidModeValue;
			else {
				try {
					rendered = JSON.stringify(candidate.invalidModeValue) ?? String(candidate.invalidModeValue);
				} catch {
					rendered = String(candidate.invalidModeValue);
				}
			}
			return {
				error: `Invalid context.mode from ${candidate.source}: "${rendered}". Expected "fresh" or "fork".`,
			};
		}
	}

	const effectiveContextProject =
		firstDefined(agentContextProject, profileContextProject, projectTaskDefaults?.context?.project, globalTaskDefaults?.context?.project) ??
		false;
	const effectiveContextSkills =
		firstDefined(agentContextSkills, profileContextSkills, projectTaskDefaults?.context?.skills, globalTaskDefaults?.context?.skills) ??
		false;
	const effectivePersist = firstDefined(agentPersist, profilePersist, projectTaskDefaults?.persist, globalTaskDefaults?.persist) ?? true;

	const inheritProjectContext = agent?.inheritProjectContext ?? profile?.inheritProjectContext ?? false;
	const inheritSkills = agent?.inheritSkills ?? profile?.inheritSkills ?? false;

	if ((options.requireBehavior ?? true) && !agent && !prompt.trim()) {
		return {
			error:
				"Invalid task configuration. Provide an agent or a behavioral prompt. Generic workers require `prompt` when no `agent` is selected.",
		};
	}

	return {
		config: {
			agent,
			profile,
			effort: resolvedModel.effort,
			model: resolvedModel.model,
			skills,
			tools,
			context: {
				mode: effectiveContextMode,
				project: effectiveContextProject,
				skills: effectiveContextSkills,
			},
			persist: effectivePersist,
			inheritProjectContext,
			inheritSkills,
			systemPrompt: prompt,
			systemPromptMode,
			displayAgentName,
		},
	};
}

interface MainSessionBaseline {
	sessionId: string;
	model?: { provider: string; id: string };
	thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	tools: string[];
}

interface PersistedMainAgentState {
	found: boolean;
	agent?: string;
	profile?: string;
	effort?: string;
}

let mainSessionBaseline: MainSessionBaseline | undefined;
let activeMainWorker: ResolvedWorkerConfig | undefined;
let startupCompositionError: string | undefined;

function isMainSessionCallableAgent(agent: AgentConfig): boolean {
	return agent.enabled && (agent.availability === "main" || agent.availability === "both");
}

function getMainSessionCallableAgents(agents: AgentConfig[]): AgentConfig[] {
	return agents.filter(isMainSessionCallableAgent);
}

function formatMainSessionAgentList(agents: AgentConfig[]): string {
	return getMainSessionCallableAgents(agents).map((agent) => `${agent.name} (${agent.source})`).join(", ") || "none";
}

function getCurrentModelRef(ctx: { model?: { provider: string; id: string } }): { provider: string; id: string } | undefined {
	return ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
}

function ensureMainSessionBaseline(
	ctx: {
		model?: { provider: string; id: string };
		sessionManager: { getSessionId(): string };
	},
	piApi: Pick<ExtensionAPI, "getActiveTools" | "getThinkingLevel">,
): void {
	const sessionId = ctx.sessionManager.getSessionId();
	if (mainSessionBaseline?.sessionId === sessionId) return;
	mainSessionBaseline = {
		sessionId,
		model: getCurrentModelRef(ctx),
		thinkingLevel: piApi.getThinkingLevel(),
		tools: [...piApi.getActiveTools()],
	};
}

function parseAgentModelSpec(
	modelSpec: string,
	currentModel?: { provider: string; id: string },
): { provider: string; modelId: string } | undefined {
	const normalized = normalizeLegacyModelName(modelSpec)?.trim();
	if (!normalized) return undefined;
	const slashIndex = normalized.indexOf("/");
	if (slashIndex !== -1) {
		const provider = normalized.slice(0, slashIndex).trim();
		const modelId = normalized.slice(slashIndex + 1).trim();
		if (provider && modelId) return { provider, modelId };
		return undefined;
	}
	if (!currentModel?.provider) return undefined;
	return { provider: currentModel.provider, modelId: normalized };
}

function getPersistedMainAgentState(entries: SessionEntry[]): PersistedMainAgentState {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== MAIN_SESSION_AGENT_CUSTOM_TYPE) continue;
		const data = (entry.data ?? {}) as Record<string, unknown>;
		return {
			found: true,
			agent: typeof data.agent === "string" ? data.agent : undefined,
			profile: typeof data.profile === "string" ? data.profile : undefined,
			effort: typeof data.effort === "string" ? data.effort : undefined,
		};
	}
	return { found: false };
}

function persistMainAgentSelection(
	ctx: { sessionManager: { getBranch(): SessionEntry[]; appendCustomEntry(customType: string, data?: unknown): string } },
	state: { agent?: string; profile?: string; effort?: string },
): void {
	const current = getPersistedMainAgentState(ctx.sessionManager.getBranch());
	if (current.found && current.agent === state.agent && current.profile === state.profile && current.effort === state.effort) return;
	ctx.sessionManager.appendCustomEntry(MAIN_SESSION_AGENT_CUSTOM_TYPE, {
		agent: state.agent ?? null,
		profile: state.profile ?? null,
		effort: state.effort ?? null,
	});
}

function syncRuntimeEnv(
	piApi: Pick<ExtensionAPI, "getFlag">,
	state: { agent?: string; profile?: string },
): void {
	const explicitAgent = piApi.getFlag("agent-name");
	if (!(typeof explicitAgent === "string" && explicitAgent.length > 0)) {
		if (state.agent) process.env.PI_AGENT_NAME = state.agent;
		else delete process.env.PI_AGENT_NAME;
	}
	const explicitProfile = piApi.getFlag("profile-name");
	if (!(typeof explicitProfile === "string" && explicitProfile.length > 0)) {
		if (state.profile) process.env.PI_PROFILE_NAME = state.profile;
		else delete process.env.PI_PROFILE_NAME;
	}
}

async function restoreMainSessionBaseline(
	ctx: {
		cwd: string;
		model?: { provider: string; id: string };
		modelRegistry: { find(provider: string, modelId: string): unknown };
	},
	piApi: Pick<ExtensionAPI, "setModel" | "setActiveTools" | "setThinkingLevel">,
): Promise<string | undefined> {
	if (!mainSessionBaseline) return undefined;
	if (mainSessionBaseline.model) {
		const baselineModel = ctx.modelRegistry.find(mainSessionBaseline.model.provider, mainSessionBaseline.model.id) as
			| { provider: string; id: string }
			| undefined;
		if (!baselineModel) {
			return `Baseline model not found: ${mainSessionBaseline.model.provider}/${mainSessionBaseline.model.id}.`;
		}
		const success = await piApi.setModel(baselineModel as never);
		if (!success) {
			return `No API key available for baseline model ${mainSessionBaseline.model.provider}/${mainSessionBaseline.model.id}.`;
		}
	}
	piApi.setThinkingLevel(mainSessionBaseline.thinkingLevel);
	piApi.setActiveTools([...mainSessionBaseline.tools]);
	return undefined;
}

async function applyMainSessionAgentSelection(
	ctx: {
		cwd: string;
		hasUI: boolean;
		ui: { confirm(title: string, message: string): Promise<boolean>; notify(message: string, level: "info" | "warning" | "error"): void };
		model?: { provider: string; id: string };
		modelRegistry: { find(provider: string, modelId: string): unknown };
		sessionManager: { getSessionId(): string; getBranch(): SessionEntry[]; appendCustomEntry(customType: string, data?: unknown): string };
	},
	piApi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "getFlag" | "getThinkingLevel" | "setActiveTools" | "setModel" | "setThinkingLevel">,
	selection: { agent?: string; profile?: string; effort?: string },
	options: { persist?: boolean; notify?: boolean; confirmProjectAgent?: boolean } = {},
): Promise<{ ok: true; worker?: ResolvedWorkerConfig } | { ok: false; error: string }> {
	ensureMainSessionBaseline(ctx, piApi);
	const resources = discoverResources(ctx.cwd, "both");

	if (selection.agent) {
		const role = resources.agents.find((candidate) => candidate.name === selection.agent);
		if (!role) {
			return { ok: false, error: `Unknown agent: "${selection.agent}". Available main-session agents: ${formatMainSessionAgentList(resources.agents)}.` };
		}
		if (!role.enabled) return { ok: false, error: `Agent "${selection.agent}" is disabled.` };
		if (role.availability === "task") return { ok: false, error: `Agent "${selection.agent}" is not main-session callable (availability: task).` };
		if (options.confirmProjectAgent && role.source === "project" && ctx.hasUI) {
			const ok = await ctx.ui.confirm(
				"Switch to project-local agent?",
				`Agent: ${role.name}\nSource: ${role.filePath}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
			);
			if (!ok) return { ok: false, error: "Canceled: project-local agent not approved." };
		}
	}

	if (!selection.agent && !selection.profile && !selection.effort) {
		const restoreError = await restoreMainSessionBaseline(ctx, piApi);
		if (restoreError) return { ok: false, error: restoreError };
		activeMainWorker = undefined;
		syncRuntimeEnv(piApi, {});
		if (options.persist) persistMainAgentSelection(ctx, {});
		if (options.notify) ctx.ui.notify("Cleared main-session composition; restored session defaults.", "info");
		return { ok: true };
	}

	const resolved = resolveWorkerConfig(
		{
			agent: selection.agent,
			profile: selection.profile,
			effort: selection.effort,
			task: "main-session",
			prompt: undefined,
		},
		resources,
		{ requireBehavior: false, context: "main" },
	);
	if (resolved.error || !resolved.config) {
		return { ok: false, error: resolved.error ?? "Failed to resolve main-session worker configuration." };
	}
	const worker = resolved.config;

	const allToolNames = new Set(piApi.getAllTools().map((tool) => tool.name));
	if (worker.tools !== undefined) {
		const invalidTools = worker.tools.filter((tool) => !allToolNames.has(tool));
		if (invalidTools.length > 0) {
			return { ok: false, error: `Unknown tools in main-session composition: ${invalidTools.join(", ")}.` };
		}
	}

	if (worker.model) {
		const resolvedModel = parseAgentModelSpec(worker.model, ctx.model);
		if (!resolvedModel) {
			return { ok: false, error: `Could not resolve model for main session: ${worker.model}.` };
		}
		const model = ctx.modelRegistry.find(resolvedModel.provider, resolvedModel.modelId) as { provider: string; id: string } | undefined;
		if (!model) return { ok: false, error: `Model not found for main session: ${resolvedModel.provider}/${resolvedModel.modelId}.` };
		const success = await piApi.setModel(model as never);
		if (!success) return { ok: false, error: `No API key available for model ${resolvedModel.provider}/${resolvedModel.modelId}.` };
	} else {
		const restoreError = await restoreMainSessionBaseline(ctx, piApi);
		if (restoreError) return { ok: false, error: restoreError };
	}

	if (worker.effort?.thinkingLevel) {
		piApi.setThinkingLevel(worker.effort.thinkingLevel);
	}
	if (worker.tools !== undefined) piApi.setActiveTools([...worker.tools]);
	else if (mainSessionBaseline) piApi.setActiveTools([...mainSessionBaseline.tools]);

	activeMainWorker = worker;
	syncRuntimeEnv(piApi, { agent: worker.agent?.name, profile: worker.profile?.permissionsProfile ?? worker.profile?.name });
	if (options.persist) persistMainAgentSelection(ctx, selection);
	if (options.notify) {
		ctx.ui.notify(
			`Main session: ${selection.agent ?? "generic"}${selection.profile ? ` + ${selection.profile}` : ""}${selection.effort ? ` + ${selection.effort}` : ""}`,
			"info",
		);
	}
	return { ok: true, worker };
}

interface PreparedTaskStep {
	step: number;
	rawStep: TaskStepConfig;
	worker: ResolvedWorkerConfig;
	launchCwd: string;
	session: {
		mode: ContextMode;
		persist: boolean;
		sessionFile?: string;
		sessionId?: string;
		sessionName?: string;
		parentSessionFile?: string;
		parentSessionId?: string;
		stepDir?: string;
	};
}

interface PreparedTaskRun {
	mode: TaskExecutionMode;
	steps: PreparedTaskStep[];
	sessionRunId?: string;
	sessionRunRoot?: string;
}

function hasRuntimePersistOverride(params: unknown): boolean {
	if (!params || typeof params !== "object") return false;
	const record = params as Record<string, unknown>;
	if (Object.prototype.hasOwnProperty.call(record, "persist")) return true;
	const arrays = [record.tasks, record.chain];
	for (const value of arrays) {
		if (!Array.isArray(value)) continue;
		for (const item of value) {
			if (item && typeof item === "object" && Object.prototype.hasOwnProperty.call(item, "persist")) return true;
		}
	}
	return false;
}

function hasPreviousPlaceholder(task: string): boolean {
	return /\{previous\}/.test(task);
}

function sanitizeStepLabel(step: TaskStepConfig, index: number): string {
	const base = (step.agent ?? step.profile ?? "generic")
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32) || "generic";
	return `${String(index + 1).padStart(2, "0")}-${base}`;
}

function createTaskRunId(): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `${timestamp}_${randomUUID().slice(0, 8)}`;
}

function sanitizePathSegment(value: string | undefined, fallback: string): string {
	const sanitized = (value ?? "")
		.trim()
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return sanitized || fallback;
}

function buildTaskSessionWorkspaceName(run: TaskRunView, preferredStep?: TaskRunStepView): string {
	const snapshot = preferredStep?.snapshot;
	const stableId = sanitizePathSegment(
		snapshot?.parentSessionId ?? run.sourceSessionId ?? path.basename(run.sourceSessionFile ?? ""),
		"session",
	);
	const readableSource = sanitizePathSegment(
		path.basename(snapshot?.parentSessionPath ?? run.sourceSessionFile ?? "", path.extname(snapshot?.parentSessionPath ?? run.sourceSessionFile ?? "")),
		"",
	);
	if (!readableSource || readableSource === stableId) return `pi-${stableId}`;
	return `pi-${stableId}-${readableSource}`.slice(0, 80);
}

function getSessionFileStem(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) return undefined;
	const parsed = path.parse(sessionFile);
	return parsed.name || undefined;
}

function resolveParentSessionBaseDir(parentSessionFile: string | undefined): string {
	if (!parentSessionFile) return TASKS_PARENT_SESSION_ROOT;
	const resolvedRoot = path.resolve(TASKS_PARENT_SESSION_ROOT);
	const resolvedParentDir = path.resolve(path.dirname(parentSessionFile));
	const relative = path.relative(resolvedRoot, resolvedParentDir);
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
		return path.join(resolvedRoot, relative);
	}
	return TASKS_PARENT_SESSION_ROOT;
}

function buildParentSessionFolderName(parentSessionFile: string | undefined, parentSessionId: string | undefined): string {
	const fileStem = getSessionFileStem(parentSessionFile);
	const stableId = sanitizePathSegment(parentSessionId ?? fileStem, TASKS_CHILD_SESSION_FALLBACK_PARENT);
	if (!fileStem) return stableId;
	const readableStem = sanitizePathSegment(fileStem, "");
	if (!readableStem || readableStem === stableId) return stableId;
	return `${stableId}--${readableStem}`;
}

function resolvePersistedTaskSessionRoot(parentSessionFile: string | undefined, parentSessionId: string | undefined): string {
	const parentBaseDir = resolveParentSessionBaseDir(parentSessionFile);
	const parentFolder = buildParentSessionFolderName(parentSessionFile, parentSessionId);
	return path.join(parentBaseDir, TASKS_CHILD_SESSION_RUNS_DIR, parentFolder);
}

function readSessionHeaderStringField(entries: readonly SessionEntry[], field: "id" | "parentSession"): string | undefined {
	const header = entries.find((entry) => entry.type === "session") as (SessionEntry & { id?: unknown; parentSession?: unknown }) | undefined;
	if (!header) return undefined;
	const value = header[field];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readSessionHeaderId(entries: SessionEntry[]): string | undefined {
	return readSessionHeaderStringField(entries, "id");
}

function readSessionHeaderParentSession(entries: SessionEntry[]): string | undefined {
	return readSessionHeaderStringField(entries, "parentSession");
}

function resolveSessionReferencePath(referencePath: string, baseFilePath: string): string {
	const trimmedReference = referencePath.trim();
	if (path.isAbsolute(trimmedReference)) return path.resolve(trimmedReference);
	return path.resolve(path.dirname(baseFilePath), trimmedReference);
}

interface ResolvedParentSession {
	parentSessionPath: string;
	source: "header";
}

async function resolveParentSessionForCurrentSession(
	currentSessionFile: string,
	entries: SessionEntry[],
): Promise<{ resolved?: ResolvedParentSession; error?: string; noParent?: boolean }> {
	const headerParentSession = readSessionHeaderParentSession(entries);
	if (headerParentSession) {
		return {
			resolved: {
				parentSessionPath: resolveSessionReferencePath(headerParentSession, currentSessionFile),
				source: "header",
			},
		};
	}

	return {
		noParent: true,
		error: "Current session has no parentSession header, so a parent session cannot be resolved automatically.",
	};
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	});
}

function createSessionEntryId(): string {
	return randomUUID().slice(0, 8);
}

function buildTaskChildSessionName(agentLabel: string, task: string): string {
	const preview = createTaskPreview(task, 48);
	return `task: ${agentLabel} · ${preview}`;
}

async function appendRawSessionEntries(
	filePath: string,
	entries: Array<Record<string, unknown>>,
): Promise<void> {
	if (entries.length === 0) return;
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.appendFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
	});
}

async function seedFreshTaskSessionFile(params: {
	filePath: string;
	sessionId: string;
	childCwd: string;
	parentSessionFile?: string;
	sessionName: string;
}): Promise<void> {
	const timestamp = new Date().toISOString();
	const sessionInfoId = createSessionEntryId();
	const lines = [
		{
			type: "session",
			version: TASK_SESSION_VERSION_FALLBACK,
			id: params.sessionId,
			timestamp,
			cwd: params.childCwd,
			parentSession: params.parentSessionFile,
		},
		{
			type: "session_info",
			id: sessionInfoId,
			parentId: null,
			timestamp,
			name: params.sessionName,
		},
	];
	await withFileMutationQueue(params.filePath, async () => {
		await fs.promises.writeFile(params.filePath, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
			encoding: "utf-8",
			mode: 0o600,
			flag: "wx",
		});
	});
}

async function createManagedFreshTaskSession(params: {
	childCwd: string;
	parentSessionFile?: string;
	sessionName: string;
}): Promise<{ sessionId: string; sessionFile: string }> {
	const manager = SessionManager.create(params.childCwd);
	const sessionFile = manager.getSessionFile();
	const sessionId = manager.getSessionId();
	if (!sessionFile) throw new Error("Pi did not allocate a persisted session file for the child task.");
	await seedFreshTaskSessionFile({
		filePath: sessionFile,
		sessionId,
		childCwd: params.childCwd,
		parentSessionFile: params.parentSessionFile,
		sessionName: params.sessionName,
	});
	return { sessionId, sessionFile };
}

async function createManagedForkedTaskSession(params: {
	parentSessionFile: string;
	childCwd: string;
	sessionName: string;
}): Promise<{ sessionId: string; sessionFile: string }> {
	const manager = SessionManager.forkFrom(params.parentSessionFile, params.childCwd);
	const sessionFile = manager.getSessionFile();
	const sessionId = manager.getSessionId();
	if (!sessionFile) throw new Error("Pi did not allocate a persisted fork session file for the child task.");

	const timestamp = new Date().toISOString();
	const leafId = manager.getLeafId();
	const sessionInfoId = createSessionEntryId();
	await appendRawSessionEntries(sessionFile, [
		{
			type: "session_info",
			id: sessionInfoId,
			parentId: leafId ?? null,
			timestamp,
			name: params.sessionName,
		},
	]);
	return { sessionId, sessionFile };
}

async function preflightTaskRun(
	mode: TaskExecutionMode,
	steps: TaskStepConfig[],
	resources: ResourceDiscoveryResult,
	defaultCwd: string,
	sessionManager: { getSessionFile?: () => string | undefined; getBranch(): SessionEntry[] },
): Promise<{ prepared?: PreparedTaskRun; error?: string }> {
	const preparedSteps: PreparedTaskStep[] = [];
	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		if (step.context !== undefined && step.context !== "fresh" && step.context !== "fork") {
			return { error: `Invalid context.mode at step ${i + 1}: "${String(step.context)}". Expected "fresh" or "fork".` };
		}
		const resolved = resolveWorkerConfig(step, resources);
		if (resolved.error || !resolved.config) {
			return { error: resolved.error ?? `Failed to resolve step ${i + 1}.` };
		}
		const worker = resolved.config;
		if (worker.context.mode !== "fresh" && worker.context.mode !== "fork") {
			return {
				error: `Invalid effective context.mode at step ${i + 1}: "${String(worker.context.mode)}". Expected "fresh" or "fork".`,
			};
		}
		if (worker.context.mode === "fork" && !worker.persist) {
			return {
				error: `Step ${i + 1} requests context.mode="fork" with effective persist=false. Fork requires persisted sessions.`,
			};
		}
		preparedSteps.push({
			step: i + 1,
			rawStep: step,
			worker,
			launchCwd: step.cwd ?? defaultCwd,
			session: {
				mode: worker.context.mode,
				persist: worker.persist,
			},
		});
	}

	const needsPersistedSessions = preparedSteps.some((step) => step.session.persist);
	const needsFork = preparedSteps.some((step) => step.session.mode === "fork");

	let parentSessionFile: string | undefined;
	let parentSessionId: string | undefined;
	let parentBranch: SessionEntry[] | undefined;
	if (needsPersistedSessions || needsFork) {
		parentSessionFile = sessionManager.getSessionFile?.();
		parentBranch = sessionManager.getBranch();
		parentSessionId = readSessionHeaderId(parentBranch);
	}
	if (needsFork) {
		if (!parentSessionFile) {
			return { error: "context.mode=\"fork\" requires a parent session file, but the current session is unavailable." };
		}
		if (!parentBranch || !parentBranch.some((entry) => entry.type === "session")) {
			return { error: "context.mode=\"fork\" requires a valid parent session snapshot, but none was found." };
		}
	}

	let sessionRunId: string | undefined;
	let sessionRunRoot: string | undefined;
	let sessionStepsRoot: string | undefined;

	if (needsPersistedSessions) {
		sessionRunId = createTaskRunId();
		const persistedSessionRoot = resolvePersistedTaskSessionRoot(parentSessionFile, parentSessionId);
		sessionRunRoot = path.join(persistedSessionRoot, sessionRunId);
		sessionStepsRoot = path.join(sessionRunRoot, "steps");
		try {
			await fs.promises.mkdir(sessionStepsRoot, { recursive: true });
			await writeJsonFile(path.join(sessionRunRoot, "run.json"), {
				runId: sessionRunId,
				createdAt: new Date().toISOString(),
				mode,
				stepCount: preparedSteps.length,
				persistedStepCount: preparedSteps.filter((step) => step.session.persist).length,
				parentSessionFile: parentSessionFile ?? null,
				parentSessionId: parentSessionId ?? null,
				sessionStorageRoot: persistedSessionRoot,
			});
		} catch (error) {
			return {
				error: `Failed to create task session root at ${sessionRunRoot}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	for (let i = 0; i < preparedSteps.length; i++) {
		const preparedStep = preparedSteps[i];
		const stepLabel = sanitizeStepLabel(preparedStep.rawStep, i);
		if (sessionStepsRoot) {
			preparedStep.session.stepDir = path.join(sessionStepsRoot, stepLabel);
			try {
				await fs.promises.mkdir(preparedStep.session.stepDir, { recursive: true });
			} catch (error) {
				return {
					error: `Failed to create session directory for step ${i + 1}: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}

		if (!preparedStep.session.persist) {
			if (preparedStep.session.stepDir) {
				try {
					await writeJsonFile(path.join(preparedStep.session.stepDir, "step.json"), {
						step: i + 1,
						mode: preparedStep.session.mode,
						persist: false,
						cwd: preparedStep.launchCwd,
						agent: preparedStep.worker.agent?.name ?? null,
						profile: preparedStep.worker.profile?.name ?? null,
						sessionFile: null,
					});
				} catch (error) {
					return {
						error: `Failed to write step metadata for step ${i + 1}: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
			}
			continue;
		}

		if (!preparedStep.session.stepDir) {
			return { error: `Internal error: missing step directory for persisted step ${i + 1}.` };
		}

		const sessionName = buildTaskChildSessionName(preparedStep.worker.displayAgentName, preparedStep.rawStep.task);
		let sessionId: string;
		let sessionFile: string;
		try {
			if (preparedStep.session.mode === "fresh") {
				const createdSession = await createManagedFreshTaskSession({
					childCwd: preparedStep.launchCwd,
					parentSessionFile,
					sessionName,
				});
				sessionId = createdSession.sessionId;
				sessionFile = createdSession.sessionFile;
			} else {
				if (!parentSessionFile) {
					return { error: `Step ${i + 1} cannot fork because parent session is unavailable.` };
				}
				const createdSession = await createManagedForkedTaskSession({
					parentSessionFile,
					childCwd: preparedStep.launchCwd,
					sessionName,
				});
				sessionId = createdSession.sessionId;
				sessionFile = createdSession.sessionFile;
			}
		} catch (error) {
			return {
				error: `Failed to create child session for step ${i + 1}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		preparedStep.session.sessionFile = sessionFile;
		preparedStep.session.sessionId = sessionId;
		preparedStep.session.sessionName = sessionName;
		preparedStep.session.parentSessionFile = parentSessionFile;
		preparedStep.session.parentSessionId = parentSessionId;
		try {
			await writeJsonFile(path.join(preparedStep.session.stepDir, "step.json"), {
				step: i + 1,
				mode: preparedStep.session.mode,
				persist: true,
				cwd: preparedStep.launchCwd,
				agent: preparedStep.worker.agent?.name ?? null,
				profile: preparedStep.worker.profile?.name ?? null,
				sessionId,
				sessionFile,
				sessionName,
				parentSessionFile: parentSessionFile ?? null,
				parentSessionId: parentSessionId ?? null,
			});
		} catch (error) {
			return {
				error: `Failed to write step metadata for step ${i + 1}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	return {
		prepared: {
			mode,
			steps: preparedSteps,
			sessionRunId,
			sessionRunRoot,
		},
	};
}

async function runSingleAgentViaJson(
	preparedStep: PreparedTaskStep,
	task: string,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => TaskDetails,
	initialChildSession?: ChildSessionSnapshot,
): Promise<SingleResult> {
	const worker = preparedStep.worker;
	const agent = worker.agent;
	const args: string[] = ["--mode", "json", "-p"];
	if (preparedStep.session.persist) {
		if (!preparedStep.session.sessionFile) {
			return {
				agent: worker.displayAgentName,
				agentSource: agent?.source ?? "unknown",
				profile: worker.profile?.name,
				effort: worker.effort?.name,
				task,
				exitCode: 1,
				messages: [],
				stderr: "Missing child session file for persisted task step.",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				model: worker.model,
				step,
				sessionMode: preparedStep.session.mode,
				sessionPersist: preparedStep.session.persist,
				sessionFile: preparedStep.session.sessionFile,
				childSession: initialChildSession ? { ...initialChildSession } : undefined,
			};
		}
		args.push("--session", preparedStep.session.sessionFile);
	} else {
		args.push("--no-session");
	}

	const agentModel = worker.model;
	if (agentModel) args.push("--model", agentModel);
	if (worker.effort?.thinkingLevel) args.push("--thinking", worker.effort.thinkingLevel);
	if (worker.tools !== undefined) {
		if (worker.tools.length > 0) args.push("--tools", worker.tools.join(","));
		else args.push("--no-tools");
	}
	if (!worker.inheritProjectContext) args.push("--no-context-files");

	if (worker.skills && worker.skills.length > 0) {
		const { paths, missing } = resolveSkillPaths(worker.skills, preparedStep.launchCwd);
		if (missing.length > 0) {
			return {
				agent: worker.displayAgentName,
				agentSource: agent?.source ?? "unknown",
				profile: worker.profile?.name,
				effort: worker.effort?.name,
				task,
				exitCode: 1,
				messages: [],
				stderr: `Failed to resolve required skills for worker "${worker.displayAgentName}": ${missing.join(", ")}.`,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				model: agentModel,
				step,
				sessionMode: preparedStep.session.mode,
				sessionPersist: preparedStep.session.persist,
				sessionFile: preparedStep.session.sessionFile,
				childSession: initialChildSession ? { ...initialChildSession } : undefined,
			};
		}
		args.push("--no-skills");
		for (const skillPath of paths) args.push("--skill", skillPath);
	} else if (!worker.inheritSkills) {
		args.push("--no-skills");
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: worker.displayAgentName,
		agentSource: agent?.source ?? "unknown",
		profile: worker.profile?.name,
		effort: worker.effort?.name,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agentModel,
		step,
		sessionMode: preparedStep.session.mode,
		sessionPersist: preparedStep.session.persist,
		sessionFile: preparedStep.session.sessionFile,
		childSession: initialChildSession ? { ...initialChildSession } : undefined,
		uiNotices: [],
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		const composedPrompt = worker.systemPrompt;
		if (composedPrompt.trim()) {
			const tmp = await writePromptToTempFile(worker.displayAgentName, composedPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			const promptFlag = worker.systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt";
			args.push(promptFlag, tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: preparedStep.launchCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					...getSubagentDepthEnv(),
					...(agent ? { PI_AGENT_NAME: agent.name } : {}),
					...(worker.profile ? { PI_PROFILE_NAME: worker.profile.permissionsProfile ?? worker.profile.name } : {}),
				},
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) {
			currentResult.stopReason = "aborted";
			if (!currentResult.errorMessage) currentResult.errorMessage = "Task was aborted";
			if (currentResult.exitCode === 0) currentResult.exitCode = 130;
		}
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

async function runSingleAgentViaRpc(
	preparedStep: PreparedTaskStep,
	task: string,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => TaskDetails,
	initialChildSession: ChildSessionSnapshot,
	toolCallId: string,
	parentUiContext?: TaskRpcUiContext,
): Promise<SingleResult> {
	const worker = preparedStep.worker;
	const agent = worker.agent;
	const args: string[] = ["--mode", "rpc"];
	if (!preparedStep.session.sessionFile) {
		return {
			agent: worker.displayAgentName,
			agentSource: agent?.source ?? "unknown",
			profile: worker.profile?.name,
			effort: worker.effort?.name,
			task,
			exitCode: 1,
			messages: [],
			stderr: "Missing child session file for persisted RPC task step.",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model: worker.model,
			step,
			sessionMode: preparedStep.session.mode,
			sessionPersist: preparedStep.session.persist,
			sessionFile: preparedStep.session.sessionFile,
			childSession: { ...initialChildSession },
		};
	}
	args.push("--session", preparedStep.session.sessionFile);

	const agentModel = worker.model;
	if (agentModel) args.push("--model", agentModel);
	if (worker.effort?.thinkingLevel) args.push("--thinking", worker.effort.thinkingLevel);
	if (worker.tools !== undefined) {
		if (worker.tools.length > 0) args.push("--tools", worker.tools.join(","));
		else args.push("--no-tools");
	}
	if (!worker.inheritProjectContext) args.push("--no-context-files");
	if (worker.skills && worker.skills.length > 0) {
		const { paths, missing } = resolveSkillPaths(worker.skills, preparedStep.launchCwd);
		if (missing.length > 0) {
			return {
				agent: worker.displayAgentName,
				agentSource: agent?.source ?? "unknown",
				profile: worker.profile?.name,
				effort: worker.effort?.name,
				task,
				exitCode: 1,
				messages: [],
				stderr: `Failed to resolve required skills for worker "${worker.displayAgentName}": ${missing.join(", ")}.`,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				model: agentModel,
				step,
				sessionMode: preparedStep.session.mode,
				sessionPersist: preparedStep.session.persist,
				sessionFile: preparedStep.session.sessionFile,
				childSession: { ...initialChildSession },
			};
		}
		args.push("--no-skills");
		for (const skillPath of paths) args.push("--skill", skillPath);
	} else if (!worker.inheritSkills) {
		args.push("--no-skills");
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	const currentResult: SingleResult = {
		agent: worker.displayAgentName,
		agentSource: agent?.source ?? "unknown",
		profile: worker.profile?.name,
		effort: worker.effort?.name,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agentModel,
		step,
		sessionMode: preparedStep.session.mode,
		sessionPersist: preparedStep.session.persist,
		sessionFile: preparedStep.session.sessionFile,
		childSession: { ...initialChildSession },
		uiNotices: [],
	};
	const emitUpdate = () => {
		if (!onUpdate) return;
		onUpdate({
			content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
			details: makeDetails([currentResult]),
		});
	};

	try {
		const composedPrompt = worker.systemPrompt;
		if (composedPrompt.trim()) {
			const tmp = await writePromptToTempFile(worker.displayAgentName, composedPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			const promptFlag = worker.systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt";
			args.push(promptFlag, tmpPromptPath);
		}

		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: preparedStep.launchCwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				...getSubagentDepthEnv(),
				...(agent ? { PI_AGENT_NAME: agent.name } : {}),
				...(worker.profile ? { PI_PROFILE_NAME: worker.profile.permissionsProfile ?? worker.profile.name } : {}),
			},
		});
		const controllerKey = makeTaskRunStepKey(initialChildSession.runId, step ?? initialChildSession.step);
		const relayedStatusKeys = new Set<string>();
		const relayedWidgetKeys = new Set<string>();
		const uiRelayAbortController = new AbortController();
		const controller: LiveTaskController = {
			key: controllerKey,
			toolCallId,
			runId: initialChildSession.runId,
			step: step ?? initialChildSession.step,
			childSessionId: initialChildSession.childSessionId,
			childSessionPath: initialChildSession.childSessionPath,
			parentSessionPath: initialChildSession.parentSessionPath,
			task,
			agent: worker.displayAgentName,
			transport: "rpc",
			proc,
			pendingResponses: new Map<string, PendingRpcResponse>(),
			status: "running",
			startedAt: new Date().toISOString(),
			isStreaming: false,
			pendingSteeringCount: 0,
			pendingFollowUpCount: 0,
			lastMessageCount: 0,
			syncCursor: 0,
		};
		setLiveTaskController(controller);

		let buffer = "";
		let completionResolve: ((value: number) => void) | undefined;
		const completion = new Promise<number>((resolve) => {
			completionResolve = resolve;
		});
		let sawAgentEnd = false;
		let rpcAborted = false;
		let closed = false;
		let uiRelayQueue: Promise<void> = Promise.resolve();

		const clearRelayedUi = () => {
			if (!(parentUiContext?.hasUI === true && parentUiContext.ui)) return;
			for (const statusKey of relayedStatusKeys) {
				try {
					parentUiContext.ui.setStatus?.(statusKey, undefined);
				} catch {
					// Ignore UI cleanup failures.
				}
			}
			for (const widgetKey of relayedWidgetKeys) {
				try {
					parentUiContext.ui.setWidget?.(widgetKey, undefined);
				} catch {
					// Ignore UI cleanup failures.
				}
			}
			parentUiContext.refreshTaskUiChrome?.();
		};

		const finishController = (exitCode: number) => {
			if (closed) return;
			closed = true;
			uiRelayAbortController.abort();
			clearRelayedUi();
			controller.finishedAt = new Date().toISOString();
			deleteLiveTaskController(controller.key);
			rejectPendingRpcResponses(controller, new Error("Task controller closed"));
			completionResolve?.(exitCode);
		};

		const handleLine = (line: string) => {
			if (!line.trim()) return;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (!isRecord(event)) return;
			if (event.type === "response") {
				const response = event as RpcResponseEnvelope;
				if (typeof response.id === "string") {
					const pending = controller.pendingResponses.get(response.id);
					if (pending) {
						controller.pendingResponses.delete(response.id);
						pending.resolve(response);
					}
				}
				return;
			}
			if (event.type === "agent_start") {
				controller.isStreaming = true;
				controller.lastActivity = "agent_start";
				return;
			}
			if (event.type === "agent_end") {
				sawAgentEnd = true;
				controller.isStreaming = false;
				controller.status = rpcAborted ? "aborted" : "completed";
				controller.lastActivity = "agent_end";
				const maybeMessages = Array.isArray(event.messages) ? (event.messages as Message[]) : undefined;
				if (maybeMessages) {
					currentResult.messages = maybeMessages;
					controller.lastMessageCount = maybeMessages.length;
				}
				emitUpdate();
				proc.kill("SIGTERM");
				return;
			}
			if (event.type === "message_end" && event.message) {
				const msg = event.message as Message;
				currentResult.messages.push(msg);
				controller.lastMessageCount = currentResult.messages.length;
				controller.lastActivity = msg.role;
				if (msg.role === "assistant") {
					currentResult.usage.turns++;
					const usage = msg.usage;
					if (usage) {
						currentResult.usage.input += usage.input || 0;
						currentResult.usage.output += usage.output || 0;
						currentResult.usage.cacheRead += usage.cacheRead || 0;
						currentResult.usage.cacheWrite += usage.cacheWrite || 0;
						currentResult.usage.cost += usage.cost?.total || 0;
						currentResult.usage.contextTokens = usage.totalTokens || 0;
					}
					if (!currentResult.model && msg.model) currentResult.model = msg.model;
					if (msg.stopReason) currentResult.stopReason = msg.stopReason;
					if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
				}
				emitUpdate();
				return;
			}
			if (event.type === "tool_execution_start") {
				controller.lastActivity = typeof event.toolName === "string" ? `tool:${event.toolName}` : "tool:start";
				return;
			}
			if (event.type === "tool_execution_end") {
				controller.lastActivity = typeof event.toolName === "string" ? `tool:${event.toolName}` : "tool:end";
				return;
			}
			if (event.type === "queue_update") {
				controller.lastActivity = "queue_update";
				controller.pendingSteeringCount = Array.isArray(event.steering) ? event.steering.length : controller.pendingSteeringCount;
				controller.pendingFollowUpCount = Array.isArray(event.followUp) ? event.followUp.length : controller.pendingFollowUpCount;
				return;
			}
			if (event.type === "extension_ui_request" && typeof event.id === "string" && typeof event.method === "string") {
				controller.lastActivity = `ui:${event.method}`;
				const request = event as TaskExtensionUiRequest;
				if (request.method === "notify" && typeof request.message === "string" && request.message.trim()) {
					addTaskInlineNotice(
						currentResult,
						request.message,
						isTaskExtensionUiNotifyType(request.notifyType) ? request.notifyType : "info",
					);
					emitUpdate();
				}
				const sendExtensionUiResponse = async (payload: Record<string, unknown>) => {
					await new Promise<void>((resolve, reject) => {
						proc.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
							if (error) reject(error);
							else resolve();
						});
					});
				};
				uiRelayQueue = uiRelayQueue
					.then(async () => {
						await relayTaskExtensionUiRequest({
							request,
							controller,
							parentUi: parentUiContext,
							dialogSignal: uiRelayAbortController.signal,
							sendResponse: sendExtensionUiResponse,
							trackedStatusKeys: relayedStatusKeys,
							trackedWidgetKeys: relayedWidgetKeys,
						});
					})
					.catch((error) => {
						const message = error instanceof Error ? error.message : String(error);
						currentResult.errorMessage = currentResult.errorMessage ?? `Failed to relay task UI request: ${message}`;
						currentResult.stderr += currentResult.stderr ? `\n${message}` : message;
						controller.status = rpcAborted ? "aborted" : "failed";
						proc.kill("SIGTERM");
					});
			}
		};

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) handleLine(line);
		});
		proc.stderr.on("data", (data) => {
			currentResult.stderr += data.toString();
		});
		proc.on("close", (code) => {
			if (buffer.trim()) handleLine(buffer);
			finishController(sawAgentEnd ? 0 : (code ?? 1));
		});
		proc.on("error", (error) => {
			controller.status = rpcAborted ? "aborted" : "failed";
			currentResult.stderr += error instanceof Error ? error.message : String(error);
			finishController(1);
		});

		if (signal) {
			const killProc = () => {
				rpcAborted = true;
				controller.status = "aborted";
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal.aborted) killProc();
			else signal.addEventListener("abort", killProc, { once: true });
		}

		const promptResponse = await sendLiveTaskRpcCommand(controller, {
			type: "prompt",
			message: `Task: ${task}`,
		});
		if (promptResponse.success === false) {
			controller.status = "failed";
			proc.kill("SIGTERM");
			await completion;
			currentResult.exitCode = 1;
			currentResult.errorMessage = typeof promptResponse.error === "string" ? promptResponse.error : "Task prompt rejected";
			if (!currentResult.stderr && currentResult.errorMessage) currentResult.stderr = currentResult.errorMessage;
			return currentResult;
		}

		const exitCode = await completion;
		currentResult.exitCode = exitCode;
		if (rpcAborted) {
			currentResult.stopReason = "aborted";
			if (!currentResult.errorMessage) currentResult.errorMessage = "Task was aborted";
			if (currentResult.exitCode === 0) currentResult.exitCode = 130;
		}
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

async function runSingleAgent(
	preparedStep: PreparedTaskStep,
	task: string,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => TaskDetails,
	initialChildSession?: ChildSessionSnapshot,
	enableRpcControl = false,
	toolCallId?: string,
	parentUiContext?: TaskRpcUiContext,
): Promise<SingleResult> {
	if (enableRpcControl && initialChildSession && preparedStep.session.persist && preparedStep.session.sessionFile && toolCallId) {
		return runSingleAgentViaRpc(
			preparedStep,
			task,
			step,
			signal,
			onUpdate,
			makeDetails,
			initialChildSession,
			toolCallId,
			parentUiContext,
		);
	}
	return runSingleAgentViaJson(preparedStep, task, step, signal, onUpdate, makeDetails, initialChildSession);
}

function appendTaskChildSessionMetadata(
	sessionManager: { appendCustomEntry(customType: string, data?: unknown): string },
	snapshot: ChildSessionSnapshot,
): string | undefined {
	try {
		sessionManager.appendCustomEntry(TASK_CHILD_SESSION_CUSTOM_TYPE, snapshot);
		return undefined;
	} catch (error) {
		return `Failed to append ${TASK_CHILD_SESSION_CUSTOM_TYPE} metadata: ${error instanceof Error ? error.message : String(error)}`;
	}
}

async function runTaskStepWithMetadata(options: {
	preparedStep: PreparedTaskStep;
	task: string;
	mode: TaskExecutionMode;
	step: number;
	toolCallId: string;
	runId?: string;
	signal: AbortSignal | undefined;
	onUpdate: OnUpdateCallback | undefined;
	makeDetails: (results: SingleResult[]) => TaskDetails;
	sessionManager: { appendCustomEntry(customType: string, data?: unknown): string };
	origin?: TaskOriginSnapshot;
	refreshUi?: () => Promise<void> | void;
	enableRpcControl?: boolean;
	parentUiContext?: TaskRpcUiContext;
}): Promise<SingleResult> {
	const { preparedStep, task, mode, step, toolCallId, runId, signal, onUpdate, makeDetails, sessionManager, origin, refreshUi, enableRpcControl, parentUiContext } = options;
	const metadataRunId = runId ?? `${toolCallId}-run`;

	let createdSnapshot: ChildSessionSnapshot | undefined;
	if (preparedStep.session.persist && preparedStep.session.sessionFile && preparedStep.session.sessionId) {
		createdSnapshot = {
			v: TASK_CHILD_SESSION_METADATA_VERSION,
			runId: metadataRunId,
			toolCallId,
			mode,
			step,
			childSessionId: preparedStep.session.sessionId,
			childSessionPath: preparedStep.session.sessionFile,
			childSessionName: preparedStep.session.sessionName,
			parentSessionId: preparedStep.session.parentSessionId,
			parentSessionPath: preparedStep.session.parentSessionFile,
			originEntryId: origin?.originEntryId,
			originUserEntryId: origin?.originUserEntryId,
			originPreview: origin?.originPreview,
			effectiveContext: preparedStep.session.mode,
			persist: true,
			agent: preparedStep.worker.agent?.name,
			profile: preparedStep.worker.profile?.name,
			taskPreview: createTaskPreview(task),
			createdAt: new Date().toISOString(),
			status: "created",
		};
		const appendError = appendTaskChildSessionMetadata(sessionManager, createdSnapshot);
		if (!appendError) await Promise.resolve(refreshUi?.());
		if (appendError) {
			const metadataError =
				`Failed to append initial ${TASK_CHILD_SESSION_CUSTOM_TYPE} metadata (status="created"). ` +
				"Persisted child step was not started because parent metadata is authoritative.";
			const fullError = `${metadataError}\n${appendError}`;
			return {
				agent: preparedStep.worker.displayAgentName,
				agentSource: preparedStep.worker.agent?.source ?? "unknown",
				profile: preparedStep.worker.profile?.name,
				effort: preparedStep.worker.effort?.name,
				task,
				exitCode: 1,
				messages: [],
				stderr: fullError,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				model: preparedStep.worker.model,
				step,
				sessionMode: preparedStep.session.mode,
				sessionPersist: preparedStep.session.persist,
				sessionFile: preparedStep.session.sessionFile,
				stopReason: "error",
				errorMessage: metadataError,
				childSession: {
					...createdSnapshot,
					status: "failed",
					finishedAt: new Date().toISOString(),
					exitCode: 1,
					stopReason: "error",
					errorMessage: createTaskPreview(metadataError, 240),
				},
			};
		}
	}

	let result: SingleResult;
	try {
		result = await runSingleAgent(
			preparedStep,
			task,
			step,
			signal,
			onUpdate,
			makeDetails,
			createdSnapshot,
			enableRpcControl === true,
			toolCallId,
			parentUiContext,
		);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const aborted = /aborted/i.test(errorMessage);
		result = {
			agent: preparedStep.worker.displayAgentName,
			agentSource: preparedStep.worker.agent?.source ?? "unknown",
			profile: preparedStep.worker.profile?.name,
			effort: preparedStep.worker.effort?.name,
			task,
			exitCode: aborted ? 130 : 1,
			messages: [],
			stderr: errorMessage,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model: preparedStep.worker.model,
			step,
			sessionMode: preparedStep.session.mode,
			sessionPersist: preparedStep.session.persist,
			sessionFile: preparedStep.session.sessionFile,
			stopReason: aborted ? "aborted" : "error",
			errorMessage,
			childSession: createdSnapshot ? { ...createdSnapshot } : undefined,
		};
	}

	if (createdSnapshot) {
		let terminalSnapshot: ChildSessionSnapshot = {
			...createdSnapshot,
			status: resolveChildSessionTerminalStatus(result),
			finishedAt: new Date().toISOString(),
			exitCode: result.exitCode,
			stopReason: result.stopReason,
			errorMessage: result.errorMessage ?? (result.stderr.trim().length > 0 ? createTaskPreview(result.stderr.trim(), 240) : undefined),
		};
		const appendError = appendTaskChildSessionMetadata(sessionManager, terminalSnapshot);
		if (!appendError) await Promise.resolve(refreshUi?.());
		if (appendError) {
			const metadataError =
				`Failed to append terminal ${TASK_CHILD_SESSION_CUSTOM_TYPE} metadata (status="${terminalSnapshot.status}"). ` +
				"Persisted run metadata is incomplete.";
			const fullError = `${metadataError}\n${appendError}`;
			result.stderr = result.stderr ? `${result.stderr}\n${fullError}` : fullError;
			result.errorMessage = result.errorMessage ? `${result.errorMessage} ${metadataError}` : metadataError;
			if (result.exitCode === 0) result.exitCode = 1;
			if (result.stopReason !== "aborted") result.stopReason = "error";
			terminalSnapshot = {
				...terminalSnapshot,
				status: terminalSnapshot.status === "succeeded" ? "failed" : terminalSnapshot.status,
				exitCode: result.exitCode,
				stopReason: result.stopReason,
				errorMessage: createTaskPreview(result.errorMessage, 240),
			};
		}
		result.childSession = terminalSnapshot;
	}

	return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function collectLiveTaskControllerStepKeys(currentSessionFile?: string): Set<string> {
	const keys = new Set<string>();
	for (const controller of listLiveTaskControllers()) {
		if (controller.status !== "running") continue;
		if (currentSessionFile && controller.parentSessionPath && controller.parentSessionPath !== currentSessionFile) continue;
		keys.add(controller.key);
	}
	return keys;
}

function resolveLiveTaskControllerForRun(run: TaskRunView, step?: TaskRunStepView): { controller?: LiveTaskController; error?: string } {
	if (step) {
		const controller = getLiveTaskController(makeTaskRunStepKey(run.runId, step.step));
		if (!controller || controller.status !== "running") {
			return { error: `Run ${run.runId} step ${step.step} is not attached to a running live task controller.` };
		}
		return { controller };
	}

	const controllers = run.steps
		.map((candidate) => getLiveTaskController(makeTaskRunStepKey(run.runId, candidate.step)))
		.filter((candidate): candidate is LiveTaskController => Boolean(candidate) && candidate.status === "running");
	if (controllers.length === 0) {
		return { error: `Run ${run.runId} has no running live task controller.` };
	}
	if (controllers.length > 1) {
		return { error: `Run ${run.runId} has multiple running steps. Select a specific child session id prefix first.` };
	}
	return { controller: controllers[0] };
}

function describeTaskRunAccess(run: TaskRunView, selectedStep?: TaskRunStepView): string[] {
	const labels: string[] = [];
	const targetStep = selectTaskRunStepForOpen(run, selectedStep);
	const liveControllerResolution = resolveLiveTaskControllerForRun(run, selectedStep);
	if (targetStep?.snapshot.persist) {
		labels.push("open");
		const liveController = getLiveTaskController(makeTaskRunStepKey(run.runId, targetStep.step));
		if (getTaskTerminalAttachment(targetStep.snapshot) || liveController?.status !== "running") labels.push("attach");
	}
	if (liveControllerResolution.controller) labels.push("steer");
	if (resolveTaskRunOriginSnapshot(run, selectedStep)) labels.push("origin");
	return labels;
}

interface TaskRunSummaryData {
	index: number;
	status: string;
	hasLiveController: boolean;
	runId: string;
	mode: TaskExecutionMode;
	stepCount: number;
	stepLabel: string;
	updatedAt: string;
	access: string[];
	attachHint?: string;
	sourceFileName?: string;
	originPreview?: string;
	warningCount: number;
}

function getTaskRunSummaryData(run: TaskRunView, index: number, includeSource: boolean): TaskRunSummaryData {
	const stepLabel = run.stepCount === 1 ? "step" : "steps";
	const hasLiveController = run.steps.some((step) => Boolean(getLiveTaskController(makeTaskRunStepKey(run.runId, step.step))));
	const access = describeTaskRunAccess(run);
	const attachHint = access.includes("attach") ? `/tasks attach ${index}` : undefined;
	return {
		index,
		status: run.status,
		hasLiveController,
		runId: run.runId,
		mode: run.mode,
		stepCount: run.stepCount,
		stepLabel,
		updatedAt: formatTimestampCompact(run.updatedAt),
		access,
		attachHint,
		sourceFileName: includeSource && run.sourceSessionFile ? path.basename(run.sourceSessionFile) : undefined,
		originPreview: resolveTaskRunOriginSnapshot(run)?.originPreview,
		warningCount: run.warnings.length,
	};
}

function formatTaskRunSummary(run: TaskRunView, index: number, includeSource: boolean): string {
	const data = getTaskRunSummaryData(run, index, includeSource);
	let text = `${data.index}. ${data.status}${data.hasLiveController ? "/live" : ""} ${data.runId} · ${data.mode} · ${data.stepCount} ${data.stepLabel} · ${data.updatedAt}`;
	if (data.access.length > 0) text += ` · ${data.access.join(",")}`;
	if (data.attachHint) text += ` · ${data.attachHint}`;
	if (data.sourceFileName) text += ` · ${data.sourceFileName}`;
	if (data.originPreview) text += ` · ${data.originPreview}`;
	if (data.warningCount > 0) text += ` · warnings:${data.warningCount}`;
	return text;
}

function themeIndependentTaskBrowserHeading(runCount: number): string {
	return `Task runs in current session (${runCount}):`;
}

function formatTaskRunList(scope: TasksScope, runs: TaskRunView[]): string {
	if (runs.length === 0) {
		return TASKS_NO_CURRENT_RUNS_MESSAGE;
	}
	const header = themeIndependentTaskBrowserHeading(runs.length);
	const guidance = `Open a persisted task in a terminal window with /tasks attach <selector> (${getTaskAttachActionLabel()}). Running externally hosted tasks are focused instead.`;
	return [header, guidance, ...runs.map((run, index) => formatTaskRunSummary(run, index + 1, false))].join("\n");
}

async function formatTaskRunDetails(scope: TasksScope, run: TaskRunView, selectedStep?: TaskRunStepView): Promise<string> {
	const lines: string[] = [];
	lines.push(`Run: ${run.runId}`);
	lines.push(`Status: ${run.status} · mode: ${run.mode} · steps: ${run.stepCount}`);
	lines.push(`Scope: ${scope}`);
	lines.push(`Created: ${formatTimestampCompact(run.createdAt)} · Updated: ${formatTimestampCompact(run.updatedAt)}`);
	if (run.sourceSessionFile) {
		lines.push(`Source session: ${shortenHomePath(run.sourceSessionFile)}${run.sourceSessionId ? ` (${run.sourceSessionId.slice(0, 8)})` : ""}`);
	}
	if (selectedStep) {
		lines.push(`Selector matched step ${selectedStep.step} (${selectedStep.status}).`);
	}
	const origin = resolveTaskRunOriginSnapshot(run, selectedStep);
	const originTarget = getTaskOriginNavigationTarget(run, selectedStep);
	const access = describeTaskRunAccess(run, selectedStep);
	if (origin?.originPreview) lines.push(`Origin: ${origin.originPreview}`);
	if (originTarget) lines.push(`Origin entry: ${originTarget.slice(0, 8)}`);
	if (access.length > 0) lines.push(`Actions: ${access.join(", ")}`);
	const liveControllerResolution = resolveLiveTaskControllerForRun(run, selectedStep);
	if (liveControllerResolution.controller) {
		const liveInfo = await readLiveTaskRuntimeInfo(liveControllerResolution.controller);
		lines.push(
			`Live controller: ${liveInfo.transport} · ${liveInfo.status} · streaming:${liveInfo.isStreaming ? "yes" : "no"} · queued:${liveInfo.pendingSteeringCount}/${liveInfo.pendingFollowUpCount}`,
		);
		if (liveInfo.sessionName) lines.push(`Live session: ${liveInfo.sessionName}`);
		if (liveInfo.lastActivity) lines.push(`Live activity: ${liveInfo.lastActivity}`);
		if (typeof liveInfo.messageCount === "number") lines.push(`Live messages: ${liveInfo.messageCount}`);
		if (liveInfo.lastAssistantText) lines.push(`Live assistant: ${createTaskPreview(liveInfo.lastAssistantText, 160)}`);
		lines.push(`Steer: /tasks steer ${selectedStep ? selectedStep.snapshot.childSessionId : run.runId} <message>`);
		lines.push("");
		lines.push("Steps:");
	} else if (selectedStep?.status === "running") {
		lines.push(`Live controller: unavailable (${liveControllerResolution.error ?? "not attached"})`);
		lines.push("Steps:");
	} else {
		lines.push("Steps:");
	}
	if (selectedStep?.snapshot.persist) {
		lines.push(`Open: /tasks open ${selectedStep.snapshot.childSessionId}`);
		lines.push(`Attach: /tasks attach ${selectedStep.snapshot.childSessionId}`);
		lines.push(`View: /tasks view ${selectedStep.snapshot.childSessionId}`);
	} else if (!selectedStep && run.persistedStepCount > 0) {
		lines.push(`Open: /tasks open ${run.runId}`);
		lines.push(`Attach: /tasks attach ${run.runId}`);
		lines.push(`View: /tasks view ${run.runId}`);
	}
	if (originTarget) {
		lines.push(`Origin: /tasks origin ${selectedStep ? selectedStep.snapshot.childSessionId : run.runId}`);
	}
	for (const step of run.steps) {
		const marker = selectedStep?.step === step.step ? "*" : "-";
		const childShort = step.snapshot.childSessionId.slice(0, 8);
		const persistLabel = step.snapshot.persist ? "persisted" : "not-persisted";
		lines.push(`${marker} ${step.step}. ${step.status} · ${persistLabel} · session ${childShort} · ${step.snapshot.effectiveContext}`);
		lines.push(`   path: ${step.snapshot.childSessionPath ? shortenHomePath(step.snapshot.childSessionPath) : "(missing)"}`);
		if (step.snapshot.childSessionName) lines.push(`   name: ${step.snapshot.childSessionName}`);
		if (step.snapshot.parentSessionPath) lines.push(`   parent: ${shortenHomePath(step.snapshot.parentSessionPath)}`);
		const terminalAttachment = getTaskTerminalAttachment(step.snapshot);
		if (terminalAttachment) {
			lines.push(`   terminal: ${formatTaskTerminalAttachment(terminalAttachment)}`);
		}
		if (step.snapshot.taskPreview) lines.push(`   task: ${step.snapshot.taskPreview}`);
		for (const warning of step.warnings) lines.push(`   warning: ${warning}`);
	}
	if (run.warnings.length > 0) {
		lines.push("Warnings:");
		for (const warning of run.warnings) lines.push(`- ${warning}`);
	}
	return lines.join("\n");
}

function extractToolCallNames(message: Message): string[] {
	const content = Array.isArray(message.content) ? message.content : [];
	return content
		.filter((part): part is { type: "toolCall"; name: string } => isRecord(part) && part.type === "toolCall" && typeof part.name === "string")
		.map((part) => part.name);
}

function formatTranscriptPreviewLine(message: Message): string {
	const preview = extractMessagePreviewText(message) ?? (() => {
		const toolCallNames = extractToolCallNames(message);
		if (toolCallNames.length > 0) return `tool calls: ${toolCallNames.join(", ")}`;
		return "(no text)";
	})();
	return `${message.role}: ${createTaskPreview(preview, 180)}`;
}

function extractMessagesFromSessionEntries(entries: readonly SessionEntry[]): Message[] {
	const messages: Message[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !isRecord(entry.message) || typeof entry.message.role !== "string") continue;
		messages.push(entry.message as Message);
	}
	return messages;
}

function readSessionEntriesFromFile(sessionPath: string): SessionEntry[] {
	const raw = fs.readFileSync(sessionPath, "utf-8");
	return raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as SessionEntry);
}

async function readTaskTranscriptPreview(run: TaskRunView, selectedStep?: TaskRunStepView): Promise<TaskTranscriptPreview> {
	const inspectStep = selectTaskRunStepForInspect(run, selectedStep);
	if (!inspectStep) {
		return { lines: ["No task steps available."], sourceLabel: "none", truncated: false };
	}
	const controller = getLiveTaskController(makeTaskRunStepKey(run.runId, inspectStep.step));
	if (controller?.status === "running" && controller.transport === "rpc") {
		try {
			const response = await sendLiveTaskRpcCommand(controller, { type: "get_messages" });
			if (response.success !== false && isRecord(response.data) && Array.isArray(response.data.messages)) {
				const messages = response.data.messages as Message[];
				const truncated = messages.length > 12;
				return {
					lines: messages.slice(-12).map(formatTranscriptPreviewLine),
					sourceLabel: "live rpc",
					truncated,
				};
			}
		} catch (error) {
			return {
				lines: ["Live transcript unavailable."],
				sourceLabel: "live rpc",
				truncated: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
	if (!inspectStep.snapshot.childSessionPath || !fs.existsSync(inspectStep.snapshot.childSessionPath)) {
		return {
			lines: ["Persisted transcript file is unavailable."],
			sourceLabel: "persisted session",
			truncated: false,
		};
	}
	try {
		const entries = readSessionEntriesFromFile(inspectStep.snapshot.childSessionPath);
		const messages = extractMessagesFromSessionEntries(entries);
		const truncated = messages.length > 12;
		return {
			lines: messages.slice(-12).map(formatTranscriptPreviewLine),
			sourceLabel: "persisted session",
			truncated,
		};
	} catch (error) {
		return {
			lines: ["Failed to read persisted transcript."],
			sourceLabel: "persisted session",
			truncated: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

interface TaskUiChromeSink {
	hasUI?: boolean;
	ui?: {
		setWidget?: (...args: unknown[]) => void;
		setStatus?: (...args: unknown[]) => void;
		theme?: { fg?: (color: any, text: string) => string; bold?: (text: string) => string };
	};
}

interface TaskUiChromeContext extends TaskUiChromeSink {
	sessionManager: { getBranch(): readonly SessionEntry[]; getSessionFile?: () => string | undefined; getSessionId?: () => string | undefined };
}

interface TaskWidgetSummary {
	totalRuns: number;
	runningRuns: number;
	runs: TaskRunView[];
}

function getTaskWidgetSessionKey(ctx: { sessionManager?: { getSessionFile?: () => string | undefined; getSessionId?: () => string | undefined } }): string | undefined {
	const sessionFile = ctx.sessionManager?.getSessionFile?.();
	if (typeof sessionFile === "string" && sessionFile.trim()) {
		return `file:${normalizeSessionPathForComparison(sessionFile)}`;
	}
	const sessionId = ctx.sessionManager?.getSessionId?.();
	if (typeof sessionId === "string" && sessionId.trim()) {
		return `id:${sessionId.trim()}`;
	}
	return undefined;
}

function isTaskWidgetEnabled(ctx: { sessionManager?: { getSessionFile?: () => string | undefined; getSessionId?: () => string | undefined } }): boolean {
	const sessionKey = getTaskWidgetSessionKey(ctx);
	return sessionKey ? taskWidgetEnabledSessions.has(sessionKey) : false;
}

function setTaskWidgetEnabled(
	ctx: { sessionManager?: { getSessionFile?: () => string | undefined; getSessionId?: () => string | undefined } },
	enabled: boolean,
): boolean {
	const sessionKey = getTaskWidgetSessionKey(ctx);
	if (!sessionKey) return false;
	if (enabled) taskWidgetEnabledSessions.add(sessionKey);
	else taskWidgetEnabledSessions.delete(sessionKey);
	return true;
}

function buildTaskWidgetSummary(runs: TaskRunView[]): TaskWidgetSummary {
	const activeRuns = runs.filter((run) => run.status === "running");
	return {
		totalRuns: runs.length,
		runningRuns: activeRuns.length,
		runs: [...activeRuns].sort((left, right) => toMillis(right.updatedAt) - toMillis(left.updatedAt)),
	};
}

function buildTaskWidgetLines(
	summary: TaskWidgetSummary,
	style?: { fg?: (color: any, text: string) => string; bold?: (text: string) => string },
): string[] {
	const fg = typeof style?.fg === "function" ? style.fg.bind(style) : ((_color: any, text: string) => text);
	const bold = typeof style?.bold === "function" ? style.bold.bind(style) : ((text: string) => text);
	const lines = [fg("toolTitle", bold(themeIndependentTaskBrowserHeading(summary.runningRuns)))];
	if (summary.totalRuns === 0) {
		lines.push(fg("muted", TASKS_NO_CURRENT_RUNS_MESSAGE));
		lines.push(fg("dim", "Use /tasks or Ctrl+Shift+T to browse · /tasks toggle hide"));
		return lines;
	}
	if (summary.runningRuns === 0) {
		lines.push(fg("muted", "No active task runs in current session."));
		lines.push(fg("dim", `Hidden non-active runs: ${summary.totalRuns}`));
		lines.push(fg("dim", "Use /tasks or Ctrl+Shift+T to browse · /tasks toggle hide"));
		return lines;
	}
	for (const [index, run] of summary.runs.entries()) {
		const data = getTaskRunSummaryData(run, index + 1, false);
		const statusColor = data.status === "running" ? "warning" : data.status === "succeeded" ? "success" : "error";
		const parts = [
			fg("muted", `${data.index}.`),
			fg(statusColor, `${data.status}${data.hasLiveController ? "/live" : ""}`),
			fg("accent", data.runId),
			fg("muted", "·"),
			fg("dim", data.mode),
			fg("muted", "·"),
			fg("dim", `${data.stepCount} ${data.stepLabel}`),
			fg("muted", "·"),
			fg("dim", data.updatedAt),
		];
		if (data.access.length > 0) parts.push(fg("muted", `· ${data.access.join(",")}`));
		if (data.attachHint) parts.push(fg("dim", `· ${data.attachHint}`));
		if (data.originPreview) parts.push(fg("dim", `· ${createTaskPreview(data.originPreview, 80)}`));
		if (data.warningCount > 0) parts.push(fg("warning", `· warnings:${data.warningCount}`));
		lines.push(parts.join(" "));
	}
	if (summary.totalRuns > summary.runningRuns) {
		lines.push(fg("dim", `Hidden non-active runs: ${summary.totalRuns - summary.runningRuns}`));
	}
	lines.push(fg("dim", "Use /tasks or Ctrl+Shift+T to interact · /tasks toggle hide"));
	return lines;
}

function clearTaskUiChrome(ctx: TaskUiChromeSink): void {
	if (!ctx.hasUI || !ctx.ui) return;
	if (typeof ctx.ui.setWidget === "function") {
		ctx.ui.setWidget("tasks.runs", undefined);
	}
	if (typeof ctx.ui.setStatus === "function") {
		ctx.ui.setStatus("tasks.runs", undefined);
	}
}

function syncTaskUiChrome(ctx: TaskUiChromeContext): void {
	if (!ctx.hasUI || !ctx.ui) return;
	if (!isTaskWidgetEnabled(ctx)) {
		clearTaskUiChrome(ctx);
		return;
	}
	const runs = reconstructCurrentTaskRuns({
		entries: ctx.sessionManager.getBranch(),
		sourceSessionFile: ctx.sessionManager.getSessionFile?.(),
		customType: TASK_CHILD_SESSION_CUSTOM_TYPE,
		metadataVersion: TASK_CHILD_SESSION_METADATA_VERSION,
		extraLiveStepKeys: collectLiveTaskControllerStepKeys(ctx.sessionManager.getSessionFile?.()),
	});
	if (typeof ctx.ui.setWidget === "function") {
		ctx.ui.setWidget("tasks.runs", buildTaskWidgetLines(buildTaskWidgetSummary(runs), ctx.ui.theme), {
			placement: "aboveEditor",
		});
	}
	if (typeof ctx.ui.setStatus === "function") {
		ctx.ui.setStatus("tasks.runs", undefined);
	}
}

async function withTaskWidgetTemporarilyHidden<T>(
	ctx: TaskUiChromeContext,
	action: () => Promise<T>,
): Promise<T> {
	const wasEnabled = isTaskWidgetEnabled(ctx);
	if (wasEnabled) {
		setTaskWidgetEnabled(ctx, false);
		clearTaskUiChrome(ctx);
	}
	try {
		return await action();
	} finally {
		if (wasEnabled) {
			setTaskWidgetEnabled(ctx, true);
			syncTaskUiChrome(ctx);
		}
	}
}

function selectTaskRunStepForOpen(run: TaskRunView, preferredStep?: TaskRunStepView): TaskRunStepView | undefined {
	if (preferredStep) return preferredStep;
	const persistedSteps = run.steps.filter((step) => step.snapshot.persist);
	if (persistedSteps.length === 0) return undefined;
	return persistedSteps.sort((left, right) => {
		if (right.step !== left.step) return right.step - left.step;
		return toMillis(getSnapshotEventTimestamp(right.snapshot)) - toMillis(getSnapshotEventTimestamp(left.snapshot));
	})[0];
}

function selectTaskRunStepForInspect(run: TaskRunView, preferredStep?: TaskRunStepView): TaskRunStepView | undefined {
	if (preferredStep) return preferredStep;
	const running = run.steps.filter((step) => step.status === "running");
	if (running.length > 0) {
		return running.sort((left, right) => {
			if (right.step !== left.step) return right.step - left.step;
			return toMillis(getSnapshotEventTimestamp(right.snapshot)) - toMillis(getSnapshotEventTimestamp(left.snapshot));
		})[0];
	}
	return [...run.steps].sort((left, right) => {
		if (right.step !== left.step) return right.step - left.step;
		return toMillis(getSnapshotEventTimestamp(right.snapshot)) - toMillis(getSnapshotEventTimestamp(left.snapshot));
	})[0];
}

function manualTaskSessionOpenInstruction(sessionPath: string): string {
	return [
		`Child session path: ${shortenHomePath(sessionPath)}`,
		`Open manually via /resume, or run: pi --session "${sessionPath}"`,
	].join("\n");
}

function manualParentSessionOpenInstruction(sessionPath: string): string {
	return [
		`Parent session path: ${shortenHomePath(sessionPath)}`,
		`Open manually via /resume, or run: pi --session "${sessionPath}"`,
	].join("\n");
}

function canPersistTaskSnapshotUpdate(
	currentSessionFile: string | undefined,
	run: TaskRunView,
): boolean {
	if (!currentSessionFile || !run.sourceSessionFile) return false;
	return normalizeSessionPathForComparison(currentSessionFile) === normalizeSessionPathForComparison(run.sourceSessionFile);
}

async function attachTaskRunInTerminal(
	ctx: {
		sessionManager: { getSessionFile?: () => string | undefined; appendCustomEntry(customType: string, data?: unknown): string };
	},
	run: TaskRunView,
	preferredStep?: TaskRunStepView,
): Promise<{ ok: boolean; level: "info" | "warning" | "error"; message: string }> {
	const targetStep = selectTaskRunStepForOpen(run, preferredStep);
	if (!targetStep) {
		return { ok: false, level: "error", message: `Run ${run.runId} has no persisted child session to attach.` };
	}
	if (!targetStep.snapshot.persist) {
		return { ok: false, level: "error", message: `Run ${run.runId} step ${targetStep.step} is not persisted and cannot be attached.` };
	}
	const childSessionPath = targetStep.snapshot.childSessionPath;
	if (!childSessionPath.trim()) {
		return {
			ok: false,
			level: "error",
			message: `Run ${run.runId} step ${targetStep.step} has missing child session path metadata (stale metadata).`,
		};
	}
	if (!fs.existsSync(childSessionPath)) {
		return {
			ok: false,
			level: "error",
			message: `Run ${run.runId} step ${targetStep.step} child session is missing: ${shortenHomePath(childSessionPath)}.`,
		};
	}

	const liveController = getLiveTaskController(makeTaskRunStepKey(run.runId, targetStep.step));
	const existingAttachment = getTaskTerminalAttachment(targetStep.snapshot);
	const isRunning = liveController?.status === "running";
	if (isRunning && !existingAttachment) {
		return {
			ok: false,
			level: "warning",
			message:
				`Run ${run.runId} step ${targetStep.step} is running under an internal controller, not an external terminal. ` +
				`Use /tasks steer ${targetStep.snapshot.childSessionId} <message> or wait for completion before attaching.`,
		};
	}

	if (isRunning && existingAttachment) {
		const backendResolution = await resolveTaskTerminalBackendById(existingAttachment.backend);
		if (!backendResolution.backend) {
			return {
				ok: false,
				level: "error",
				message: backendResolution.reason ?? `Backend ${existingAttachment.backend} is unavailable for a running task.`,
			};
		}
		const focusResult = await backendResolution.backend.focus(existingAttachment);
		if (focusResult.ok) {
			return {
				ok: true,
				level: "info",
				message: `Focused running task in ${formatTaskTerminalAttachment(existingAttachment)} for run ${run.runId} step ${targetStep.step}.`,
			};
		}
		return {
			ok: false,
			level: "error",
			message: focusResult.error ?? `Could not focus ${formatTaskTerminalAttachment(existingAttachment)}.`,
		};
	}

	const backendResolution = await resolveConfiguredTaskTerminalBackend();
	if (!backendResolution.backend) {
		return { ok: false, level: "warning", message: backendResolution.reason ?? "No task terminal backend is available." };
	}
	const title = `task ${run.runId} step ${targetStep.step}`;
	const workspace = buildTaskSessionWorkspaceName(run, targetStep);
	const invocation = getPiInvocation(["--session", childSessionPath]);
	const launchResult = await backendResolution.backend.openSession({
		sessionPath: childSessionPath,
		cwd: path.dirname(childSessionPath),
		title,
		workspace,
		command: invocation.command,
		args: invocation.args,
	});
	if (!launchResult.ok || !launchResult.attachment) {
		return {
			ok: false,
			level: "error",
			message: launchResult.error ?? `Failed to attach run ${run.runId} in ${backendResolution.backend.displayName}.`,
		};
	}

	const currentSessionFile = ctx.sessionManager.getSessionFile?.();
	if (canPersistTaskSnapshotUpdate(currentSessionFile, run)) {
		appendTaskChildSessionMetadata(ctx.sessionManager, applyTaskTerminalAttachment(targetStep.snapshot, launchResult.attachment));
	}

	return {
		ok: true,
		level: "info",
		message:
			`Opened run ${run.runId} step ${targetStep.step} in ${backendResolution.backend.displayName} ` +
			`(${formatTaskTerminalAttachment(launchResult.attachment)}). Workspace: ${workspace}. It should open as a new tab in that session workspace. Session: ${shortenHomePath(childSessionPath)}`,
	};
}

async function openTaskRunSession(
	ctx: unknown,
	run: TaskRunView,
	preferredStep?: TaskRunStepView,
): Promise<{ ok: boolean; opened?: boolean; level: "info" | "warning" | "error"; message?: string }> {
	const targetStep = selectTaskRunStepForOpen(run, preferredStep);
	if (!targetStep) {
		return { ok: false, level: "error", message: `Run ${run.runId} has no persisted child session to open.` };
	}
	if (!targetStep.snapshot.persist) {
		return { ok: false, level: "error", message: `Run ${run.runId} step ${targetStep.step} is not persisted and cannot be opened.` };
	}
	const childSessionPath = targetStep.snapshot.childSessionPath;
	if (!childSessionPath.trim()) {
		return {
			ok: false,
			level: "error",
			message: `Run ${run.runId} step ${targetStep.step} has missing child session path metadata (stale metadata).`,
		};
	}
	if (!fs.existsSync(childSessionPath)) {
		return {
			ok: false,
			level: "error",
			message: `Run ${run.runId} step ${targetStep.step} child session is missing: ${shortenHomePath(childSessionPath)}.`,
		};
	}

	let openedMessage = `Opened run ${run.runId} step ${targetStep.step} (${targetStep.snapshot.childSessionId.slice(0, 8)}).`;
	if (!preferredStep && run.persistedStepCount > 1) {
		openedMessage += " Use a child session id prefix selector to open a different step.";
	}

	const openResult = await tryOpenTaskSession(ctx, childSessionPath, {
		targetSessionId: targetStep.snapshot.childSessionId,
		withSession: async (replacementCtx) => {
			await notifyTaskSessionOpened(replacementCtx, openedMessage);
		},
	});
	if (openResult.opened) {
		return { ok: true, opened: true, level: "info" };
	}
	return {
		ok: false,
		level: "warning",
		message: `${openResult.message}\n${manualTaskSessionOpenInstruction(childSessionPath)}`,
	};
}

async function sendTaskSteeringMessage(
	run: TaskRunView,
	preferredStep: TaskRunStepView | undefined,
	message: string,
): Promise<{ ok: boolean; level: "info" | "warning" | "error"; message: string }> {
	const controllerResolution = resolveLiveTaskControllerForRun(run, preferredStep);
	if (!controllerResolution.controller) {
		return { ok: false, level: "error", message: controllerResolution.error ?? `Run ${run.runId} is not steerable right now.` };
	}
	try {
		const response = await sendLiveTaskRpcCommand(controllerResolution.controller, { type: "steer", message });
		if (response.success === false) {
			return {
				ok: false,
				level: "error",
				message: response.error ?? `Task ${run.runId} rejected the steering message.`,
			};
		}
		return {
			ok: true,
			level: "info",
			message: `Steering sent to run ${run.runId}${preferredStep ? ` step ${preferredStep.step}` : ""}.`,
		};
	} catch (error) {
		return {
			ok: false,
			level: "error",
			message: `Failed to steer run ${run.runId}${preferredStep ? ` step ${preferredStep.step}` : ""}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

async function buildTaskViewerOverlayState(
	scope: TasksScope,
	run: TaskRunView,
	preferredStep?: TaskRunStepView,
): Promise<{ overlayState: TaskViewerOverlayState; step?: TaskRunStepView }> {
	const inspectStep = selectTaskRunStepForInspect(run, preferredStep);
	const detailText = await formatTaskRunDetails(scope, run, inspectStep);
	const transcript = await readTaskTranscriptPreview(run, inspectStep);
	const access = describeTaskRunAccess(run, inspectStep);
	return {
		overlayState: {
			runId: run.runId,
			runStatus: run.status,
			runMode: run.mode,
			detailText,
			transcript,
			canOpen: access.includes("open"),
			canAttach: access.includes("attach"),
			canOrigin: access.includes("origin"),
			canSteer: access.includes("steer"),
			attachActionLabel: getTaskAttachActionLabel(),
		},
		step: inspectStep,
	};
}

async function openTaskViewerOverlay(
	ctx: { hasUI?: boolean; ui: { custom: <T>(factory: any, options?: any) => Promise<T | undefined>; notify(text: string, level?: "info" | "warning" | "error"): void } },
	scope: TasksScope,
	run: TaskRunView,
	preferredStep?: TaskRunStepView,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Task viewer overlay is only available with UI.", "warning");
		return;
	}
	const state = await buildTaskViewerOverlayState(scope, run, preferredStep);
	const result = await ctx.ui.custom<TaskViewerOverlayResult | undefined>(
		(_tui: unknown, theme: unknown, _keybindings: unknown, done: (value: TaskViewerOverlayResult | undefined) => void) =>
			new TaskViewerOverlay(theme, state.overlayState, done),
		{
			overlay: true,
			overlayOptions: { anchor: "right-center", width: "55%", maxHeight: "85%", margin: 1 },
		},
	);
	if (!result || result.action === "close") return;
	if (result.action === "open") {
		const openResult = await openTaskRunSession(ctx, run, state.step);
		if (!openResult.opened && openResult.message) ctx.ui.notify(openResult.message, openResult.level);
		return;
	}
	if (result.action === "attach") {
		const attachResult = await attachTaskRunInTerminal(ctx as any, run, state.step);
		ctx.ui.notify(attachResult.message, attachResult.level);
		syncTaskUiChrome(ctx as any);
		return;
	}
	if (result.action === "origin") {
		const originResult = await revealTaskRunOrigin(ctx as any, run, state.step);
		ctx.ui.notify(originResult.message, originResult.level);
		syncTaskUiChrome(ctx as any);
		return;
	}
	if (result.action === "steer" && result.message) {
		const steerResult = await sendTaskSteeringMessage(run, state.step, result.message);
		ctx.ui.notify(steerResult.message, steerResult.level);
		syncTaskUiChrome(ctx as any);
	}
}

async function revealTaskRunOrigin(
	ctx: {
		sessionManager: { getSessionFile?: () => string | undefined };
		navigateTree?: (
			targetId: string,
			options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
		) => Promise<{ editorText?: string; cancelled: boolean }>;
	},
	run: TaskRunView,
	preferredStep?: TaskRunStepView,
): Promise<{ ok: boolean; level: "info" | "warning" | "error"; message: string }> {
	const origin = resolveTaskRunOriginSnapshot(run, preferredStep);
	if (!origin) {
		return { ok: false, level: "error", message: `Run ${run.runId} has no recorded origin metadata.` };
	}
	const targetId = origin.originUserEntryId ?? origin.originEntryId;
	const preview = origin.originPreview ?? "(origin preview unavailable)";
	const currentSessionFile = ctx.sessionManager.getSessionFile?.();
	const sourceSessionFile = run.sourceSessionFile;
	if (
		targetId &&
		typeof ctx.navigateTree === "function" &&
		currentSessionFile &&
		sourceSessionFile &&
		normalizeSessionPathForComparison(currentSessionFile) === normalizeSessionPathForComparison(sourceSessionFile)
	) {
		try {
			const result = await ctx.navigateTree(targetId, { summarize: false, label: "task-origin" });
			if (result.cancelled) {
				return { ok: false, level: "warning", message: `Origin navigation for run ${run.runId} was cancelled.` };
			}
			return {
				ok: true,
				level: "info",
				message: `Moved to origin for run ${run.runId}: ${preview}`,
			};
		} catch (error) {
			return {
				ok: false,
				level: "error",
				message: `Failed to reveal origin for run ${run.runId}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	const lines = [`Origin for run ${run.runId}: ${preview}`];
	if (targetId) lines.push(`Origin entry id: ${targetId}`);
	if (sourceSessionFile) {
		lines.push(`Source session: ${shortenHomePath(sourceSessionFile)}`);
		if (!currentSessionFile || normalizeSessionPathForComparison(currentSessionFile) !== normalizeSessionPathForComparison(sourceSessionFile)) {
			lines.push(`Open manually via /resume, or run: pi --session "${sourceSessionFile}"`);
		}
	}
	return { ok: true, level: "info", message: lines.join("\n") };
}

async function browseTaskRuns(ctx: any, scope: TasksScope, runs: TaskRunView[]): Promise<boolean> {
	if (!ctx.hasUI) return false;
	const runOptions = runs.map((run, index) => formatTaskRunSummary(run, index + 1, false));
	const selectedRunLabel = await ctx.ui.select("Task runs", runOptions);
	if (!selectedRunLabel) return true;
	const selectedRunIndex = runOptions.indexOf(selectedRunLabel);
	if (selectedRunIndex < 0) {
		ctx.ui.notify("Selected task run could not be resolved.", "error");
		return true;
	}
	const selectedRun = runs[selectedRunIndex]!;
	const hasLiveController = selectedRun.steps.some((candidate) => {
		const controller = getLiveTaskController(makeTaskRunStepKey(selectedRun.runId, candidate.step));
		return controller?.status === "running";
	});
	const hasPersistedSteps = selectedRun.steps.some((candidate) => candidate.snapshot.persist);
	const hasOrigin = Boolean(getTaskOriginNavigationTarget(selectedRun) || resolveTaskRunOriginSnapshot(selectedRun)?.originPreview);
	const attachActionLabel = getTaskAttachActionLabel();
	const actionOptions = [
		"Show details",
		"View overlay",
		...(hasPersistedSteps ? ["Open session", attachActionLabel] : []),
		...(hasOrigin ? ["Reveal origin"] : []),
		...(hasLiveController ? ["Steer running task"] : []),
		"Cancel",
	];
	const action = await ctx.ui.select(`Run ${selectedRun.runId}`, actionOptions);
	if (!action || action === "Cancel") return true;
	if (action === "Show details") {
		const hasWarnings = selectedRun.warnings.length > 0 || selectedRun.steps.some((candidate) => candidate.warnings.length > 0);
		ctx.ui.notify(await formatTaskRunDetails(scope, selectedRun), hasWarnings ? "warning" : "info");
		return true;
	}
	if (action === "View overlay") {
		await openTaskViewerOverlay(ctx, scope, selectedRun);
		return true;
	}
	if (action === attachActionLabel) {
		const persistedSteps = selectedRun.steps.filter((candidate) => candidate.snapshot.persist);
		let targetStep = selectTaskRunStepForOpen(selectedRun);
		if (persistedSteps.length > 1) {
			const stepOptions = persistedSteps.map(
				(candidate) =>
					`step ${candidate.step} · ${candidate.status} · ${candidate.snapshot.childSessionId.slice(0, 8)} · ${candidate.snapshot.taskPreview || candidate.snapshot.childSessionName || "persisted"}`,
			);
			const selectedStepLabel = await ctx.ui.select(`Attach run ${selectedRun.runId}`, stepOptions);
			if (!selectedStepLabel) return true;
			const stepIndex = stepOptions.indexOf(selectedStepLabel);
			if (stepIndex < 0) {
				ctx.ui.notify("Selected task step could not be resolved.", "error");
				return true;
			}
			targetStep = persistedSteps[stepIndex];
		}
		const attachResult = await attachTaskRunInTerminal(ctx, selectedRun, targetStep);
		ctx.ui.notify(attachResult.message, attachResult.level);
		syncTaskUiChrome(ctx);
		return true;
	}
	if (action === "Reveal origin") {
		await ctx.waitForIdle();
		const originResult = await revealTaskRunOrigin(ctx, selectedRun);
		ctx.ui.notify(originResult.message, originResult.level);
		syncTaskUiChrome(ctx);
		return true;
	}
	if (action === "Steer running task") {
		const liveSteps = selectedRun.steps.filter((candidate) => {
			const controller = getLiveTaskController(makeTaskRunStepKey(selectedRun.runId, candidate.step));
			return controller?.status === "running";
		});
		let selectedStep = liveSteps[0];
		if (liveSteps.length > 1) {
			const stepOptions = liveSteps.map(
				(candidate) =>
					`step ${candidate.step} · ${candidate.snapshot.childSessionId.slice(0, 8)} · ${candidate.snapshot.taskPreview || candidate.snapshot.childSessionName || "running"}`,
			);
			const selectedStepLabel = await ctx.ui.select(`Steer run ${selectedRun.runId}`, stepOptions);
			if (!selectedStepLabel) return true;
			const stepIndex = stepOptions.indexOf(selectedStepLabel);
			if (stepIndex < 0) {
				ctx.ui.notify("Selected task step could not be resolved.", "error");
				return true;
			}
			selectedStep = liveSteps[stepIndex];
		}
		if (!selectedStep) {
			ctx.ui.notify(`Run ${selectedRun.runId} has no running live step to steer.`, "error");
			return true;
		}
		const message = await ctx.ui.input(`Steer run ${selectedRun.runId} step ${selectedStep.step}`, "");
		if (!message?.trim()) return true;
		const steerResult = await sendTaskSteeringMessage(selectedRun, selectedStep, message);
		ctx.ui.notify(steerResult.message, steerResult.level);
		syncTaskUiChrome(ctx);
		return true;
	}
	const persistedSteps = selectedRun.steps.filter((candidate) => candidate.snapshot.persist);
	let targetStep = selectTaskRunStepForOpen(selectedRun);
	if (persistedSteps.length > 1) {
		const stepOptions = persistedSteps.map(
			(candidate) =>
				`step ${candidate.step} · ${candidate.status} · ${candidate.snapshot.childSessionId.slice(0, 8)} · ${candidate.snapshot.taskPreview || candidate.snapshot.childSessionName || "persisted"}`,
		);
		const selectedStepLabel = await ctx.ui.select(`Open run ${selectedRun.runId}`, stepOptions);
		if (!selectedStepLabel) return true;
		const stepIndex = stepOptions.indexOf(selectedStepLabel);
		if (stepIndex < 0) {
			ctx.ui.notify("Selected task step could not be resolved.", "error");
			return true;
		}
		targetStep = persistedSteps[stepIndex];
	}
	const openResult = await openTaskRunSession(ctx, selectedRun, targetStep);
	if (!openResult.opened) {
		if (openResult.message) ctx.ui.notify(openResult.message, openResult.level);
		syncTaskUiChrome(ctx);
	}
	return true;
}

type TaskSessionWithSessionCallback = (ctx: unknown) => Promise<void> | void;

interface TryOpenTaskSessionOptions {
	withSession?: TaskSessionWithSessionCallback;
	targetSessionId?: string;
}

interface SessionIdentity {
	sessionPath?: string;
	sessionId?: string;
}

async function notifyTaskSessionOpened(ctx: unknown, message: string): Promise<void> {
	if (!isRecord(ctx)) return;
	const ui = isRecord(ctx.ui) ? ctx.ui : undefined;
	const notify = ui?.notify;
	if (typeof notify !== "function") return;
	await Promise.resolve((notify as (text: string, level?: "info" | "warning" | "error") => unknown).call(ui, message, "info"));
}

function normalizeSessionPathForComparison(filePath: string): string {
	const resolved = path.resolve(filePath);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		try {
			return fs.realpathSync(resolved);
		} catch {
			return resolved;
		}
	}
}

function readSessionIdentity(ctx: unknown): SessionIdentity {
	if (!isRecord(ctx)) return {};

	const pickString = (value: unknown): string | undefined => {
		if (typeof value !== "string") return undefined;
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	};

	const identity: SessionIdentity = {
		sessionPath: pickString(ctx.sessionFile) ?? pickString(ctx.sessionPath) ?? pickString(ctx.path),
		sessionId: pickString(ctx.sessionId) ?? pickString(ctx.id),
	};

	const session = isRecord(ctx.session) ? ctx.session : undefined;
	if (session) {
		identity.sessionPath = identity.sessionPath ?? pickString(session.file) ?? pickString(session.path);
		identity.sessionId = identity.sessionId ?? pickString(session.id);
	}

	const sessionManager = isRecord(ctx.sessionManager) ? ctx.sessionManager : undefined;
	if (sessionManager) {
		if (!identity.sessionPath) {
			const getSessionFile = sessionManager.getSessionFile;
			if (typeof getSessionFile === "function") {
				try {
					identity.sessionPath = pickString((getSessionFile as () => unknown).call(sessionManager));
				} catch {
					// Ignore reflective accessor failures.
				}
			}
			identity.sessionPath = identity.sessionPath ?? pickString(sessionManager.sessionFile) ?? pickString(sessionManager.path);
		}
		if (!identity.sessionId) {
			const getSessionId = sessionManager.getSessionId;
			if (typeof getSessionId === "function") {
				try {
					identity.sessionId = pickString((getSessionId as () => unknown).call(sessionManager));
				} catch {
					// Ignore reflective accessor failures.
				}
			}
			identity.sessionId = identity.sessionId ?? pickString(sessionManager.sessionId) ?? pickString(sessionManager.id);
		}
	}

	return identity;
}

function sessionIdentityMatchesTarget(identity: SessionIdentity, targetPath: string, targetSessionId?: string): boolean {
	if (identity.sessionPath) {
		const candidatePath = normalizeSessionPathForComparison(identity.sessionPath);
		if (candidatePath === targetPath) return true;
	}
	if (identity.sessionId && targetSessionId) {
		const candidateId = identity.sessionId.trim();
		const expectedId = targetSessionId.trim();
		if (candidateId && expectedId && (candidateId === expectedId || candidateId.startsWith(expectedId) || expectedId.startsWith(candidateId))) {
			return true;
		}
	}
	return false;
}

function isExplicitSessionOpenSuccess(result: unknown): boolean {
	if (result === true) return true;
	if (!isRecord(result)) return false;
	if (result.cancelled === true || result.canceled === true) return false;
	if (result.opened === true || result.ok === true || result.success === true || result.switched === true || result.resumed === true) {
		return true;
	}
	if (typeof result.status === "string") {
		const status = result.status.toLowerCase();
		if (status === "opened" || status === "ok" || status === "success" || status === "switched" || status === "resumed") {
			return true;
		}
	}
	return false;
}

async function tryOpenTaskSession(
	ctx: unknown,
	sessionPath: string,
	options: TryOpenTaskSessionOptions = {},
): Promise<{ opened: boolean; message: string }> {
	if (!isRecord(ctx)) {
		return { opened: false, message: "Session switching is unavailable in this extension context." };
	}

	const descriptors: Array<{ owner: Record<string, unknown>; key: string; supportsOptionsArg: boolean }> = [
		{ owner: ctx, key: "openSession", supportsOptionsArg: true },
		{ owner: ctx, key: "resumeSession", supportsOptionsArg: true },
		{ owner: ctx, key: "switchSession", supportsOptionsArg: true },
	];
	const sessionManager = isRecord(ctx.sessionManager) ? ctx.sessionManager : undefined;
	if (sessionManager) {
		descriptors.push({ owner: sessionManager, key: "openSession", supportsOptionsArg: true });
		descriptors.push({ owner: sessionManager, key: "resumeSession", supportsOptionsArg: true });
		descriptors.push({ owner: sessionManager, key: "switchSession", supportsOptionsArg: true });
		descriptors.push({ owner: sessionManager, key: "open", supportsOptionsArg: false });
	}
	let attempted = false;
	let lastError: string | undefined;
	const targetPath = normalizeSessionPathForComparison(sessionPath);

	for (const descriptor of descriptors) {
		const fn = descriptor.owner[descriptor.key];
		if (typeof fn !== "function") continue;
		attempted = true;

		let openedWithVerifiedReplacementCtx = false;
		const withSessionCallback: TaskSessionWithSessionCallback = async (replacementCtx) => {
			const replacementIdentity = readSessionIdentity(replacementCtx);
			if (!sessionIdentityMatchesTarget(replacementIdentity, targetPath, options.targetSessionId)) return;
			openedWithVerifiedReplacementCtx = true;
			await options.withSession?.(replacementCtx);
		};

		const argsToTry: unknown[][] = [];
		if (descriptor.supportsOptionsArg) {
			argsToTry.push([sessionPath, { withSession: withSessionCallback }]);
		}
		argsToTry.push([sessionPath]);

		for (const args of argsToTry) {
			try {
				const result = await Promise.resolve((fn as (...fnArgs: unknown[]) => unknown).call(descriptor.owner, ...args));
				if (openedWithVerifiedReplacementCtx || isExplicitSessionOpenSuccess(result)) {
					return { opened: true, message: `Opened target session via ${descriptor.key}.` };
				}
				if (isRecord(result) && (result.cancelled === true || result.canceled === true)) {
					return { opened: false, message: "Session open canceled." };
				}
				if (result === false) continue;
			} catch (error) {
				if (openedWithVerifiedReplacementCtx) {
					return { opened: true, message: `Opened target session via ${descriptor.key}.` };
				}
				lastError = error instanceof Error ? error.message : String(error);
			}
		}
	}

	if (!attempted) {
		return { opened: false, message: "Session switching is unavailable in this extension context." };
	}
	return {
		opened: false,
		message: lastError ? `Failed to open target session automatically: ${lastError}` : "Failed to open target session automatically.",
	};
}

const ContextModeSchema = StringEnum(["fresh", "fork"] as const, {
	description: 'Runtime context mode shorthand. "fresh" starts a fresh worker context, "fork" creates a persisted child session forked from the parent snapshot.',
});

const TaskItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the role agent to invoke" })),
	profile: Type.Optional(Type.String({ description: "Capability profile to apply" })),
	effort: Type.Optional(Type.String({ description: "Named effort override for this task step" })),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(Type.String({ description: "Exact model override for this task step" })),
	skills: Type.Optional(Type.Array(Type.String(), { description: "Explicit skill names to load for this task step" })),
	prompt: Type.Optional(Type.String({ description: "Additional system prompt appended after the agent/profile prompts" })),
	context: Type.Optional(ContextModeSchema),
});

const ChainItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the role agent to invoke" })),
	profile: Type.Optional(Type.String({ description: "Capability profile to apply" })),
	effort: Type.Optional(Type.String({ description: "Named effort override for this task step" })),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(Type.String({ description: "Exact model override for this task step" })),
	skills: Type.Optional(Type.Array(Type.String(), { description: "Explicit skill names to load for this task step" })),
	prompt: Type.Optional(Type.String({ description: "Additional system prompt appended after the agent/profile prompts" })),
	context: Type.Optional(ContextModeSchema),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the role agent to invoke (for single mode)" })),
	profile: Type.Optional(Type.String({ description: "Capability profile to apply (for single mode)" })),
	effort: Type.Optional(Type.String({ description: "Named effort override for single mode" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	model: Type.Optional(Type.String({ description: "Exact model override for single mode" })),
	skills: Type.Optional(Type.Array(Type.String(), { description: "Explicit skill names to load for single mode" })),
	prompt: Type.Optional(Type.String({ description: "Additional system prompt appended after the profile/agent prompts for single mode" })),
	context: Type.Optional(ContextModeSchema),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of task steps for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of task steps for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local role agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	const normalizeMainAgentSelection = (value: unknown): string | undefined => {
		if (typeof value !== "string") return undefined;
		const trimmed = value.trim();
		if (!trimmed) return undefined;
		if (/^(default|none|clear|off)$/i.test(trimmed)) return undefined;
		return trimmed;
	};

	pi.registerFlag("agent", {
		description: "Main-session role agent to use (must have availability: main or both)",
		type: "string",
		default: "",
	});
	pi.registerFlag("profile", {
		description: "Main-session capability profile to use",
		type: "string",
		default: "",
	});
	pi.registerFlag("effort", {
		description: "Main-session effort preset to use",
		type: "string",
		default: "",
	});
	pi.registerFlag("profile-name", {
		description: "Profile name to use for permissions (overrides PI_PROFILE_NAME env var)",
		type: "string",
		default: "",
	});

	pi.on("session_start", async (_event, ctx) => {
		ensureMainSessionBaseline(ctx, pi);
		syncTaskUiChrome(ctx);
		startupCompositionError = undefined;
		const rawCliAgent = pi.getFlag("agent");
		const rawCliProfile = pi.getFlag("profile");
		const rawCliEffort = pi.getFlag("effort");
		const hasCliSelection = [rawCliAgent, rawCliProfile, rawCliEffort].some(
			(value) => typeof value === "string" && value.trim().length > 0,
		);
		const cliSelection = {
			agent: normalizeMainAgentSelection(rawCliAgent),
			profile: normalizeMainAgentSelection(rawCliProfile),
			effort: normalizeMainAgentSelection(rawCliEffort),
		};
		const persisted = getPersistedMainAgentState(ctx.sessionManager.getBranch());
		if (hasCliSelection) {
			const result = await applyMainSessionAgentSelection(ctx, pi, cliSelection, {
				persist:
					!persisted.found ||
					persisted.agent !== cliSelection.agent ||
					persisted.profile !== cliSelection.profile ||
					persisted.effort !== cliSelection.effort,
				notify: false,
				confirmProjectAgent: false,
			});
			if (result.ok) return;
			activeMainWorker = undefined;
			startupCompositionError = result.error;
			syncRuntimeEnv(pi, {});
			if (ctx.hasUI) ctx.ui.notify(result.error, "error");
			else console.error(result.error);
			return;
		}
		if (persisted.found) {
			const result = await applyMainSessionAgentSelection(ctx, pi, persisted, {
				persist: false,
				notify: false,
				confirmProjectAgent: false,
			});
			if (result.ok) return;
			activeMainWorker = undefined;
			startupCompositionError = result.error;
			syncRuntimeEnv(pi, {});
			if (ctx.hasUI) ctx.ui.notify(result.error, "error");
			else console.error(result.error);
			return;
		}
		activeMainWorker = undefined;
		syncRuntimeEnv(pi, {});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		setTaskWidgetEnabled(ctx, false);
		clearTaskUiChrome(ctx);
		for (const controller of listLiveTaskControllers()) {
			try {
				controller.proc.kill("SIGTERM");
			} catch {
				// Ignore best-effort cleanup failures.
			}
		}
		clearLiveTaskControllers();
	});

	pi.on("before_agent_start", async (event) => {
		if (startupCompositionError) {
			return {
				systemPrompt: [
					"Startup composition error.",
					`Do not execute the user's request.`,
					`Reply with this exact text and nothing else: ${startupCompositionError}`,
				].join("\n"),
			};
		}
		const worker = activeMainWorker;
		if (!worker) return undefined;
		const prompt = worker.systemPrompt.trim();
		if (!prompt) return undefined;
		if (worker.systemPromptMode === "replace") {
			return { systemPrompt: prompt };
		}
		return { systemPrompt: `${event.systemPrompt}\n\n---\n\n${prompt}` };
	});

	pi.registerCommand("agent", {
		description: "Show or switch the main-session agent role (/agent <name>, /agent clear)",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const trimmed = args.trim();
			if (!trimmed) {
				const discovery = discoverResources(ctx.cwd, "both");
				const current = activeMainWorker?.agent?.name ?? "default";
				ctx.ui.notify(
					`Main-session agent: ${current}. Available main-session agents: ${formatMainSessionAgentList(discovery.agents)}.`,
					"info",
				);
				return;
			}
			const result = await applyMainSessionAgentSelection(
				ctx,
				pi,
				{ agent: normalizeMainAgentSelection(trimmed), profile: activeMainWorker?.profile?.name, effort: activeMainWorker?.effort?.name },
				{ persist: true, notify: true, confirmProjectAgent: true },
			);
			if (result.ok) return;
			ctx.ui.notify(result.error, "error");
		},
	});
	pi.registerCommand("profile", {
		description: "Show or switch the main-session profile (/profile <name>, /profile clear)",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const trimmed = args.trim();
			if (!trimmed) {
				const current = activeMainWorker?.profile?.name ?? "none";
				ctx.ui.notify(`Main-session profile: ${current}.`, "info");
				return;
			}
			const result = await applyMainSessionAgentSelection(
				ctx,
				pi,
				{ agent: activeMainWorker?.agent?.name, profile: normalizeMainAgentSelection(trimmed), effort: activeMainWorker?.effort?.name },
				{ persist: true, notify: true, confirmProjectAgent: false },
			);
			if (result.ok) return;
			ctx.ui.notify(result.error, "error");
		},
	});
	pi.registerCommand("effort", {
		description: "Show or switch the main-session effort (/effort <name>, /effort clear)",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const trimmed = args.trim();
			if (!trimmed) {
				const current = activeMainWorker?.effort?.name ?? "none";
				ctx.ui.notify(`Main-session effort: ${current}.`, "info");
				return;
			}
			const result = await applyMainSessionAgentSelection(
				ctx,
				pi,
				{ agent: activeMainWorker?.agent?.name, profile: activeMainWorker?.profile?.name, effort: normalizeMainAgentSelection(trimmed) },
				{ persist: true, notify: true, confirmProjectAgent: false },
			);
			if (result.ok) return;
			ctx.ui.notify(result.error, "error");
		},
	});

	pi.registerCommand("tasks", {
		description: `Inspect persisted task child sessions. Usage: ${TASKS_COMMAND_USAGE}`,
		handler: async (args, ctx) => {
			const parsed = parseTasksCommand(args);
			if (parsed.action === "open" || parsed.action === "parent" || parsed.action === "origin") {
				await ctx.waitForIdle();
			}
			if (parsed.error) {
				ctx.ui.notify(`${parsed.error}. Usage: ${TASKS_COMMAND_USAGE}`, "error");
				return;
			}

			if (parsed.action === "toggle") {
				if (!ctx.hasUI) {
					ctx.ui.notify("Task widget toggle is only available with UI.", "warning");
					return;
				}
				const nextEnabled = !isTaskWidgetEnabled(ctx);
				if (!setTaskWidgetEnabled(ctx, nextEnabled)) {
					ctx.ui.notify("Could not resolve the current session identity for /tasks toggle.", "error");
					return;
				}
				syncTaskUiChrome(ctx);
				ctx.ui.notify(nextEnabled ? "Tasks widget enabled for this session." : "Tasks widget hidden for this session.", "info");
				return;
			}

			if (parsed.action === "parent") {
				const currentSessionFile = ctx.sessionManager.getSessionFile?.();
				if (!currentSessionFile) {
					ctx.ui.notify(
						"Current session is not persisted. No parent session can be resolved automatically (detached or non-persisted session).",
						"error",
					);
					return;
				}

				const parentResolution = await resolveParentSessionForCurrentSession(currentSessionFile, ctx.sessionManager.getBranch());
				if (!parentResolution.resolved) {
					const baseMessage = parentResolution.error ?? "Failed to resolve parent session.";
					const guidance = parentResolution.noParent
						? ""
						: "\nIf you know the parent session file, open it via /resume or run: pi --session \"<parent-session-file>\"";
					ctx.ui.notify(`${baseMessage}${guidance}`, "error");
					return;
				}

				const parentSessionPath = parentResolution.resolved.parentSessionPath;
				const normalizedCurrentSessionPath = normalizeSessionPathForComparison(currentSessionFile);
				const normalizedParentSessionPath = normalizeSessionPathForComparison(parentSessionPath);

				if (normalizedParentSessionPath === normalizedCurrentSessionPath) {
					ctx.ui.notify("Resolved parent session points to the current session. Refusing to open the same session file.", "error");
					return;
				}
				if (!fs.existsSync(parentSessionPath)) {
					ctx.ui.notify(
						`Resolved parent session is missing: ${shortenHomePath(parentSessionPath)}.\n${manualParentSessionOpenInstruction(parentSessionPath)}`,
						"error",
					);
					return;
				}

				const openedMessage = "Opened parent session (from child session header).";

				const openResult = await tryOpenTaskSession(ctx as unknown, parentSessionPath, {
					withSession: async (replacementCtx) => {
						await notifyTaskSessionOpened(replacementCtx, openedMessage);
					},
				});
				if (openResult.opened) return;

				ctx.ui.notify(`${openResult.message}\n${manualParentSessionOpenInstruction(parentSessionPath)}`, "warning");
				return;
			}

			const runs = reconstructCurrentTaskRuns({
				entries: ctx.sessionManager.getBranch(),
				sourceSessionFile: ctx.sessionManager.getSessionFile?.(),
				customType: TASK_CHILD_SESSION_CUSTOM_TYPE,
				metadataVersion: TASK_CHILD_SESSION_METADATA_VERSION,
				extraLiveStepKeys: collectLiveTaskControllerStepKeys(ctx.sessionManager.getSessionFile?.()),
			});

			if (runs.length === 0) {
				ctx.ui.notify(TASKS_NO_CURRENT_RUNS_MESSAGE, "info");
				return;
			}

			if (parsed.action === "list") {
				if (await withTaskWidgetTemporarilyHidden(ctx, async () => browseTaskRuns(ctx, parsed.scope, runs))) return;
				ctx.ui.notify(formatTaskRunList(parsed.scope, runs), "info");
				return;
			}

			const selector = parsed.selector?.trim();
			if (!selector) {
				ctx.ui.notify(`Missing selector. Usage: ${TASKS_COMMAND_USAGE}`, "error");
				return;
			}

			const resolved = resolveTaskSelector(selector, runs);
			if (resolved.error || !resolved.resolution) {
				ctx.ui.notify(resolved.error ?? `No task run matches selector "${selector}".`, "error");
				return;
			}

			const { run, step } = resolved.resolution;
			if (parsed.action === "show") {
				const hasWarnings = run.warnings.length > 0 || run.steps.some((candidate) => candidate.warnings.length > 0);
				ctx.ui.notify(await formatTaskRunDetails(parsed.scope, run, step), hasWarnings ? "warning" : "info");
				syncTaskUiChrome(ctx);
				return;
			}
			if (parsed.action === "view") {
				await openTaskViewerOverlay(ctx, parsed.scope, run, step);
				return;
			}
			if (parsed.action === "attach") {
				const attachResult = await attachTaskRunInTerminal(ctx, run, step);
				ctx.ui.notify(attachResult.message, attachResult.level);
				syncTaskUiChrome(ctx);
				return;
			}
			if (parsed.action === "origin") {
				const originResult = await revealTaskRunOrigin(ctx, run, step);
				ctx.ui.notify(originResult.message, originResult.level);
				syncTaskUiChrome(ctx);
				return;
			}
			if (parsed.action === "steer") {
				const message = parsed.message?.trim();
				if (!message) {
					ctx.ui.notify(`Missing steering message. Usage: ${TASKS_COMMAND_USAGE}`, "error");
					return;
				}
				const steerResult = await sendTaskSteeringMessage(run, step, message);
				ctx.ui.notify(steerResult.message, steerResult.level);
				syncTaskUiChrome(ctx);
				return;
			}

			const openResult = await openTaskRunSession(ctx, run, step);
			if (!openResult.opened) {
				if (openResult.message) ctx.ui.notify(openResult.message, openResult.level);
				syncTaskUiChrome(ctx);
			}
		},
	});

	pi.registerShortcut("ctrl+shift+t", {
		description: "Browse task runs in the current session",
		handler: async (ctx) => {
			const runs = reconstructCurrentTaskRuns({
				entries: ctx.sessionManager.getBranch(),
				sourceSessionFile: ctx.sessionManager.getSessionFile?.(),
				customType: TASK_CHILD_SESSION_CUSTOM_TYPE,
				metadataVersion: TASK_CHILD_SESSION_METADATA_VERSION,
				extraLiveStepKeys: collectLiveTaskControllerStepKeys(ctx.sessionManager.getSessionFile?.()),
			});
			if (runs.length === 0) {
				ctx.ui.notify(TASKS_NO_CURRENT_RUNS_MESSAGE, "info");
				return;
			}
			if (await withTaskWidgetTemporarilyHidden(ctx, async () => browseTaskRuns(ctx, "current", runs))) return;
			ctx.ui.notify(formatTaskRunList("current", runs), "info");
		},
	});

	pi.registerTool({
		name: "task",
		label: "Task",
		description: [
			"Delegate work to specialized agents with configurable child-session context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Runtime context override supports only mode shorthand (`context: "fresh" | "fork"`).',
			"Session persistence is config-driven (`persist`) and cannot be overridden at runtime.",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		promptSnippet: "Delegate substantial or parallelizable work to specialized agents.",
		promptGuidelines: [
			"Use `task` when work can be delegated to a focused agent, especially for multi-file changes, independent investigations, or parallelizable subtasks.",
			"Use single mode for one focused delegation, `tasks` for independent work that can run in parallel, and `chain` when later steps depend on earlier output via `{previous}`.",
			"Choose the most specific agent that fits the job, and set `agentScope` to `both` or `project` only when you need project-local agents.",
			"Skip `task` for trivial edits or when direct tool use is simpler than delegation.",
		],
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverResources(ctx.cwd, agentScope);
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const callableAgents = getTaskCallableAgents(discovery);

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.task && (params.agent || params.profile || params.prompt || params.skills?.length));
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			let sessionRunId: string | undefined;
			let sessionRunRoot: string | undefined;
			let childMetadataRunId: string | undefined;
			const makeDetails =
				(mode: TaskExecutionMode) =>
				(results: SingleResult[]): TaskDetails => {
					const childSessions = results.flatMap((stepResult) => (stepResult.childSession ? [stepResult.childSession] : []));
					return {
						mode,
						agentScope,
						projectAgentsDir: discovery.projectAgentsDir,
						results,
						sessionRunId,
						sessionRunRoot,
						toolCallId,
						childSessions: childSessions.length > 0 ? childSessions : undefined,
					};
				};
			const throwTaskError = (message: string, details: TaskDetails): never => {
				const error = new Error(message) as Error & { details?: TaskDetails };
				error.details = details;
				throw error;
			};

			// Recursion depth guard
			const depthCheck = checkSubagentDepth();
			if (depthCheck.blocked) {
				const mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
				throwTaskError(
					`Task depth limit reached (depth ${depthCheck.depth}, max ${depthCheck.maxDepth}). Nested task delegation is blocked to prevent runaway recursion.`,
					makeDetails(mode)([]),
				);
			}

			if (modeCount !== 1) {
				const available = callableAgents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable task agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			const mode: TaskExecutionMode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
			const taskOrigin = resolveTaskOriginForBranch(
				ctx.sessionManager.getBranch(),
				createTaskPreview,
				ctx.sessionManager.getLeafId?.(),
			);
			const stepsToRun: TaskStepConfig[] = [];
			if (params.chain) stepsToRun.push(...params.chain);
			if (params.tasks) stepsToRun.push(...params.tasks);
			if (params.task && (params.agent || params.profile || params.prompt || params.skills?.length)) {
				stepsToRun.push({
					agent: params.agent,
					profile: params.profile,
					effort: params.effort,
					task: params.task,
					cwd: params.cwd,
					model: params.model,
					skills: params.skills,
					prompt: params.prompt,
					context: params.context,
				});
			}

			if (hasRuntimePersistOverride(params as unknown)) {
				throwTaskError("Invalid parameters. Runtime persist overrides are not supported.", makeDetails(mode)([]));
			}

			if (mode !== "chain") {
				const invalidStep = stepsToRun.findIndex((step) => hasPreviousPlaceholder(step.task));
				if (invalidStep !== -1) {
					throwTaskError(
						`Invalid task at step ${invalidStep + 1}: {previous} is only supported in chain mode.`,
						makeDetails(mode)([]),
					);
				}
			}

			if (mode === "parallel" && stepsToRun.length > MAX_PARALLEL_TASKS) {
				throwTaskError(
					`Too many parallel tasks (${stepsToRun.length}). Max is ${MAX_PARALLEL_TASKS}.`,
					makeDetails("parallel")([]),
				);
			}

			let preparedSteps: PreparedTaskStep[] = [];

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) if (step.agent) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) if (t.agent) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => discovery.agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project" && isTaskCallableAgent(a));

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(mode)([]),
						};
				}
			}

			const preflight = await preflightTaskRun(mode, stepsToRun, discovery, ctx.cwd, ctx.sessionManager);
			if (preflight.error || !preflight.prepared) {
				throwTaskError(preflight.error ?? "Failed to prepare task run.", makeDetails(mode)([]));
			}
			sessionRunId = preflight.prepared.sessionRunId;
			sessionRunRoot = preflight.prepared.sessionRunRoot;
			preparedSteps = preflight.prepared.steps;
			childMetadataRunId = sessionRunId ?? `${toolCallId}-run`;

			if (mode === "chain") {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < preparedSteps.length; i++) {
					const preparedStep = preparedSteps[i];
					const taskWithContext = preparedStep.rawStep.task.replace(/\{previous\}/g, previousOutput);

					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runTaskStepWithMetadata({
						preparedStep,
						task: taskWithContext,
						mode: "chain",
						step: preparedStep.step,
						toolCallId: toolCallId,
						runId: childMetadataRunId,
						signal,
						onUpdate: chainUpdate,
						makeDetails: makeDetails("chain"),
						sessionManager: ctx.sessionManager,
						origin: taskOrigin,
						refreshUi: () => syncTaskUiChrome(ctx),
						enableRpcControl: ctx.hasUI === true,
						parentUiContext: {
							hasUI: ctx.hasUI,
							ui: ctx.ui,
							sessionManager: ctx.sessionManager,
							refreshTaskUiChrome: () => syncTaskUiChrome(ctx),
						},
					});
					results.push(result);

					const isError =
						result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg =
							result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
						throwTaskError(
							`Chain stopped at step ${preparedStep.step} (${preparedStep.rawStep.agent ?? preparedStep.rawStep.profile ?? "generic"}): ${errorMsg}\n\n${formatChainResults(results)}`,
							makeDetails("chain")(results),
						);
					}
					previousOutput = truncateOutput(getFinalOutput(result.messages));
				}
				return {
					content: [{ type: "text", text: formatChainResults(results) }],
					details: makeDetails("chain")(results),
				};
			}

			if (mode === "parallel") {
				const allResults: SingleResult[] = new Array(preparedSteps.length);
				for (let i = 0; i < preparedSteps.length; i++) {
					const preparedStep = preparedSteps[i];
					allResults[i] = {
						agent: preparedStep.worker.displayAgentName,
						agentSource: preparedStep.worker.agent?.source ?? "unknown",
						profile: preparedStep.worker.profile?.name,
						effort: preparedStep.worker.effort?.name,
						task: preparedStep.rawStep.task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						model: preparedStep.worker.model,
						step: preparedStep.step,
						sessionMode: preparedStep.session.mode,
						sessionPersist: preparedStep.session.persist,
						sessionFile: preparedStep.session.sessionFile,
						uiNotices: [],
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit<PreparedTaskStep, SingleResult>(
					preparedSteps,
					MAX_CONCURRENCY,
					async (preparedStep, index) => {
						const result = await runTaskStepWithMetadata({
							preparedStep,
							task: preparedStep.rawStep.task,
							mode: "parallel",
							step: preparedStep.step,
							toolCallId: toolCallId,
							runId: childMetadataRunId,
							signal,
							onUpdate: (partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									emitParallelUpdate();
								}
							},
							makeDetails: makeDetails("parallel"),
							sessionManager: ctx.sessionManager,
							origin: taskOrigin,
							refreshUi: () => syncTaskUiChrome(ctx),
							enableRpcControl: ctx.hasUI === true,
							parentUiContext: {
								hasUI: ctx.hasUI,
								ui: ctx.ui,
								sessionManager: ctx.sessionManager,
								refreshTaskUiChrome: () => syncTaskUiChrome(ctx),
							},
						});
						allResults[index] = result;
						emitParallelUpdate();
						return result;
					},
				);

				return {
					content: [
						{
							type: "text",
							text: formatParallelResults(results),
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (mode === "single") {
				const preparedStep = preparedSteps[0]!;
				const result = await runTaskStepWithMetadata({
					preparedStep,
					task: preparedStep.rawStep.task,
					mode: "single",
					step: preparedStep.step,
					toolCallId: toolCallId,
					runId: childMetadataRunId,
					signal,
					onUpdate,
					makeDetails: makeDetails("single"),
					sessionManager: ctx.sessionManager,
					origin: taskOrigin,
					refreshUi: () => syncTaskUiChrome(ctx),
					enableRpcControl: ctx.hasUI === true,
					parentUiContext: {
						hasUI: ctx.hasUI,
						ui: ctx.ui,
						sessionManager: ctx.sessionManager,
						refreshTaskUiChrome: () => syncTaskUiChrome(ctx),
					},
				});
				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg =
						result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					throwTaskError(`Agent ${result.stopReason || "failed"}: ${errorMsg}`, makeDetails("single")([result]));
				}
				return {
					content: [{ type: "text", text: truncateOutput(getFinalOutput(result.messages)) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = callableAgents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available task agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			if (args.chain && args.chain.length > 0) {
				const tasks = args.chain.map((step) => step.task.replace(/\{previous\}/g, "").trim());
				const text =
					formatTaskCallHeading("chain", theme, args.chain.length) +
					formatTaskSnippetLines(tasks, theme.fg.bind(theme), { numbered: true });
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				const text =
					formatTaskCallHeading("parallel", theme, args.tasks.length) +
					formatTaskSnippetLines(
						args.tasks.map((task) => task.task),
						theme.fg.bind(theme),
					);
				return new Text(text, 0, 0);
			}
			const task = args.task ?? "...";
			const text =
				formatTaskCallHeading("simple", theme) +
				formatTaskSnippetLines([task], theme.fg.bind(theme), { maxItems: 1, maxLength: 80 });
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TaskDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = formatTaskHeader(
						{ leadingIcon: icon, agent: r.agent, agentColor: "toolTitle", boldAgent: true, taskResult: r },
						theme,
					);
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					if (r.childSession) {
						container.addChild(new Text(formatChildSessionExpanded(r.childSession, theme.fg.bind(theme)), 0, 0));
					}
					if ((r.uiNotices?.length ?? 0) > 0) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("muted", "─── Notices ───"), 0, 0));
						container.addChild(new Text(formatTaskInlineNoticeLines(r.uiNotices ?? [], theme.fg.bind(theme)), 0, 0));
					}
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					appendTaskOutputSection(container, displayItems, finalOutput, mdTheme, theme.fg.bind(theme));
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = formatTaskHeader(
					{ leadingIcon: icon, agent: r.agent, agentColor: "toolTitle", boldAgent: true, taskResult: r },
					theme,
				);
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (r.childSession) text += `\n${formatChildSessionCompact(r.childSession, theme.fg.bind(theme))}`;
				if ((r.uiNotices?.length ?? 0) > 0) text += `\n${formatTaskInlineNoticeLines(r.uiNotices ?? [], theme.fg.bind(theme))}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0 && (r.uiNotices?.length ?? 0) === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						const stepHeader = formatTaskHeader(
							{
								prefix: theme.fg("muted", `─── Step ${r.step}: `),
								agent: r.agent,
								taskResult: r,
								suffix: ` ${rIcon}`,
							},
							theme,
						);
						container.addChild(new Text(stepHeader, 0, 0));
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						if (r.childSession) {
							container.addChild(new Text(formatChildSessionExpanded(r.childSession, theme.fg.bind(theme)), 0, 0));
						}
						if ((r.uiNotices?.length ?? 0) > 0) {
							container.addChild(new Text(formatTaskInlineNoticeLines(r.uiNotices ?? [], theme.fg.bind(theme)), 0, 0));
						}
						appendTaskOutputSection(container, displayItems, finalOutput, mdTheme, theme.fg.bind(theme));
						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${formatTaskHeader(
						{ prefix: theme.fg("muted", `─── Step ${r.step}: `), agent: r.agent, taskResult: r, suffix: ` ${rIcon}` },
						theme,
					)}`;
					if (r.childSession) text += `\n${formatChildSessionCompact(r.childSession, theme.fg.bind(theme))}`;
					if ((r.uiNotices?.length ?? 0) > 0) text += `\n${formatTaskInlineNoticeLines(r.uiNotices ?? [], theme.fg.bind(theme))}`;
					if (displayItems.length === 0 && (r.uiNotices?.length ?? 0) === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						const taskHeader = formatTaskHeader(
							{ prefix: theme.fg("muted", "─── "), agent: r.agent, taskResult: r, suffix: ` ${rIcon}` },
							theme,
						);
						container.addChild(new Text(taskHeader, 0, 0));
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						if (r.childSession) {
							container.addChild(new Text(formatChildSessionExpanded(r.childSession, theme.fg.bind(theme)), 0, 0));
						}
						if ((r.uiNotices?.length ?? 0) > 0) {
							container.addChild(new Text(formatTaskInlineNoticeLines(r.uiNotices ?? [], theme.fg.bind(theme)), 0, 0));
						}
						appendTaskOutputSection(container, displayItems, finalOutput, mdTheme, theme.fg.bind(theme));
						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${formatTaskHeader(
						{ prefix: theme.fg("muted", "─── "), agent: r.agent, taskResult: r, suffix: ` ${rIcon}` },
						theme,
					)}`;
					if (r.childSession) text += `\n${formatChildSessionCompact(r.childSession, theme.fg.bind(theme))}`;
					if ((r.uiNotices?.length ?? 0) > 0) text += `\n${formatTaskInlineNoticeLines(r.uiNotices ?? [], theme.fg.bind(theme))}`;
					if (displayItems.length === 0 && (r.uiNotices?.length ?? 0) === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}

export const __test__ = {
	addTaskInlineNotice,
	buildTaskInlineNoticeLines,
	hasRuntimePersistOverride,
	formatTaskRunList,
	formatParallelResults,
	formatChainResults,
	getFinalOutput,
	buildTaskWidgetLines,
	normalizeChildSessionSnapshot: (data: unknown) => normalizeChildSessionSnapshot(data, TASK_CHILD_SESSION_METADATA_VERSION),
	parseTaskTerminalBackendPreference,
	parseTasksCommand,
	preflightTaskRun,
	relayTaskExtensionUiRequest,
	resolveModelFromEffort,
	resolveParentSessionForCurrentSession,
	resolvePersistedTaskSessionRoot,
	resolveTaskOriginForBranch: (entries: readonly SessionEntry[], leafId?: string | null) =>
		resolveTaskOriginForBranch(entries, createTaskPreview, leafId),
	resolveTaskSelector,
	setTaskWidgetEnabled,
};
