import type { Message, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	type SelectItem,
	SelectList,
	Text,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const PICKER_SHORTCUT = "alt+shift+o";
const LATEST_SHORTCUT = "alt+o";
const MAX_PREVIEW = 120;

interface ToolOutputRecord {
	index: number;
	toolCallId: string;
	toolName: string;
	timestamp: number;
	status: "success" | "error";
	argsSummary: string;
	preview: string;
	lineCount: number;
	body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function compactText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
	const compact = compactText(value);
	if (!compact) return "";
	return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function formatTimestamp(timestamp: number): string {
	if (!Number.isFinite(timestamp)) return "unknown time";
	return new Date(timestamp).toLocaleString();
}

function shortId(value: string): string {
	return value.length > 8 ? value.slice(0, 8) : value;
}

function formatKeyLabel(key: string): string {
	return key
		.split("+")
		.map((part) => {
			const token = part.trim().toLowerCase();
			if (token === "ctrl") return "Ctrl";
			if (token === "shift") return "Shift";
			if (token === "alt") return "Alt";
			if (token === "super") return "Super";
			if (token === "escape" || token === "esc") return "Esc";
			if (token === "return") return "Enter";
			if (token === "pageup") return "PgUp";
			if (token === "pagedown") return "PgDn";
			if (token.length === 1) return token.toUpperCase();
			return token.charAt(0).toUpperCase() + token.slice(1);
		})
		.join("+");
}

function getBindingHint(keybindings: KeybindingsManager, binding: string, fallback: string): string {
	const keys = keybindings.getKeys(binding as any);
	if (!Array.isArray(keys) || keys.length === 0) return fallback;
	return keys.map((key) => formatKeyLabel(key)).join("/");
}

function stringifyCompact(value: unknown, maxLength = 240): string {
	try {
		const text = JSON.stringify(value);
		if (typeof text !== "string") return String(value);
		return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
	} catch {
		return String(value);
	}
}

function stringifyPretty(value: unknown): string {
	try {
		const text = JSON.stringify(value, null, 2);
		return typeof text === "string" ? text : String(value);
	} catch {
		return String(value);
	}
}

function collectTextContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return [];
			return [part.text];
		})
		.join("\n\n")
		.trim();
}

function countImages(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	return content.filter((part) => isRecord(part) && part.type === "image").length;
}

function summarizeToolArgs(toolName: string, args: unknown): string {
	if (!isRecord(args)) return truncateText(stringifyCompact(args), MAX_PREVIEW);

	switch (toolName) {
		case "bash":
			return typeof args.command === "string" ? truncateText(args.command, MAX_PREVIEW) : "bash command";
		case "read": {
			const path = typeof args.path === "string" ? args.path : "(unknown path)";
			const parts = [path];
			if (typeof args.offset === "number") parts.push(`offset ${args.offset}`);
			if (typeof args.limit === "number") parts.push(`limit ${args.limit}`);
			return truncateText(parts.join(" · "), MAX_PREVIEW);
		}
		case "write":
			return typeof args.path === "string" ? truncateText(args.path, MAX_PREVIEW) : "write file";
		case "edit": {
			const path = typeof args.path === "string" ? args.path : "(unknown path)";
			const edits = Array.isArray(args.edits) ? `${args.edits.length} edit(s)` : "edit file";
			return truncateText(`${path} · ${edits}`, MAX_PREVIEW);
		}
		case "grep": {
			const pattern = typeof args.pattern === "string" ? args.pattern : "grep";
			const path = typeof args.path === "string" ? ` · ${args.path}` : "";
			return truncateText(`${pattern}${path}`, MAX_PREVIEW);
		}
		case "find": {
			const path = typeof args.path === "string" ? args.path : ".";
			const pattern = typeof args.pattern === "string" ? ` · ${args.pattern}` : "";
			return truncateText(`${path}${pattern}`, MAX_PREVIEW);
		}
		case "ls":
			return typeof args.path === "string" ? truncateText(args.path, MAX_PREVIEW) : ".";
		case "task": {
			if (typeof args.task === "string") return truncateText(args.task, MAX_PREVIEW);
			if (Array.isArray(args.tasks) && args.tasks.length > 0) {
				const first =
					isRecord(args.tasks[0]) && typeof args.tasks[0].task === "string"
						? args.tasks[0].task
						: "parallel task";
				const suffix = args.tasks.length > 1 ? ` (+${args.tasks.length - 1} more)` : "";
				return truncateText(`parallel · ${first}${suffix}`, MAX_PREVIEW);
			}
			if (Array.isArray(args.chain) && args.chain.length > 0) {
				const first =
					isRecord(args.chain[0]) && typeof args.chain[0].task === "string"
						? args.chain[0].task
						: "chain task";
				const suffix = args.chain.length > 1 ? ` (+${args.chain.length - 1} more)` : "";
				return truncateText(`chain · ${first}${suffix}`, MAX_PREVIEW);
			}
			return "task";
		}
		default:
			return truncateText(stringifyCompact(args), MAX_PREVIEW);
	}
}

