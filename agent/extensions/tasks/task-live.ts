import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * A delegated task step now runs as a real, in-process AgentSession (see
 * task-agent-session.ts) rather than a spawned subprocess -- no pty, no RPC-over-pipes
 * protocol, no separate process to escalate-kill. This registry just tracks which steps
 * currently have a live session so /tasks attach, /tasks steer, and /tasks show can find them.
 */
export interface LiveTaskController {
	key: string;
	toolCallId: string;
	runId: string;
	step: number;
	childSessionId: string;
	childSessionPath: string;
	parentSessionPath?: string;
	task: string;
	agent: string;
	session: AgentSession;
	status: "running" | "completed" | "failed" | "aborted";
	startedAt: string;
	finishedAt?: string;
	pendingSteeringCount: number;
	pendingFollowUpCount: number;
	close: (error?: Error) => Promise<void>;
}

export interface LiveTaskRuntimeInfo {
	status: LiveTaskController["status"];
	isStreaming: boolean;
	pendingSteeringCount: number;
	pendingFollowUpCount: number;
	messageCount: number;
	lastAssistantText?: string;
}

const liveTaskControllers = new Map<string, LiveTaskController>();

function getFinalAssistantText(messages: readonly AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string")
				return part.text;
		}
	}
	return undefined;
}

export function setLiveTaskController(controller: LiveTaskController): void {
	liveTaskControllers.set(controller.key, controller);
}

export function getLiveTaskController(key: string): LiveTaskController | undefined {
	return liveTaskControllers.get(key);
}

export function deleteLiveTaskController(key: string): void {
	liveTaskControllers.delete(key);
}

export function listLiveTaskControllers(): LiveTaskController[] {
	return Array.from(liveTaskControllers.values());
}

export function clearLiveTaskControllers(): void {
	liveTaskControllers.clear();
}

/** A controller with a live, running AgentSession a human can attach to or steer. */
export function isLiveController(controller: LiveTaskController | undefined): controller is LiveTaskController {
	return controller?.status === "running";
}

/** Wraps a controller shutdown path so every caller observes the same closure. */
export function createIdempotentControllerClose(
	closePath: (error: Error) => Promise<void>,
): (error?: Error) => Promise<void> {
	let closePromise: Promise<void> | undefined;
	return (error = new Error("Task controller closed")) => {
		closePromise ??= closePath(error);
		return closePromise;
	};
}

/**
 * Builds, wires, and registers a controller for an in-process AgentSession-backed task step --
 * shared by a fresh launch and a resume-a-completed-task attach, so what a controller looks
 * like can't drift between the two call sites. Subscribes to the session's own queue_update
 * events to keep the pending steering/follow-up counts current; callers remain responsible for
 * their own completion/exit handling (awaited vs fire-and-forget), since that genuinely differs
 * between them.
 */
export function registerAgentSessionController(params: {
	key: string;
	toolCallId: string;
	runId: string;
	step: number;
	childSessionId: string;
	childSessionPath: string;
	parentSessionPath?: string;
	task: string;
	agent: string;
	session: AgentSession;
	close: (error: Error) => Promise<void>;
}): LiveTaskController {
	const controller: LiveTaskController = {
		key: params.key,
		toolCallId: params.toolCallId,
		runId: params.runId,
		step: params.step,
		childSessionId: params.childSessionId,
		childSessionPath: params.childSessionPath,
		parentSessionPath: params.parentSessionPath,
		task: params.task,
		agent: params.agent,
		session: params.session,
		status: "running",
		startedAt: new Date().toISOString(),
		pendingSteeringCount: 0,
		pendingFollowUpCount: 0,
		close: async () => {},
	};
	const unsubscribe = params.session.subscribe((event) => {
		if (event.type === "queue_update") {
			controller.pendingSteeringCount = event.steering.length;
			controller.pendingFollowUpCount = event.followUp.length;
		}
	});
	controller.close = createIdempotentControllerClose(async (error) => {
		unsubscribe();
		await params.close(error);
	});
	setLiveTaskController(controller);
	return controller;
}

export function readLiveTaskRuntimeInfo(controller: LiveTaskController): LiveTaskRuntimeInfo {
	return {
		status: controller.status,
		isStreaming: controller.session.isStreaming,
		pendingSteeringCount: controller.pendingSteeringCount,
		pendingFollowUpCount: controller.pendingFollowUpCount,
		messageCount: controller.session.messages.length,
		lastAssistantText: getFinalAssistantText(controller.session.messages),
	};
}
