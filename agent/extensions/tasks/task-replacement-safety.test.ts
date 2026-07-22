import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __test__ } from "./task.js";
import { setTaskSessionRootForTests } from "./task-session-validation.js";

const session = (file: string, id: string) => ({
	getSessionFile: () => file,
	getSessionId: () => id,
	getBranch: () => [],
});

const runFor = (file: string, id: string) => ({
	internalRunKey: "run-key",
	runId: "run-1",
	toolCallId: "tool-1",
	mode: "single" as const,
	sourceSessionFile: file,
	sourceSessionId: "source",
	steps: [
		{
			step: 1,
			snapshot: {
				childSessionId: id,
				childSessionPath: file,
				persist: true,
				originEntryId: "origin-entry",
				originPreview: "origin",
			},
			status: "succeeded" as const,
			isLive: false,
			hasTerminalMetadata: false,
			warnings: [],
			sourceOrder: 1,
		},
	],
	stepCount: 1,
	persistedStepCount: 1,
	createdAt: "2024-01-01T00:00:00Z",
	updatedAt: "2024-01-01T00:00:00Z",
	status: "succeeded" as const,
	warnings: [],
	latestSourceOrder: 1,
});

describe("task session replacement safety", () => {
	let sessionRoot: string;

	beforeEach(async () => {
		sessionRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "task-replacement-root-"));
		setTaskSessionRootForTests(sessionRoot);
	});

	afterEach(() => {
		setTaskSessionRootForTests(undefined);
	});
	it("waits before switching and only uses the verified replacement callback context", async () => {
		const file = path.join(sessionRoot, `task-replacement-${Date.now()}-${Math.random()}.jsonl`);
		fs.writeFileSync(file, JSON.stringify({ type: "session", id: "child" }) + "\n");
		const calls: string[] = [];
		const ctx: any = {
			...session(path.join(sessionRoot, "old.jsonl"), "old"),
			waitForIdle: async () => calls.push("wait"),
			switchSession: async (_path: string, options: any) => {
				calls.push("switch");
				await options.withSession({ sessionManager: session(path.join(sessionRoot, "wrong.jsonl"), "wrong") });
				await options.withSession({ sessionManager: session(file, "child") });
			},
		};
		const replacements: any[] = [];
		const result = await __test__.openTaskRunSession(ctx, runFor(file, "child") as any, undefined, () =>
			replacements.push("replaced"),
		);
		fs.unlinkSync(file);
		expect(result.opened).toBe(true);
		expect(calls).toEqual(["wait", "switch"]);
		expect(replacements).toEqual(["replaced"]);
	});

	it("rejects a replacement with a wrong path even when its id matches", async () => {
		const file = path.join(sessionRoot, `task-replacement-${Date.now()}-${Math.random()}.jsonl`);
		fs.writeFileSync(file, JSON.stringify({ type: "session", id: "child" }) + "\n");
		const ctx: any = {
			switchSession: async (_path: string, options: any) => {
				await options.withSession({ sessionManager: session(path.join(sessionRoot, "wrong.jsonl"), "child") });
			},
		};
		const result = await __test__.openTaskRunSession(ctx, runFor(file, "child") as any);
		fs.unlinkSync(file);
		expect(result.opened).not.toBe(true);
	});

	it("rejects a replacement with a wrong id even when its path matches", async () => {
		const file = path.join(sessionRoot, `task-replacement-${Date.now()}-${Math.random()}.jsonl`);
		fs.writeFileSync(file, JSON.stringify({ type: "session", id: "child" }) + "\n");
		const ctx: any = {
			switchSession: async (_path: string, options: any) => {
				await options.withSession({ sessionManager: session(file, "wrong") });
			},
		};
		const result = await __test__.openTaskRunSession(ctx, runFor(file, "child") as any);
		fs.unlinkSync(file);
		expect(result.opened).not.toBe(true);
	});

	it("does not trust success without a verified replacement callback", async () => {
		const file = path.join(sessionRoot, `task-replacement-${Date.now()}-${Math.random()}.jsonl`);
		fs.writeFileSync(file, JSON.stringify({ type: "session", id: "child" }) + "\n");
		const ctx: any = { switchSession: async () => true };
		const result = await __test__.openTaskRunSession(ctx, runFor(file, "child") as any);
		fs.unlinkSync(file);
		expect(result.opened).not.toBe(true);
	});

	it("propagates callback errors after replacement without retrying the old context", async () => {
		const file = path.join(sessionRoot, `task-replacement-${Date.now()}-${Math.random()}.jsonl`);
		fs.writeFileSync(file, JSON.stringify({ type: "session", id: "child" }) + "\n");
		const ctx: any = {
			switchSession: async (_path: string, options: any) =>
				options.withSession({ sessionManager: session(file, "child") }),
		};
		await expect(
			__test__.openTaskRunSession(ctx, runFor(file, "child") as any, undefined, () => {
				throw new Error("replacement callback failed");
			}),
		).rejects.toThrow("replacement callback failed");
		fs.unlinkSync(file);
	});

	it("navigates origin only after waiting and matching path plus session ID", async () => {
		const calls: string[] = [];
		const ctx: any = {
			sessionManager: session("source.jsonl", "source"),
			waitForIdle: async () => calls.push("wait"),
			navigateTree: async () => {
				calls.push("navigate");
				return { cancelled: false };
			},
		};
		const result = await __test__.revealTaskRunOrigin(ctx, runFor("source.jsonl", "child") as any);
		expect(result.ok).toBe(true);
		expect(calls).toEqual(["wait", "navigate"]);

		ctx.sessionManager = session("source.jsonl", "wrong-session");
		const mismatched = await __test__.revealTaskRunOrigin(ctx, runFor("source.jsonl", "child") as any);
		expect(mismatched.message).toContain("Origin entry id");
		expect(calls).toEqual(["wait", "navigate"]);
	});

	it("shows the task overlay without waiting for the main session to be idle", async () => {
		// Unlike switchSession/navigateTree (structural session-replacement operations that
		// genuinely need the main turn to settle first), showing the overlay is read-only and
		// must work while a task step is actively running -- that's the whole point of being
		// able to inspect a live task. Waiting here would silently hang until the outer task
		// tool call returns. The risky action *within* the overlay (opening a persisted session)
		// still waits for idle on its own, independently, inside tryOpenTaskSession.
		const calls: string[] = [];
		const ctx: any = {
			hasUI: true,
			mode: "tui",
			waitForIdle: async () => calls.push("wait"),
			ui: {
				custom: async () => {
					calls.push("overlay");
					return undefined;
				},
				notify: () => {},
			},
		};
		await __test__.openTaskViewerOverlay(ctx, "current", runFor("source.jsonl", "child") as any);
		expect(calls).toEqual(["overlay"]);
	});

	it("does not restore stale widget chrome after replacement, but restores cancellation and errors", async () => {
		const calls: string[] = [];
		let file = "old.jsonl";
		const ctx: any = {
			get sessionManager() {
				return session(file, file === "old.jsonl" ? "old" : "new");
			},
			hasUI: true,
			ui: {
				setWidget: (key: string, value: unknown) =>
					calls.push(`${key}:${value === undefined ? "clear" : "set"}`),
				setStatus: () => {},
			},
		};
		__test__.setTaskWidgetEnabled(ctx, true);
		await __test__.withTaskWidgetTemporarilyHidden(ctx, async (replace: () => void) => {
			file = "new.jsonl";
			replace();
		});
		expect(calls.filter((call) => call.endsWith(":set"))).toHaveLength(0);
		file = "old.jsonl";
		__test__.setTaskWidgetEnabled(ctx, true);
		await __test__.withTaskWidgetTemporarilyHidden(ctx, async () => {});
		expect(calls.some((call) => call.endsWith(":set"))).toBe(true);
		const restoredBeforeError = calls.filter((call) => call.endsWith(":set")).length;
		await expect(
			__test__.withTaskWidgetTemporarilyHidden(ctx, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(calls.filter((call) => call.endsWith(":set")).length).toBe(restoredBeforeError + 1);
	});
});
