import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	type Focusable,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface TaskTranscriptPreview {
	lines: string[];
	sourceLabel: string;
	truncated: boolean;
	error?: string;
}

export interface TaskViewerOverlayState {
	runId: string;
	runStatus: string;
	runMode: string;
	detailText: string;
	transcript: TaskTranscriptPreview;
	canOpen: boolean;
	canAttach: boolean;
	canOrigin: boolean;
	canSteer: boolean;
	attachActionLabel: string;
}

export interface TaskViewerOverlayResult {
	action: "close" | "open" | "attach" | "origin" | "steer";
	message?: string;
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

export class TaskViewerOverlay implements Focusable {
	focused = false;
	private steerText = "";
	private steerCursor = 0;
	private transcriptScroll = 0;

	constructor(
		private readonly theme: any,
		private readonly state: TaskViewerOverlayState,
		private readonly keybindings: KeybindingsManager,
		private readonly done: (value: TaskViewerOverlayResult | undefined) => void,
	) {
		this.transcriptScroll = Math.max(0, state.transcript.lines.length - this.getTranscriptViewportSize());
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
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "ctrl+o") && this.state.canOpen) {
			this.done({ action: "open" });
			return;
		}
		if (matchesKey(data, "ctrl+a") && this.state.canAttach) {
			this.done({ action: "attach" });
			return;
		}
		if (matchesKey(data, "ctrl+g") && this.state.canOrigin) {
			this.done({ action: "origin" });
			return;
		}
		if (this.matchesBinding(data, "tui.select.up", ["up"])) {
			this.transcriptScroll = Math.max(0, this.transcriptScroll - 1);
			return;
		}
		if (this.matchesBinding(data, "tui.select.down", ["down"])) {
			this.transcriptScroll = Math.min(
				Math.max(0, this.state.transcript.lines.length - this.getTranscriptViewportSize()),
				this.transcriptScroll + 1,
			);
			return;
		}
		if (!this.state.canSteer) return;
		if (matchesKey(data, "ctrl+s") || this.matchesBinding(data, "tui.select.confirm", ["return", "enter"])) {
			const message = this.steerText.trim();
			if (!message) return;
			this.done({ action: "steer", message });
			return;
		}
		if (this.matchesBinding(data, "tui.editor.deleteCharBackward", ["backspace"])) {
			if (this.steerCursor > 0) {
				this.steerText = this.steerText.slice(0, this.steerCursor - 1) + this.steerText.slice(this.steerCursor);
				this.steerCursor--;
			}
			return;
		}
		if (this.matchesBinding(data, "tui.editor.deleteCharForward", ["delete"])) {
			if (this.steerCursor < this.steerText.length) {
				this.steerText = this.steerText.slice(0, this.steerCursor) + this.steerText.slice(this.steerCursor + 1);
			}
			return;
		}
		if (this.matchesBinding(data, "tui.editor.cursorLeft", ["left"])) {
			this.steerCursor = Math.max(0, this.steerCursor - 1);
			return;
		}
		if (this.matchesBinding(data, "tui.editor.cursorRight", ["right"])) {
			this.steerCursor = Math.min(this.steerText.length, this.steerCursor + 1);
			return;
		}
		if (this.matchesBinding(data, "tui.editor.cursorLineStart", ["home"])) {
			this.steerCursor = 0;
			return;
		}
		if (this.matchesBinding(data, "tui.editor.cursorLineEnd", ["end"])) {
			this.steerCursor = this.steerText.length;
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.steerText = this.steerText.slice(0, this.steerCursor) + data + this.steerText.slice(this.steerCursor);
			this.steerCursor += data.length;
		}
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (width === 1) return [" "];
		const innerWidth = Math.max(0, width - 2);
		const lines: string[] = [];
		const border = this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`);
		const borderBottom = this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
		const row = (content = "") => {
			const truncated = truncateToWidth(content, innerWidth);
			const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
			return this.theme.fg("border", "│") + truncated + pad + this.theme.fg("border", "│");
		};
		const pushWrapped = (content: string) => {
			for (const line of wrapTextWithAnsi(content, Math.max(1, innerWidth))) lines.push(row(line));
		};
		const summaryLines = this.state.detailText.split("\n").slice(0, 9);
		const viewport = this.getTranscriptViewportSize();
		const transcriptLines = this.state.transcript.lines.slice(
			this.transcriptScroll,
			this.transcriptScroll + viewport,
		);

		lines.push(border);
		pushWrapped(this.theme.bold(this.theme.fg("accent", `Task viewer · ${this.state.runId}`)));
		pushWrapped(
			this.theme.fg(
				"muted",
				`status:${this.state.runStatus} · mode:${this.state.runMode} · ${this.state.transcript.sourceLabel}`,
			),
		);
		lines.push(row());
		for (const summary of summaryLines) pushWrapped(summary);
		lines.push(row());
		pushWrapped(this.theme.fg("muted", "Transcript"));
		for (const line of transcriptLines) pushWrapped(line);
		if (this.state.transcript.error)
			pushWrapped(this.theme.fg("warning", `Transcript note: ${this.state.transcript.error}`));
		if (this.state.transcript.truncated)
			pushWrapped(this.theme.fg("dim", "Showing the latest transcript messages."));
		lines.push(row());

		const scrollHint = `${this.bindingHint("tui.select.up", "↑")}/${this.bindingHint("tui.select.down", "↓")}`;
		const cancelHint = this.bindingHint("tui.select.cancel", "Esc");
		if (this.state.canSteer) {
			const before = this.steerText.slice(0, this.steerCursor);
			const cursorChar = this.steerCursor < this.steerText.length ? this.steerText[this.steerCursor] : " ";
			const after = this.steerText.slice(this.steerCursor + 1);
			const marker = this.focused ? CURSOR_MARKER : "";
			const submitHint = `${this.bindingHint("tui.select.confirm", "Enter")}/Ctrl+S`;
			pushWrapped(this.theme.fg("muted", "Steer message"));
			pushWrapped(`${before}${marker}\x1b[7m${cursorChar}\x1b[27m${after}`);
			pushWrapped(
				this.theme.fg(
					"dim",
					`${submitHint} send · Ctrl+O open · Ctrl+A attach · Ctrl+G origin · ${scrollHint} scroll · ${cancelHint} close`,
				),
			);
		} else {
			pushWrapped(
				this.theme.fg(
					"dim",
					`${this.state.attachActionLabel}: Ctrl+A · Open: Ctrl+O · Origin: Ctrl+G · ${scrollHint} scroll · ${cancelHint} close`,
				),
			);
		}
		lines.push(borderBottom);
		return lines;
	}

	invalidate(): void {}

	private getTranscriptViewportSize(): number {
		return this.state.canSteer ? 8 : 10;
	}
}
