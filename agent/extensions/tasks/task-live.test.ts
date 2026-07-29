import { describe, expect, test } from "bun:test";
import type { RpcWorkerEvent, RpcWorkerHandle, RpcWorkerListener } from "./task-rpc-worker.js";
import {
	clearLiveTaskControllers,
	createIdempotentControllerClose,
	deleteLiveTaskController,
	deliverToLiveSession,
	getLiveTaskController,
	isLiveController,
	listLiveTaskControllers,
	readLiveTaskRuntimeInfo,
	registerAgentSessionController,
	setLiveTaskController,
} from "./task-live.js";

const noopControlSignal = { onComplete: () => {}, onPing: () => {} };

function createFakeSession(overrides: Partial<RpcWorkerHandle> = {}): RpcWorkerHandle {
	let listener: RpcWorkerListener | undefined;
	const fake = {
		sessionManager: { getSessionId: () => "worker-session", getSessionFile: () => undefined },
		messages: [],
		isStreaming: false,
		subscribe: (l: RpcWorkerListener) => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		prompt: async () => {},
		steer: async () => {},
		abort: async () => {},
		dispose: () => {},
		emit: (event: RpcWorkerEvent) => listener?.(event),
		...overrides,
	};
	return fake as unknown as RpcWorkerHandle;
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

describe("registerAgentSessionController", () => {
	test("registers a running controller and unregisters it on close", async () => {
		clearLiveTaskControllers();
		const session = createFakeSession();
		const controller = registerAgentSessionController({
			key: "run-1-step-1",
			toolCallId: "tool-1",
			runId: "run-1",
			step: 1,
			childSessionId: "child-1",
			childSessionPath: "/tmp/child-1.jsonl",
			task: "do the thing",
			agent: "generic",
			session,
			controlSignal: noopControlSignal,
			close: async () => {},
		});

		expect(controller.status).toBe("running");
		expect(getLiveTaskController("run-1-step-1")).toBe(controller);
		expect(isLiveController(controller)).toBe(true);

		await controller.close();
		deleteLiveTaskController(controller.key);
		expect(getLiveTaskController("run-1-step-1")).toBeUndefined();
	});

	test("tracks pending steering/follow-up counts from queue_update events", () => {
		clearLiveTaskControllers();
		const session = createFakeSession() as RpcWorkerHandle & { emit: (event: RpcWorkerEvent) => void };
		const controller = registerAgentSessionController({
			key: "run-2-step-1",
			toolCallId: "tool-2",
			runId: "run-2",
			step: 1,
			childSessionId: "child-2",
			childSessionPath: "/tmp/child-2.jsonl",
			task: "do another thing",
			agent: "generic",
			session,
			controlSignal: noopControlSignal,
			close: async () => {},
		});

		expect(controller.pendingSteeringCount).toBe(0);
		session.emit({ type: "queue_update", steering: ["a", "b"], followUp: ["c"] });
		expect(controller.pendingSteeringCount).toBe(2);
		expect(controller.pendingFollowUpCount).toBe(1);
	});

	test("listLiveTaskControllers reflects the registry", () => {
		clearLiveTaskControllers();
		const controller = registerAgentSessionController({
			key: "run-3-step-1",
			toolCallId: "tool-3",
			runId: "run-3",
			step: 1,
			childSessionId: "child-3",
			childSessionPath: "/tmp/child-3.jsonl",
			task: "list me",
			agent: "generic",
			session: createFakeSession(),
			controlSignal: noopControlSignal,
			close: async () => {},
		});
		expect(listLiveTaskControllers()).toContain(controller);
		clearLiveTaskControllers();
		expect(listLiveTaskControllers()).toHaveLength(0);
	});
});

describe("isLiveController", () => {
	test("is false for undefined and for non-running statuses", () => {
		expect(isLiveController(undefined)).toBe(false);
		const controller = registerAgentSessionController({
			key: "run-4-step-1",
			toolCallId: "tool-4",
			runId: "run-4",
			step: 1,
			childSessionId: "child-4",
			childSessionPath: "/tmp/child-4.jsonl",
			task: "finish",
			agent: "generic",
			session: createFakeSession(),
			controlSignal: noopControlSignal,
			close: async () => {},
		});
		expect(isLiveController(controller)).toBe(true);
		controller.status = "completed";
		expect(isLiveController(controller)).toBe(false);
	});
});

describe("readLiveTaskRuntimeInfo", () => {
	test("reflects live session state and the final assistant message", () => {
		const session = createFakeSession({
			isStreaming: true,
			messages: [
				{ role: "user", content: [{ type: "text", text: "Task: do it" }] },
				{ role: "assistant", content: [{ type: "text", text: "Working on it" }] },
			],
		} as Partial<RpcWorkerHandle>);
		setLiveTaskController({
			key: "run-5-step-1",
			toolCallId: "tool-5",
			runId: "run-5",
			step: 1,
			childSessionId: "child-5",
			childSessionPath: "/tmp/child-5.jsonl",
			task: "do it",
			agent: "generic",
			session,
			status: "running",
			startedAt: new Date().toISOString(),
			pendingSteeringCount: 1,
			pendingFollowUpCount: 0,
			controlSignal: noopControlSignal,
			interactive: false,
			close: async () => {},
		});

		const info = readLiveTaskRuntimeInfo(getLiveTaskController("run-5-step-1")!);
		expect(info.status).toBe("running");
		expect(info.isStreaming).toBe(true);
		expect(info.pendingSteeringCount).toBe(1);
		expect(info.messageCount).toBe(2);
		expect(info.lastAssistantText).toBe("Working on it");
		deleteLiveTaskController("run-5-step-1");
	});
});

describe("deliverToLiveSession", () => {
	test("prompts an idle session instead of just queueing a steer that nothing would drain", () => {
		let promptedWith: string | undefined;
		let steeredWith: string | undefined;
		const session = {
			isStreaming: false,
			prompt: (text: string) => {
				promptedWith = text;
			},
			steer: (text: string) => {
				steeredWith = text;
			},
		} as unknown as RpcWorkerHandle;

		deliverToLiveSession(session, "hello");

		expect(promptedWith).toBe("hello");
		expect(steeredWith).toBeUndefined();
	});

	test("steers a mid-turn session instead of starting a second run", () => {
		let promptedWith: string | undefined;
		let steeredWith: string | undefined;
		const session = {
			isStreaming: true,
			prompt: (text: string) => {
				promptedWith = text;
			},
			steer: (text: string) => {
				steeredWith = text;
			},
		} as unknown as RpcWorkerHandle;

		deliverToLiveSession(session, "hello");

		expect(steeredWith).toBe("hello");
		expect(promptedWith).toBeUndefined();
	});
});
