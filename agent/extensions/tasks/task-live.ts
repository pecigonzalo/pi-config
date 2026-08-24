import path from "node:path";
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";

export type TaskTransport = "rpc";

export interface RpcResponseEnvelope {
	type: "response";
	id?: string;
	command?: string;
	success?: boolean;
	data?: unknown;
	error?: string;
}

interface PendingRpcResponse {
	resolve: (value: RpcResponseEnvelope) => void;
	reject: (error: Error) => void;
}

export interface LiveTaskRpcCommandOptions {
	timeout?: number;
	signal?: AbortSignal;
}

/** Fan-out hub for the raw session events a worker streams over the RPC wire. */
export interface TaskEventHub {
	dispatch(event: Record<string, unknown>): void;
	subscribe(listener: (event: Record<string, unknown>) => void): () => void;
}

export function createTaskEventHub(): TaskEventHub {
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	return {
		dispatch(event) {
			for (const listener of listeners) listener(event);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

export type TaskEventHubLike = TaskEventHub;

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
	transport: TaskTransport;
	proc: ChildProcessWithoutNullStreams;
	/** Working directory the worker was launched in (for tool-render display). */
	cwd: string;
	/** Raw session events streamed by the worker, fanned out to attach-view subscribers. */
	events: TaskEventHub;
	pendingResponses: Map<string, PendingRpcResponse>;
	status: "running" | "completed" | "failed" | "aborted";
	startedAt: string;
	finishedAt?: string;
	lastActivity?: string;
	isStreaming: boolean;
	pendingSteeringCount: number;
	pendingFollowUpCount: number;
	lastMessageCount: number;
	syncCursor: number;
	close: (error?: Error) => Promise<void>;
}

export interface LiveTaskRuntimeInfo {
	transport: TaskTransport;
	status: LiveTaskController["status"];
	lastActivity?: string;
	isStreaming: boolean;
	pendingSteeringCount: number;
	pendingFollowUpCount: number;
	sessionName?: string;
	messageCount?: number;
	messages?: Message[];
	lastAssistantText?: string;
}

/** Default bound for RPC commands that do not provide a timeout. */
export const DEFAULT_LIVE_TASK_RPC_TIMEOUT_MS = 30_000;

const liveTaskControllers = new Map<string, LiveTaskController>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function getFinalAssistantText(messages: Message[]): string | undefined {
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

function createRpcRequestId(command: string): string {
	return `${command}-${randomUUID().slice(0, 8)}`;
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

export function rejectPendingRpcResponses(controller: LiveTaskController, error: Error): void {
	for (const pending of controller.pendingResponses.values()) {
		pending.reject(error);
	}
	controller.pendingResponses.clear();
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

export function sendLiveTaskRpcCommand(
	controller: LiveTaskController,
	command: Record<string, unknown>,
	options: LiveTaskRpcCommandOptions = {},
): Promise<RpcResponseEnvelope> {
	const id = createRpcRequestId(typeof command.type === "string" ? command.type : "cmd");
	const payload = { ...command, id };
	return new Promise<RpcResponseEnvelope>((resolve, reject) => {
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const cleanup = () => {
			if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
			options.signal?.removeEventListener("abort", onAbort);
		};
		const settle = (action: () => void) => {
			if (settled) return;
			settled = true;
			controller.pendingResponses.delete(id);
			cleanup();
			action();
		};
		const onAbort = () => settle(() => reject(new Error("Live task RPC command aborted")));
		const pending: PendingRpcResponse = {
			resolve: (response) => settle(() => resolve(response)),
			reject: (error) => settle(() => reject(error)),
		};
		controller.pendingResponses.set(id, pending);
		if (options.signal?.aborted) {
			onAbort();
			return;
		}
		if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
		const timeoutMs = options.timeout === undefined ? DEFAULT_LIVE_TASK_RPC_TIMEOUT_MS : timeout(options);
		if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
			timeoutHandle = setTimeout(
				() => settle(() => reject(new Error("Live task RPC command timed out"))),
				timeoutMs,
			);
		}
		const stdin = controller.proc.stdin;
		if (stdin.destroyed || stdin.writable === false) {
			settle(() => reject(new Error("Live task RPC stdin is not writable")));
			return;
		}
		try {
			stdin.write(`${JSON.stringify(payload)}\n`, (error?: Error | null) => {
				if (error) settle(() => reject(error));
			});
		} catch (error) {
			settle(() => reject(error instanceof Error ? error : new Error(String(error))));
		}
	});
}

function timeout(options: LiveTaskRpcCommandOptions): number {
	return options.timeout === undefined ? DEFAULT_LIVE_TASK_RPC_TIMEOUT_MS : options.timeout;
}

/** Fetches the worker's current message history over the wire (best effort). */
export async function readLiveTaskMessages(controller: LiveTaskController): Promise<Message[]> {
	try {
		const response = await sendLiveTaskRpcCommand(controller, { type: "get_messages" });
		if (response.success !== false && isRecord(response.data) && Array.isArray(response.data.messages)) {
			return response.data.messages as Message[];
		}
	} catch {
		// Worker gone or busy; empty history is fine for view purposes.
	}
	return [];
}

export async function readLiveTaskRuntimeInfo(controller: LiveTaskController): Promise<LiveTaskRuntimeInfo> {
	const info: LiveTaskRuntimeInfo = {
		transport: controller.transport,
		status: controller.status,
		lastActivity: controller.lastActivity,
		isStreaming: controller.isStreaming,
		pendingSteeringCount: controller.pendingSteeringCount,
		pendingFollowUpCount: controller.pendingFollowUpCount,
	};

	try {
		const stateResponse = await sendLiveTaskRpcCommand(controller, { type: "get_state" });
		if (stateResponse.success !== false && isRecord(stateResponse.data)) {
			const data = stateResponse.data;
			info.isStreaming = typeof data.isStreaming === "boolean" ? data.isStreaming : info.isStreaming;
			info.sessionName = typeof data.sessionName === "string" ? data.sessionName : undefined;
		}
	} catch {
		// Ignore RPC inspection failures; use cached controller state.
	}

	const messages = await readLiveTaskMessages(controller);
	controller.lastMessageCount = messages.length;
	info.messageCount = messages.length;
	info.messages = messages;
	info.lastAssistantText = getFinalAssistantText(messages);

	return info;
}

export function liveTaskSessionDirectory(controller: LiveTaskController): string {
	if (controller.childSessionPath) return path.dirname(controller.childSessionPath);
	return controller.cwd;
}
