import * as os from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import type { ContextMode } from "./agents.js";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_OUTPUT_LINES = 2000;
const HIDDEN_TASK_NOTICE_PREFIXES = ["Shell parser active:", "Bash sandbox active"];

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens?: number;
	turns: number;
}

export type TaskNoticeLevel = "info" | "warning" | "error";

export interface TaskInlineNotice {
	level: TaskNoticeLevel;
	lines: string[];
	updatedAt: number;
}

interface TaskDisplayResult {
	agent: string;
	agentSource?: string;
	profile?: string;
	effort?: string;
	skills?: string[];
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage?: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	sessionMode?: ContextMode;
	sessionPersist?: boolean;
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> }
	| { type: "toolResult"; name: string; text?: string; diff?: string; isError: boolean };

function truncateUtf8Prefix(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	let low = 0;
	let high = text.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes) low = middle;
		else high = middle - 1;
	}
	return text.slice(0, low);
}

function truncateUtf8Suffix(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	let low = 0;
	let high = text.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(text.length - middle), "utf8") <= maxBytes) low = middle;
		else high = middle - 1;
	}
	return text.slice(text.length - low);
}

export function truncateOutput(text: string): string {
	const lines = text.split("\n");
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= MAX_OUTPUT_BYTES && lines.length <= MAX_OUTPUT_LINES) return text;

	const marker = `[TRUNCATED: showing head and tail of ${lines.length} lines, ${bytes} bytes]`;
	const markerBytes = Buffer.byteLength(marker, "utf8");
	const separatorBytes = Buffer.byteLength("\n", "utf8");
	const bodyBudget = Math.max(0, MAX_OUTPUT_BYTES - markerBytes - separatorBytes);
	const shownLineCount = Math.min(lines.length, MAX_OUTPUT_LINES - 1);
	const headCount = Math.ceil(shownLineCount / 2);
	const tailCount = Math.floor(shownLineCount / 2);
	const head = lines.slice(0, headCount).join("\n");
	const tail = tailCount > 0 ? lines.slice(-tailCount).join("\n") : "";
	const joinBytes = head && tail ? separatorBytes : 0;
	const availableBody = Math.max(0, bodyBudget - joinBytes);
	const headBudget = Math.ceil(availableBody / 2);
	const tailBudget = availableBody - headBudget;
	const boundedHead = truncateUtf8Prefix(head, headBudget).replace(/\n+$/, "");
	const boundedTail = truncateUtf8Suffix(tail, tailBudget).replace(/^\n+/, "");
	const body = boundedHead && boundedTail ? `${boundedHead}\n${boundedTail}` : boundedHead || boundedTail;
	return `${marker}\n${body}`;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: UsageStats, model?: string): string {
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
	selection: { profile?: string; effort?: string; skills?: string[] },
	themeFg: (color: any, text: string) => string,
): string {
	const parts: string[] = [];
	if (selection.profile) {
		parts.push(themeFg("muted", "profile: ") + themeFg("accent", selection.profile));
	}
	if (selection.effort) {
		parts.push(themeFg("muted", "effort: ") + themeFg("accent", selection.effort));
	}
	const skillCount = (selection.skills ?? []).filter((skill) => skill.trim().length > 0).length;
	if (skillCount > 0) {
		parts.push(themeFg("muted", "skills: ") + themeFg("accent", String(skillCount)));
	}
	return parts.join(themeFg("muted", " · "));
}

function formatTaskExecutionContext(
	agentSource: string | undefined,
	sessionMode: ContextMode | undefined,
	themeFg: (color: any, text: string) => string,
): string {
	const showSource = Boolean(agentSource && agentSource !== "unknown");
	const showMode = Boolean(sessionMode && sessionMode !== "fresh");
	if (!showSource && !showMode) return "";
	const label = showSource && showMode ? `${agentSource}:${sessionMode}` : showSource ? agentSource! : sessionMode!;
	return themeFg("muted", ` (${label})`);
}

function formatTaskExecutionMetadata(
	taskResult: {
		agentSource?: string;
		sessionMode?: ContextMode;
		profile?: string;
		effort?: string;
		skills?: string[];
	},
	themeFg: (color: any, text: string) => string,
): string {
	const context = formatTaskExecutionContext(taskResult.agentSource, taskResult.sessionMode, themeFg);
	const selection = formatTaskExecutionSelection(taskResult, themeFg);
	if (context && selection) return `${context}${themeFg("muted", " · ")}${selection}`;
	if (context) return context;
	if (selection) return `${themeFg("muted", " · ")}${selection}`;
	return "";
}

function formatOptionalValue(value: string | undefined): string {
	return value?.trim() ? value : "none";
}

