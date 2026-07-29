import { describe, expect, it } from "bun:test";
import { TaskAttachOverlay, type TaskAttachOverlayState } from "./task-attach-view.js";

// Uses the real @earendil-works/pi-tui and @earendil-works/pi-coding-agent components
// (DynamicBorder/Text/Markdown/Container, getMarkdownTheme) -- task.test.ts mocks those modules
// for its own, unrelated tests, and bun:test's mock.module() is process-wide rather than
// file-scoped (see oven-sh/bun#12823/#6024), so this test file needs `bun test --isolate`
// (the project's default `bun run test`) to see the real implementations rather than
// task.test.ts's stubs when the whole suite runs together.
const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const fakeKeybindings = {
	matches: () => false,
	getKeys: () => [],
} as any;

function assistantMessage(text: string): any {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function makeOverlay(overrides: Partial<TaskAttachOverlayState> = {}) {
	const requestRenderCalls: number[] = [];
	const sent: string[] = [];
	let closed = false;
	const state: TaskAttachOverlayState = {
		runId: "run-1",
		agent: "worker",
		step: 1,
		initialMessages: [],
		initialStreaming: false,
		...overrides,
	};
	const overlay = new TaskAttachOverlay(
		fakeTheme,
		state,
		fakeKeybindings,
		() => requestRenderCalls.push(1),
		(message) => sent.push(message),
		() => {
			closed = true;
		},
	);
	return {
		overlay,
		requestRenderCalls,
		sent,
		get closed() {
			return closed;
		},
	};
}

function type(overlay: TaskAttachOverlay, text: string): void {
	for (const char of text) overlay.handleInput(char);
}

describe("TaskAttachOverlay", () => {
	it("sends typed text on Enter and clears the input", () => {
		const { overlay, sent } = makeOverlay();
		type(overlay, "hi");
		overlay.handleInput("\r");
		expect(sent).toEqual(["hi"]);
		// Input was cleared -- typing again and sending again produces a fresh message, not "hihi".
		type(overlay, "bye");
		overlay.handleInput("\r");
		expect(sent).toEqual(["hi", "bye"]);
	});

	it("does not send an empty or whitespace-only message", () => {
		const { overlay, sent } = makeOverlay();
		overlay.handleInput("\r");
		type(overlay, "   ");
		overlay.handleInput("\r");
		expect(sent).toEqual([]);
	});

	it("closes (detaches) on Escape without sending anything", () => {
		const { overlay, sent } = makeOverlay();
		type(overlay, "unsent");
		overlay.handleInput("\x1b");
		expect(sent).toEqual([]);
	});

	it("appendMessages grows the transcript and requests a re-render", () => {
		const { overlay, requestRenderCalls } = makeOverlay();
		overlay.appendMessages([assistantMessage("hello there")]);
		expect(requestRenderCalls.length).toBeGreaterThan(0);
		expect(overlay.render(80).join("\n")).toContain("hello there");
	});

	it("appendNotice shows a plain system notice", () => {
		const { overlay } = makeOverlay();
		overlay.appendNotice("task_complete called");
		expect(overlay.render(80).join("\n")).toContain("task_complete called");
	});

	it("setStreaming/setError update rendered state", () => {
		const { overlay } = makeOverlay();
		overlay.setStreaming(true);
		expect(overlay.render(80).join("\n")).toContain("streaming");
		overlay.setError("worker process exited");
		expect(overlay.render(80).join("\n")).toContain("worker process exited");
	});

	it("shows initial messages from construction", () => {
		const { overlay } = makeOverlay({ initialMessages: [assistantMessage("hello there")] });
		expect(overlay.render(80).join("\n")).toContain("hello there");
	});

	it("renders without a hand-drawn box border -- just DynamicBorder rules and plain rows", () => {
		const { overlay } = makeOverlay();
		const rendered = overlay.render(80).join("\n");
		expect(rendered).not.toContain("╭");
		expect(rendered).not.toContain("╮");
		expect(rendered).not.toContain("╰");
		expect(rendered).not.toContain("╯");
	});
});