function formatTaskMessages(messages: unknown): string {
	if (!Array.isArray(messages)) return "";

	const sections: string[] = [];
	for (const message of messages) {
		if (!isRecord(message) || typeof message.role !== "string") continue;

		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (!isRecord(part) || typeof part.type !== "string") continue;
				if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
					sections.push(part.text.trim());
				}
				if (part.type === "toolCall" && typeof part.name === "string") {
					const argsText = part.arguments === undefined ? "" : `\n${stringifyPretty(part.arguments)}`;
					sections.push(`→ tool ${part.name}${argsText}`.trimEnd());
				}
			}
		}

		if (message.role === "toolResult") {
			const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
			const text = collectTextContent(message.content);
			if (text) sections.push(`[${toolName}]\n${text}`);
		}
	}

	return sections.join("\n\n").trim();
}

function formatTaskBody(details: unknown, fallbackOutput: string): string | undefined {
	if (!isRecord(details) || !Array.isArray(details.results)) return undefined;
	const mode = typeof details.mode === "string" ? details.mode : "task";
	const sections: string[] = [`Mode: ${mode} · ${details.results.length} result(s)`];

	for (let index = 0; index < details.results.length; index++) {
		const result = details.results[index];
		if (!isRecord(result)) continue;

		const step = typeof result.step === "number" ? result.step : index + 1;
		const agent = typeof result.agent === "string" ? result.agent : "agent";
		const exitCode = typeof result.exitCode === "number" ? result.exitCode : undefined;
		const stopReason = typeof result.stopReason === "string" ? result.stopReason : undefined;
		const task = typeof result.task === "string" ? result.task : "";
		const childSession = isRecord(result.childSession) ? result.childSession : undefined;
		const childSessionName =
			typeof childSession?.childSessionName === "string" ? childSession.childSessionName : undefined;
		const childSessionId =
			typeof childSession?.childSessionId === "string" ? childSession.childSessionId : undefined;
		const errorMessage = typeof result.errorMessage === "string" ? result.errorMessage : undefined;
		const stderr = typeof result.stderr === "string" ? result.stderr : "";
		const output = formatTaskMessages(result.messages);
		const status =
			stopReason === "aborted"
				? "aborted"
				: stopReason === "error" || (exitCode !== undefined && exitCode !== 0)
					? `failed${exitCode !== undefined ? ` (${exitCode})` : ""}`
					: "ok";

		sections.push(`\n=== Step ${step} · ${agent} · ${status} ===`);
		if (task) sections.push(`Task:\n${task}`);
		if (childSessionName || childSessionId) sections.push(`Child session: ${childSessionName ?? childSessionId}`);
		if (output) sections.push(`Output:\n${output}`);
		if (stderr.trim()) sections.push(`stderr:\n${stderr.trim()}`);
		if (errorMessage) sections.push(`Error:\n${errorMessage}`);
	}

	const body = sections.join("\n\n").trim();
	return body || fallbackOutput || undefined;
}