export function formatTaskConfigurationLines(
	taskResult: {
		agent: string;
		agentSource?: string;
		profile?: string;
		effort?: string;
		skills?: string[];
		sessionMode?: ContextMode;
		sessionPersist?: boolean;
	},
	themeFg: (color: any, text: string) => string,
): string {
	const agentSource =
		taskResult.agentSource && taskResult.agentSource !== "unknown" ? ` (${taskResult.agentSource})` : "";
	const skills = (taskResult.skills ?? []).filter((skill) => skill.trim().length > 0);
	const lines = [
		`${themeFg("muted", "agent: ")}${themeFg("accent", `${taskResult.agent}${agentSource}`)}`,
		`${themeFg("muted", "profile: ")}${themeFg("accent", formatOptionalValue(taskResult.profile))}`,
		`${themeFg("muted", "effort: ")}${themeFg("accent", formatOptionalValue(taskResult.effort))}`,
		`${themeFg("muted", "context: ")}${themeFg("accent", taskResult.sessionMode ?? "fresh")}`,
		`${themeFg("muted", "persist: ")}${themeFg("accent", taskResult.sessionPersist === undefined ? "unknown" : String(taskResult.sessionPersist))}`,
		`${themeFg("muted", "skills: ")}${themeFg("accent", skills.length > 0 ? skills.join(", ") : "none")}`,
	];
	return lines.join("\n");
}

