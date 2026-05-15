import {
	CURSOR_MARKER,
	type Focusable,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

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

export class TaskViewerOverlay implements Focusable {
	focused = false;
	private steerText = "";
	private steerCursor = 0;
	private transcriptScroll = 0;

	constructor(
		private readonly theme: any,
		private readonly state: TaskViewerOverlayState,
		private readonly done: (value: TaskViewerOverlayResult | undefined) => void,
	) {
		this.transcriptScroll = Math.max(0, state.transcript.lines.length - this.getTranscriptViewportSize());
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
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
		if (matchesKey(data, "up")) {
			this.transcriptScroll = Math.max(0, this.transcriptScroll - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.transcriptScroll = Math.min(
				Math.max(0, this.state.transcript.lines.length - this.getTranscriptViewportSize()),
				this.transcriptScroll + 1,
			);
			return;
		}
		if (!this.state.canSteer) return;
		if (matchesKey(data, "ctrl+s") || matchesKey(data, "return")) {
			const message = this.steerText.trim();
			if (!message) return;
			this.done({ action: "steer", message });
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.steerCursor > 0) {
				this.steerText = this.steerText.slice(0, this.steerCursor - 1) + this.steerText.slice(this.steerCursor);
				this.steerCursor--;
			}
			return;
		}
		if (matchesKey(data, "delete")) {
			if (this.steerCursor < this.steerText.length) {
				this.steerText = this.steerText.slice(0, this.steerCursor) + this.steerText.slice(this.steerCursor + 1);
			}
			return;
		}
		if (matchesKey(data, "left")) {
			this.steerCursor = Math.max(0, this.steerCursor - 1);
			return;
		}
		if (matchesKey(data, "right")) {
			this.steerCursor = Math.min(this.steerText.length, this.steerCursor + 1);
			return;
		}
		if (matchesKey(data, "home")) {
			this.steerCursor = 0;
			return;
		}
		if (matchesKey(data, "end")) {
			this.steerCursor = this.steerText.length;
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.steerText = this.steerText.slice(0, this.steerCursor) + data + this.steerText.slice(this.steerCursor);
			this.steerCursor += data.length;
		}
	}

	render(width: number): string[] {
		const innerWidth = Math.max(30, width - 2);
		const lines: string[] = [];
		const border = this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`);
		const borderBottom = this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
		const row = (content = "") => {
			const truncated = truncateToWidth(content, innerWidth);
			const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
			return this.theme.fg("border", "│") + truncated + pad + this.theme.fg("border", "│");
		};
		const pushWrapped = (content: string) => {
			for (const line of wrapTextWithAnsi(content, innerWidth)) lines.push(row(line));
		};
		const summaryLines = this.state.detailText.split("\n").slice(0, 9);
		const viewport = this.getTranscriptViewportSize();
		const transcriptLines = this.state.transcript.lines.slice(this.transcriptScroll, this.transcriptScroll + viewport);

		lines.push(border);
		pushWrapped(this.theme.bold(this.theme.fg("accent", `Task viewer · ${this.state.runId}`)));
		pushWrapped(this.theme.fg("muted", `status:${this.state.runStatus} · mode:${this.state.runMode} · ${this.state.transcript.sourceLabel}`));
		lines.push(row());
		for (const summary of summaryLines) pushWrapped(summary);
		lines.push(row());
		pushWrapped(this.theme.fg("muted", "Transcript"));
		for (const line of transcriptLines) pushWrapped(line);
		if (this.state.transcript.error) pushWrapped(this.theme.fg("warning", `Transcript note: ${this.state.transcript.error}`));
		if (this.state.transcript.truncated) pushWrapped(this.theme.fg("dim", "Showing the latest transcript messages."));
		lines.push(row());
		if (this.state.canSteer) {
			const before = this.steerText.slice(0, this.steerCursor);
			const cursorChar = this.steerCursor < this.steerText.length ? this.steerText[this.steerCursor] : " ";
			const after = this.steerText.slice(this.steerCursor + 1);
			const marker = this.focused ? CURSOR_MARKER : "";
			pushWrapped(this.theme.fg("muted", "Steer message"));
			pushWrapped(`${before}${marker}\x1b[7m${cursorChar}\x1b[27m${after}`);
			pushWrapped(this.theme.fg("dim", "Enter/Ctrl+S send · Ctrl+O open · Ctrl+A attach · Ctrl+G origin · ↑↓ scroll · Esc close"));
		} else {
			pushWrapped(this.theme.fg("dim", `${this.state.attachActionLabel}: Ctrl+A · Open: Ctrl+O · Origin: Ctrl+G · ↑↓ scroll · Esc close`));
		}
		lines.push(borderBottom);
		return lines;
	}

	invalidate(): void {}

	private getTranscriptViewportSize(): number {
		return this.state.canSteer ? 8 : 10;
	}
}