function formatGenericBody(
	toolName: string,
	args: unknown,
	textOutput: string,
	details: unknown,
	imageCount: number,
): string {
	const sections: string[] = [];
	const argsText = stringifyPretty(args);
	if (argsText && argsText !== "{}") sections.push(`Arguments:\n${argsText}`);
	if (textOutput) sections.push(`Output:\n${textOutput}`);
	if (!textOutput && imageCount > 0) sections.push(`Output:\n(contains ${imageCount} image result(s))`);
	if (!textOutput && imageCount === 0 && details !== undefined)
		sections.push(`Details:\n${stringifyPretty(details)}`);
	if (sections.length === 0) sections.push(`(${toolName} produced no text output)`);
	return sections.join("\n\n");
}

function buildBody(toolName: string, args: unknown, textOutput: string, details: unknown, imageCount: number): string {
	if (toolName === "task") {
		const taskBody = formatTaskBody(details, textOutput);
		if (taskBody) return taskBody;
	}
	return formatGenericBody(toolName, args, textOutput, details, imageCount);
}

function extractToolOutputs(ctx: ExtensionContext): ToolOutputRecord[] {
	const branch = ctx.sessionManager.getBranch();
	const toolCalls = new Map<string, ToolCall>();
	const outputs: ToolOutputRecord[] = [];

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message as Message;

		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "toolCall") toolCalls.set(part.id, part);
			}
			continue;
		}

		if (message.role !== "toolResult") continue;
		const toolCall = toolCalls.get(message.toolCallId);
		const args = toolCall?.arguments;
		const textOutput = collectTextContent(message.content);
		const imageCount = countImages(message.content);
		const argsSummary = summarizeToolArgs(message.toolName, args);
		const previewSource =
			textOutput || argsSummary || (imageCount > 0 ? `(contains ${imageCount} image result(s))` : "(no output)");
		const body = buildBody(message.toolName, args, textOutput, message.details, imageCount);
		const lineCount = body.split(/\r?\n/).length;

		outputs.push({
			index: outputs.length,
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			timestamp: message.timestamp,
			status: message.isError ? "error" : "success",
			argsSummary,
			preview: truncateText(previewSource, MAX_PREVIEW),
			lineCount,
			body,
		});
	}

	return outputs.reverse().map((output, index) => ({ ...output, index }));
}

class ToolOutputViewerComponent {
	private index: number;
	private scrollOffset = 0;
	private cachedWidth?: number;
	private cachedBodyKey?: string;
	private cachedBodyLines?: string[];

	constructor(
		private readonly records: ToolOutputRecord[],
		startIndex: number,
		private readonly tui: { terminal: { rows: number } },
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly keybindings: KeybindingsManager,
		private readonly onClose: () => void,
	) {
		this.index = Math.max(0, Math.min(startIndex, records.length - 1));
	}

	private get current(): ToolOutputRecord {
		return this.records[this.index]!;
	}

	private invalidateBody(): void {
		this.cachedWidth = undefined;
		this.cachedBodyKey = undefined;
		this.cachedBodyLines = undefined;
	}

	private matchesBinding(data: string, binding: string, fallbackKeys: string[]): boolean {
		if (this.keybindings.matches(data, binding as any)) return true;
		return fallbackKeys.some((key) => matchesKey(data, key as any));
	}

	private setIndex(nextIndex: number): void {
		if (this.records.length === 0) return;
		const normalized = (nextIndex + this.records.length) % this.records.length;
		if (normalized === this.index) return;
		this.index = normalized;
		this.scrollOffset = 0;
		this.invalidateBody();
	}

	private getBodyLines(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const key = `${this.current.toolCallId}:${safeWidth}`;
		if (this.cachedBodyKey === key && this.cachedBodyLines) return this.cachedBodyLines;

		const outputColor = this.theme.fg.bind(this.theme, "toolOutput");
		const bodyText = outputColor(this.current.body);
		const wrapped = wrapTextWithAnsi(bodyText, safeWidth);
		this.cachedWidth = safeWidth;
		this.cachedBodyKey = key;
		this.cachedBodyLines = wrapped.length > 0 ? wrapped : [outputColor("(no output)")];
		return this.cachedBodyLines;
	}