export function formatTaskHeader(
	options: {
		agent: string;
		taskResult: {
			agentSource?: string;
			sessionMode?: ContextMode;
			profile?: string;
			effort?: string;
			skills?: string[];
		};
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

export function formatTaskCallHeading(
	kind: "simple" | "chain" | "parallel",
	theme: { fg: (color: any, text: string) => string; bold: (text: string) => string },
	count?: number,
): string {
	let heading = theme.fg("toolTitle", theme.bold("task ")) + theme.fg("accent", kind);
	if (kind === "chain" && count !== undefined) heading += theme.fg("muted", ` (${count} steps)`);
	if (kind === "parallel" && count !== undefined) heading += theme.fg("muted", ` (${count} tasks)`);
	return heading;
}

export function formatTaskSnippetLines(
	tasks: string[],
	themeFg: (color: any, text: string) => string,
	options: { numbered?: boolean; maxItems?: number; maxLength?: number } = {},
): string {
	const maxItems = options.maxItems ?? 3;
	const maxLength = options.maxLength ?? 50;
	let text = "";
	for (let i = 0; i < Math.min(tasks.length, maxItems); i++) {
		const task = tasks[i];
		if (task === undefined) continue;
		const preview = task.length > maxLength ? `${task.slice(0, maxLength)}...` : task;
		const index = options.numbered ? `${themeFg("muted", `${i + 1}.`)} ` : "";
		text += `\n  ${index}${themeFg("dim", preview)}`;
	}
	if (tasks.length > maxItems) text += `\n  ${themeFg("muted", `... +${tasks.length - maxItems} more`)}`;
	return text;
}

export function appendTaskOutputSection(
	container: Container,
	displayItems: DisplayItem[],
	finalOutput: string,
	themeFg: (color: any, text: string) => string,
): void {
	if (displayItems.length === 0 && !finalOutput) {
		container.addChild(new Text(themeFg("muted", "(no output)"), 0, 0));
		return;
	}
	const mdTheme = getMarkdownTheme();
	for (const item of displayItems) {
		if (item.type === "toolCall") {
			container.addChild(new Text(themeFg("muted", "→ ") + formatToolCall(item.name, item.args, themeFg), 0, 0));
			continue;
		}
		if (item.type === "toolResult") {
			const icon = item.isError ? themeFg("error", "✗") : themeFg("success", "✓");
			container.addChild(
				new Text(`${themeFg("muted", "↳ ")}${icon} ${themeFg("muted", `${item.name} result`)}`, 0, 0),
			);
			if (item.text) {
				container.addChild(new Text(themeFg(item.isError ? "error" : "dim", item.text), 0, 0));
			}
			if (item.diff) {
				container.addChild(new Text(themeFg("muted", "diff:"), 0, 0));
				const diffBody = truncateOutput(item.diff).trim();
				container.addChild(new Markdown(`\`\`\`diff\n${diffBody}\n\`\`\``, 0, 0, mdTheme));
			}
		}
	}
	if (finalOutput) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
	}
}

export function shortenHomePath(filePath: string): string {
	const home = os.homedir();
	return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

export function normalizeTaskDisplayToolName(toolName: string): string {
	const trimmed = toolName.trim().toLowerCase();
	if (!trimmed) return "";
	const segments = trimmed.split(".").filter(Boolean);
	return segments.length > 0 ? (segments[segments.length - 1] ?? trimmed) : trimmed;
}

export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const displayToolName = normalizeTaskDisplayToolName(toolName);
	switch (displayToolName) {
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
			return themeFg("muted", "read: ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenHomePath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write: ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit: ") + themeFg("accent", shortenHomePath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls: ") + themeFg("accent", shortenHomePath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "find: ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenHomePath(rawPath)}`)
			);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep: ") +
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

function shouldDisplayTaskToolCall(toolName: string): boolean {
	return normalizeTaskDisplayToolName(toolName).length > 0;
}

function shouldDisplayTaskToolResult(name: string, isError: boolean): boolean {
	return isError || normalizeTaskDisplayToolName(name) === "edit";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function extractMessageTextContent(message: Message): string | undefined {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") {
		const text = content.trim();
		return text || undefined;
	}
	if (!Array.isArray(content)) return undefined;
	const text = content
		.flatMap((part) => {
			if (typeof part === "string") return [part];
			if (!isRecord(part)) return [];
			if (typeof part.text === "string") return [part.text];
			return [];
		})
		.join("\n")
		.trim();
	return text || undefined;
}

function extractToolResultDiff(message: Message): string | undefined {
	const details = (message as { details?: unknown }).details;
	if (!isRecord(details) || typeof details.diff !== "string") return undefined;
	const diff = details.diff.trim();
	return diff || undefined;
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") {
					items.push({ type: "text", text: part.text });
					continue;
				}
				if (part.type === "toolCall" && shouldDisplayTaskToolCall(part.name)) {
					items.push({ type: "toolCall", name: part.name, args: part.arguments as Record<string, unknown> });
				}
			}
			continue;
		}
		if (msg.role === "toolResult") {
			const toolName = (msg as { toolName?: unknown }).toolName;
			const name = typeof toolName === "string" && toolName.trim() ? toolName : "tool";
			const isError = (msg as { isError?: unknown }).isError === true;
			if (!shouldDisplayTaskToolResult(name, isError)) continue;
			const text = extractMessageTextContent(msg);
			const diff = extractToolResultDiff(msg);
			items.push({
				type: "toolResult",
				name,
				text,
				diff,
				isError,
			});
		}
	}
	return items;
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const textParts = msg.content
			.filter(
				(part): part is { type: "text"; text: string } =>
					typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string",
			)
			.map((part) => part.text)
			.filter((text) => text.length > 0);
		if (textParts.length > 0) return textParts.join("\n");
	}
	return "";
}

function getTaskResultOutput(result: TaskDisplayResult): string {
	const finalOutput = getFinalOutput(result.messages).trim();
	if (finalOutput) return finalOutput;
	const errorMessage = result.errorMessage?.trim();
	if (errorMessage) return errorMessage;
	const stderr = result.stderr.trim();
	if (stderr) return stderr;
	return "";
}

function formatTaskResultSection(result: TaskDisplayResult): string {
	const status = result.exitCode === -1 ? "running" : result.exitCode === 0 ? "completed" : "failed";
	const step = result.step !== undefined ? `Step ${result.step}` : "Task";
	const lines = [`### ${step} — ${result.agent} (${status})`];
	if (result.task) lines.push(`Task: ${createTaskPreview(result.task, 240)}`);
	const output = getTaskResultOutput(result);
	lines.push(output || "(no output)");
	return lines.join("\n");
}

export function formatParallelResults(results: TaskDisplayResult[]): string {
	const successCount = results.filter((result) => result.exitCode === 0).length;
	const sections = results.map(formatTaskResultSection);
	return truncateOutput([`Parallel: ${successCount}/${results.length} succeeded`, ...sections].join("\n\n"));
}

export function formatChainResults(results: TaskDisplayResult[]): string {
	if (results.length === 0) return "Chain: 0/0 succeeded";
	const successCount = results.filter((result) => result.exitCode === 0).length;
	const sections = results.map(formatTaskResultSection);
	return truncateOutput([`Chain: ${successCount}/${results.length} succeeded`, ...sections].join("\n\n"));
}

export function createTaskPreview(task: string, maxLength = 120): string {
	const compact = task.replace(/\s+/g, " ").trim();
	if (!compact) return "(empty task)";
	return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

export function shouldDisplayTaskInlineNotice(message: string): boolean {
	const trimmed = message.trim();
	return !HIDDEN_TASK_NOTICE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function addTaskInlineNotice(
	result: { uiNotices?: TaskInlineNotice[] },
	message: string,
	level: TaskNoticeLevel,
): void {
	const lines = message
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => Boolean(line) && shouldDisplayTaskInlineNotice(line));
	if (lines.length === 0) return;
	const nextNotice: TaskInlineNotice = { level, lines, updatedAt: Date.now() };
	const existing = result.uiNotices ?? [];
	const deduped = existing.filter(
		(notice) => notice.lines.join("\n") !== nextNotice.lines.join("\n") || notice.level !== nextNotice.level,
	);
	result.uiNotices = [...deduped, nextNotice].slice(-5);
}

export function buildTaskInlineNoticeLines(notices: TaskInlineNotice[]): string[] {
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

export function formatTaskInlineNoticeLines(
	notices: TaskInlineNotice[],
	themeFg: (color: any, text: string) => string,
): string {
	return buildTaskInlineNoticeLines(notices)
		.map((line) => themeFg("muted", line))
		.join("\n");
}
