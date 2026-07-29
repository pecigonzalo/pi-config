import type { Message } from "@earendil-works/pi-ai";
import type { RpcWorkerHandle, WorkerControlSignal } from "./task-rpc-worker.js";

/**
 * A delegated task step runs as a separate `pi --mode rpc` process (see
 * task-rpc-worker.ts), not in-process -- so a human inspecting one (via `/tasks open`)
 * never disposes the delegating parent's own session. This registry tracks which steps
 * currently have a live worker process so /tasks steer and /tasks view can find them.
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
	session: RpcWorkerHandle;
	/** The worker's task_complete/ask_caller wiring -- reassignable by whoever is currently
	 * awaiting this session's turn (the original run, or a later resumeSessionId call), since
	 * the actual tool calls just read `.onComplete`/`.onPing` off this same object at call time. */
	controlSignal: WorkerControlSignal;
	/** Carried from the original worker config so a later resumeSessionId call knows whether to
	 * keep the session alive after this turn too, without needing the original agent/profile. */
	interactive: boolean;
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

function getFinalAssistantText(messages: readonly Message[]): string | undefined {
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

/** A controller with a live, running AgentSession that can be steered or opened as a session. */
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
 * shared by a fresh launch and a resumeSessionId continuation, so what a controller looks
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
	session: RpcWorkerHandle;
	controlSignal: WorkerControlSignal;
	interactive?: boolean;
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
		controlSignal: params.controlSignal,
		interactive: params.interactive ?? false,
		status: "running",
		startedAt: new Date().toISOString(),
		pendingSteeringCount: 0,
		pendingFollowUpCount: 0,
		close: async () => {},
	};
	const unsubscribe = params.session.subscribe((event) => {
		if (event.type !== "queue_update") return;
		if (Array.isArray(event.steering)) controller.pendingSteeringCount = event.steering.length;
		if (Array.isArray(event.followUp)) controller.pendingFollowUpCount = event.followUp.length;
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

/**
 * Delivers typed input to a live worker's session -- steer() while it's mid-turn (queued for
 * after the current tool calls settle), or prompt() while idle. This matters now that a worker
 * can be "live" (controller registered) while genuinely idle -- an interactive worker paused on
 * ask_caller or a natural turn-end has nothing actively running to steer into; steer() on pi-
 * agent-core is a pure queue push with no run trigger, so it would just sit there unprocessed.
 * Fire-and-forget: callers that need the eventual result (resumeSessionId) call prompt()/steer()
 * directly instead, so they can await and finalize; this is for /tasks steer, which just wants
 * the message delivered, not its result.
 */
export function deliverToLiveSession(
	session: Pick<RpcWorkerHandle, "isStreaming" | "steer" | "prompt">,
	text: string,
): void {
	if (session.isStreaming) void session.steer(text);
	else void session.prompt(text);
}