	handleInput(data: string): void {
		if (this.matchesBinding(data, "tui.select.cancel", [Key.escape, Key.ctrl("c")])) {
			this.onClose();
			return;
		}

		if (data === "n" || matchesKey(data, Key.right)) {
			this.setIndex(this.index + 1);
			return;
		}

		if (data === "p" || matchesKey(data, Key.left)) {
			this.setIndex(this.index - 1);
			return;
		}

		const viewportHeight = Math.max(8, Math.floor(this.tui.terminal.rows * 0.55));
		const maxScroll = Math.max(0, this.getBodyLines(this.cachedWidth ?? 80).length - viewportHeight);

		if (this.matchesBinding(data, "tui.select.up", [Key.up]) || data === "k") {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			return;
		}
		if (this.matchesBinding(data, "tui.select.down", [Key.down]) || data === "j") {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
			return;
		}
		if (this.matchesBinding(data, "tui.select.pageUp", [Key.pageUp])) {
			this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight + 2);
			return;
		}
		if (this.matchesBinding(data, "tui.select.pageDown", [Key.pageDown]) || matchesKey(data, Key.space)) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight - 2);
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.scrollOffset = 0;
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.scrollOffset = maxScroll;
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const record = this.current;
		const bodyLines = this.getBodyLines(safeWidth);
		const headerLines: string[] = [];
		const statusIcon = record.status === "error" ? this.theme.fg("error", "✗") : this.theme.fg("success", "✓");
		const header = `${statusIcon} ${this.theme.fg("toolTitle", this.theme.bold(record.toolName))} ${this.theme.fg("muted", `${this.index + 1}/${this.records.length}`)}`;
		headerLines.push(truncateToWidth(header, safeWidth));
		headerLines.push(
			truncateToWidth(
				this.theme.fg(
					"dim",
					`${formatTimestamp(record.timestamp)} · ${record.lineCount} line(s) · ${shortId(record.toolCallId)}`,
				),
				safeWidth,
			),
		);
		if (record.argsSummary) {
			headerLines.push(
				...wrapTextWithAnsi(
					this.theme.fg("muted", `Call: `) + this.theme.fg("dim", record.argsSummary),
					safeWidth,
				),
			);
		}
		headerLines.push(truncateToWidth(this.theme.fg("borderMuted", "─".repeat(safeWidth)), safeWidth));

		const scrollHint = `${getBindingHint(this.keybindings, "tui.select.up", "↑")}/${getBindingHint(this.keybindings, "tui.select.down", "↓")}`;
		const pageHint = `${getBindingHint(this.keybindings, "tui.select.pageUp", "PgUp")}/${getBindingHint(this.keybindings, "tui.select.pageDown", "PgDn")}`;
		const cancelHint = getBindingHint(this.keybindings, "tui.select.cancel", "Esc");
		const footerLines: string[] = [
			truncateToWidth(this.theme.fg("borderMuted", "─".repeat(safeWidth)), safeWidth),
			truncateToWidth(
				this.theme.fg(
					"dim",
					`${scrollHint}/${pageHint} scroll • n/p or ←/→ switch • Home/End jump • ${cancelHint} close`,
				),
				safeWidth,
			),
		];

		const viewportHeight = Math.max(8, Math.floor(this.tui.terminal.rows * 0.55));
		const maxScroll = Math.max(0, bodyLines.length - viewportHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));
		const visibleBody = bodyLines.slice(this.scrollOffset, this.scrollOffset + viewportHeight);
		const scrollInfo =
			maxScroll > 0
				? this.theme.fg(
						"dim",
						`[scroll ${this.scrollOffset + 1}-${Math.min(this.scrollOffset + viewportHeight, bodyLines.length)} of ${bodyLines.length}]`,
					)
				: this.theme.fg("dim", `[${bodyLines.length} line(s)]`);

		return [...headerLines, truncateToWidth(scrollInfo, safeWidth), ...visibleBody, ...footerLines];
	}

	invalidate(): void {
		this.invalidateBody();
	}
}

