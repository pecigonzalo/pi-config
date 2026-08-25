import { describe, expect, test } from "bun:test";
import {
	createIdempotentControllerClose,
	createTaskEventHub,
	DEFAULT_LIVE_TASK_RPC_TIMEOUT_MS,
	sendLiveTaskRpcCommand,
	type LiveTaskController,
} from "./task-live.js";

function createController(write: (data: string, callback: (error?: Error | null) => void) => void): LiveTaskController {
	return {
		key: "test",
		toolCallId: "tool",
		runId: "run",
		step: 1,
		childSessionId: "session",
		childSessionPath: "session.jsonl",
		task: "task",
		agent: "agent",
		cwd: "/tmp/worker",
		events: createTaskEventHub(),
		proc: { stdin: { destroyed: false, writable: true, write } } as unknown as LiveTaskController["proc"],
		pendingResponses: new Map(),
		status: "running",
		startedAt: new Date().toISOString(),
		isStreaming: false,
		pendingSteeringCount: 0,
		pendingFollowUpCount: 0,
		lastMessageCount: 0,
		syncCursor: 0,
		close: async () => {},
	};
}

describe("controller close", () => {
	test("is idempotent and returns the same pending closure", async () => {
		let calls = 0;
		let finish: (() => void) | undefined;
		const close = createIdempotentControllerClose(async () => {
			calls += 1;
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
		});

		const first = close();
		const second = close(new Error("later reason"));
		expect(first).toBe(second);
		expect(calls).toBe(1);
		finish?.();
		await first;
		expect(close()).toBe(first);
	});
});

describe("sendLiveTaskRpcCommand", () => {
	test("cleans the pending request after a response", async () => {
		const controller = createController((_data, callback) => callback());
		const promise = sendLiveTaskRpcCommand(controller, { type: "ping" });
		const pending = [...controller.pendingResponses.values()][0];
		pending?.resolve({ type: "response", success: true });
		await expect(promise).resolves.toMatchObject({ success: true });
		expect(controller.pendingResponses).toHaveLength(0);
	});

	test("rejects and cleans up on timeout", async () => {
		const controller = createController((_data, callback) => callback());
		const promise = sendLiveTaskRpcCommand(controller, { type: "ping" }, { timeout: 1 });
		await expect(promise).rejects.toThrow("timed out");
		expect(controller.pendingResponses).toHaveLength(0);
	});

	test("uses the bounded default timeout and cleans up omitted-timeout requests", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		let timeoutCallback: (() => void) | undefined;
		let timeoutMs: number | undefined;
		globalThis.setTimeout = ((callback: () => void, delay?: number) => {
			timeoutCallback = callback;
			timeoutMs = delay;
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		try {
			const controller = createController((_data, callback) => callback());
			const promise = sendLiveTaskRpcCommand(controller, { type: "ping" });

			expect(timeoutMs).toBe(DEFAULT_LIVE_TASK_RPC_TIMEOUT_MS);
			expect(controller.pendingResponses).toHaveLength(1);
			timeoutCallback?.();

			await expect(promise).rejects.toThrow("timed out");
			expect(controller.pendingResponses).toHaveLength(0);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
		}
	});

	test("rejects and cleans up on abort", async () => {
		const controller = createController((_data, callback) => callback());
		const abortController = new AbortController();
		const promise = sendLiveTaskRpcCommand(controller, { type: "ping" }, { signal: abortController.signal });
		abortController.abort();
		await expect(promise).rejects.toThrow("aborted");
		expect(controller.pendingResponses).toHaveLength(0);
	});

	test("rejects and cleans up on write failure", async () => {
		const controller = createController((_data, callback) => callback(new Error("EPIPE")));
		const promise = sendLiveTaskRpcCommand(controller, { type: "ping" });
		await expect(promise).rejects.toThrow("EPIPE");
		expect(controller.pendingResponses).toHaveLength(0);
	});
});
