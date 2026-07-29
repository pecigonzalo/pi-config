import type { Message } from "@earendil-works/pi-ai";
import { DynamicBorder, getMarkdownTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Container, CURSOR_MARKER, type Focusable, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";
import { type DisplayItem, formatToolCall, getDisplayItems, truncateOutput } from "./task-display.js";

/**
 * A persistent, live-updating view onto a still-running delegated worker -- the "attach" side of
 * `/tasks open`. Renders with the same building blocks (`DynamicBorder`, `Text`, `Markdown`) the
 * rest of pi's own TUI uses for dialogs and task output (see `agent/extensions/tool-navigator`'s
 * picker and `task-display.ts`'s `appendTaskOutputSection`) rather than hand-drawn box-art, so it
 * reads as a real transcript instead of a bespoke widget. Unlike the old one-shot task viewer
 * (removed: it never actually live-tailed), this stays open across multiple exchanges: the caller
 * pushes new messages in via `appendMessages()` as the worker's own event stream produces them,
 * and the user can type and send messages that get delivered straight into the same running
 * worker process (steer/prompt on its `RpcWorkerHandle`) -- never a second session object, never
 * a write to the worker's own session file. Closing (Esc) just detaches; it never touches the
 * worker process.
 */
export interface TaskAttachOverlayState {
	runId: string;
	agent: string;
	step: number;
	initialMessages: Message[];
	initialStreaming: boolean;
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
			if (token.length === 1) return token.toUpperCase();
			return token.charAt(0).toUpperCase() + token.slice(1);
		})
		.join("+");
}

export class TaskAttachOverlay implements Focusable {
	focused = false;
	private readonly transcript = new Container();
	private readonly mdTheme = getMarkdownTheme();
	private streaming: boolean;
	private hasMessages: boolean;
	private inputText = "";
	private inputCursor = 0;
	private lastError: string | undefined;

	constructor(
		private readonly theme: any,
		private readonly state: TaskAttachOverlayState,
		private readonly keybindings: KeybindingsManager,
		private readonly requestRender: () => void,
		private readonly onSend: (message: string) => void,
		private readonly onClose: () => void,
	) {
		this.streaming = state.initialStreaming;
		this.hasMessages = state.initialMessages.length > 0;
		for (const item of getDisplayItems(state.initialMessages)) this.appendDisplayItem(item);
	}

	/** Called from outside -- the caller's own subscription to the worker's event stream -- as new
	 * messages arrive. */
	appendMessages(messages: Message[]): void {
		if (messages.length === 0) return;
		this.hasMessages = true;
		for (const item of getDisplayItems(messages)) this.appendDisplayItem(item);
		this.requestRender();
	}

	/** A plain system notice (e.g. "task_complete called"), distinct from the worker's own
	 * transcript content. */
	appendNotice(text: string): void {
		this.hasMessages = true;
		this.transcript.addChild(new Text(this.theme.fg("warning", text), 1, 0));
		this.requestRender();
	}

	setStreaming(streaming: boolean): void {
		if (this.streaming === streaming) return;
		this.streaming = streaming;
		this.requestRender();
	}

	setError(message: string | undefined): void {
		this.lastError = message;
		this.requestRender();
	}

	private appendDisplayItem(item: DisplayItem): void {
		const fg = this.theme.fg.bind(this.theme);
		if (item.type === "text") {
			if (item.text.trim()) this.transcript.addChild(new Markdown(item.text.trim(), 1, 0, this.mdTheme));
			return;
		}
		if (item.type === "toolCall") {
			this.transcript.addChild(new Text(`${fg("muted", "→ ")}${formatToolCall(item.name, item.args, fg)}`, 1, 0));
			return;
		}
		const icon = item.isError ? fg("error", "✗") : fg("success", "✓");
		this.transcript.addChild(new Text(`${fg("muted", "↳ ")}${icon} ${fg("muted", `${item.name} result`)}`, 1, 0));
		if (item.text) this.transcript.addChild(new Text(fg(item.isError ? "error" : "dim", item.text), 1, 0));
		if (item.diff) {
			this.transcript.addChild(new Text(fg("muted", "diff:"), 1, 0));
			this.transcript.addChild(
				new Markdown(`\`\`\`diff\n${truncateOutput(item.diff).trim()}\n\`\`\``, 1, 0, this.mdTheme),
			);
		}
	}