async function showPicker(ctx: ExtensionContext, records: ToolOutputRecord[]): Promise<number | null> {
	const items: SelectItem[] = records.map((record, index) => {
		const icon = record.status === "error" ? "✗" : "✓";
		const label = `${icon} ${record.toolName} · ${record.preview || "(no output)"}`;
		const descriptionParts = [formatTimestamp(record.timestamp)];
		if (record.argsSummary) descriptionParts.push(record.argsSummary);
		return {
			value: String(index),
			label: truncateText(label, 140),
			description: truncateText(descriptionParts.join(" · "), 200),
		};
	});

	return ctx.ui.custom<number | null>(
		(tui, theme, keybindings, done) => {
			const container = new Container();
			const selectList = new SelectList(items, Math.min(Math.max(items.length, 1), 12), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			selectList.onSelect = (item) => done(Number(item.value));
			selectList.onCancel = () => done(null);

			const rebuild = () => {
				container.clear();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Tool Navigator")), 1, 0));
				container.addChild(
					new Text(theme.fg("muted", `Recent tool outputs on the current branch (${records.length})`), 1, 0),
				);
				container.addChild(selectList);
				const confirmHint = getBindingHint(keybindings, "tui.select.confirm", "Enter");
				const cancelHint = getBindingHint(keybindings, "tui.select.cancel", "Esc");
				container.addChild(
					new Text(theme.fg("dim", `Type to filter • ${confirmHint} open • ${cancelHint} cancel`), 1, 0),
				);
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			};

			rebuild();

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					rebuild();
					container.invalidate();
				},
				handleInput(data: string) {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: { width: "78%", maxHeight: "75%", anchor: "center" },
		},
	);
}

async function showViewer(ctx: ExtensionContext, records: ToolOutputRecord[], startIndex: number): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) => {
			return new ToolOutputViewerComponent(records, startIndex, tui, theme, keybindings, () => done());
		},
		{
			overlay: true,
			overlayOptions: { width: "82%", maxHeight: "85%", anchor: "center" },
		},
	);
}

async function openLatest(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("tool-navigator requires interactive mode", "error");
		return;
	}

	const records = extractToolOutputs(ctx);
	if (records.length === 0) {
		ctx.ui.notify("No tool outputs on the current branch", "warning");
		return;
	}
	await showViewer(ctx, records, 0);
}

async function openPicker(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("tool-navigator requires interactive mode", "error");
		return;
	}

	const records = extractToolOutputs(ctx);
	if (records.length === 0) {
		ctx.ui.notify("No tool outputs on the current branch", "warning");
		return;
	}

	const selectedIndex = await showPicker(ctx, records);
	if (selectedIndex === null) return;
	await showViewer(ctx, records, selectedIndex);
}

export default function toolNavigator(pi: ExtensionAPI) {
	pi.registerShortcut(LATEST_SHORTCUT, {
		description: "Open latest tool output",
		handler: async (ctx) => {
			await openLatest(ctx);
		},
	});

	pi.registerShortcut(PICKER_SHORTCUT, {
		description: "Pick a tool output to inspect",
		handler: async (ctx) => {
			await openPicker(ctx);
		},
	});

	pi.registerCommand("tools", {
		description: "Inspect tool outputs: /tools last or /tools nav",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "last", label: "last" },
				{ value: "nav", label: "nav" },
			];
			const trimmed = prefix.trim();
			const filtered = items.filter((item) => item.value.startsWith(trimmed));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "last") {
				await openLatest(ctx);
				return;
			}
			if (action === "nav") {
				await openPicker(ctx);
				return;
			}
			ctx.ui.notify("Usage: /tools last or /tools nav", "info");
		},
	});
}