	private matchesBinding(data: string, binding: string, fallbackKeys: string[]): boolean {
		if (this.keybindings.matches(data, binding as any)) return true;
		return fallbackKeys.some((key) => matchesKey(data, key as any));
	}

	private bindingHint(binding: string, fallback: string): string {
		const keys = this.keybindings.getKeys(binding as any);
		if (!Array.isArray(keys) || keys.length === 0) return fallback;
		return keys.map((key) => formatKeyLabel(key)).join("/");
	}

	handleInput(data: string): void {
		if (this.matchesBinding(data, "tui.select.cancel", ["escape", "ctrl+c"])) {
			this.onClose();
			return;
		}
		if (this.matchesBinding(data, "tui.select.confirm", ["return", "enter"])) {
			const message = this.inputText.trim();
			if (message) {
				this.onSend(message);
				this.lastError = undefined;
				this.inputText = "";
				this.inputCursor = 0;
			}
			this.requestRender();
			return;
		}
		if (this.matchesBinding(data, "tui.editor.deleteCharBackward", ["backspace"])) {
			if (this.inputCursor > 0) {
				this.inputText = this.inputText.slice(0, this.inputCursor - 1) + this.inputText.slice(this.inputCursor);
				this.inputCursor--;
			}
		} else if (this.matchesBinding(data, "tui.editor.deleteCharForward", ["delete"])) {
			if (this.inputCursor < this.inputText.length) {
				this.inputText = this.inputText.slice(0, this.inputCursor) + this.inputText.slice(this.inputCursor + 1);
			}
		} else if (this.matchesBinding(data, "tui.editor.cursorLeft", ["left"])) {
			this.inputCursor = Math.max(0, this.inputCursor - 1);
		} else if (this.matchesBinding(data, "tui.editor.cursorRight", ["right"])) {
			this.inputCursor = Math.min(this.inputText.length, this.inputCursor + 1);
		} else if (this.matchesBinding(data, "tui.editor.cursorLineStart", ["home"])) {
			this.inputCursor = 0;
		} else if (this.matchesBinding(data, "tui.editor.cursorLineEnd", ["end"])) {
			this.inputCursor = this.inputText.length;
		} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.inputText = this.inputText.slice(0, this.inputCursor) + data + this.inputText.slice(this.inputCursor);
			this.inputCursor += data.length;
		} else {
			return;
		}
		this.requestRender();
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const fg = this.theme.fg.bind(this.theme);
		const border = new DynamicBorder((s: string) => fg("accent", s));
		const lines: string[] = [];

		lines.push(...border.render(width));
		lines.push(
			...new Text(
				fg("accent", this.theme.bold(`Attached · ${this.state.agent} step ${this.state.step}`)),
				1,
				0,
			).render(width),
		);
		lines.push(...new Text(fg("muted", this.streaming ? "streaming…" : "idle"), 1, 0).render(width));
		lines.push(...border.render(width));

		if (this.hasMessages) lines.push(...this.transcript.render(width));
		else lines.push(...new Text(fg("dim", "(no messages yet)"), 1, 0).render(width));

		lines.push(...border.render(width));
		const before = this.inputText.slice(0, this.inputCursor);
		const cursorChar = this.inputCursor < this.inputText.length ? this.inputText[this.inputCursor] : " ";
		const after = this.inputText.slice(this.inputCursor + 1);
		const marker = this.focused ? CURSOR_MARKER : "";
		lines.push(...new Text(`${before}${marker}\x1b[7m${cursorChar}\x1b[27m${after}`, 1, 0).render(width));
		if (this.lastError) lines.push(...new Text(fg("error", this.lastError), 1, 0).render(width));
		const sendHint = this.bindingHint("tui.select.confirm", "Enter");
		const cancelHint = this.bindingHint("tui.select.cancel", "Esc");
		lines.push(...new Text(fg("dim", `${sendHint} send · ${cancelHint} detach`), 1, 0).render(width));
		return lines;
	}

	invalidate(): void {
		this.transcript.invalidate();
	}
}
