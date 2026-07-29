import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { Message } from "@earendil-works/pi-ai";

/**
 * Runs a delegated task step as a separate `pi --mode rpc` process, communicating over
 * stdin/stdout JSON-lines -- restored and adapted from the pre-in-process-rewrite
 * implementation (see git history for task.ts/task-live.ts before commit
 * "feat(tasks): run delegated tasks in-process on AgentSession"). We moved back to this
 * transport because pi's own session-replacement machinery (`/tasks open`, `/resume`, fork,
 * new-session) always disposes whatever session is "current" in a terminal before replacing
 * it -- since a human inspecting a live worker did so from the same terminal as the
 * delegating parent, opening the worker disposed the parent, breaking pingback delivery.
 * A worker as a genuinely separate OS process has no such dependency on the parent's own
 * terminal/session lifecycle.
 */

// =============================================================================
// Spawn resolution
// =============================================================================

/** Resolves how to re-exec `pi` for a worker, matching however the current process was
 * launched (a real script path, a bun-compiled virtual script, or the bare `pi`/`node` runtime). */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

// =============================================================================
// Recursion depth guard (env-var based -- safe again now that each worker is its own
// process; the in-process rewrite replaced this with a session-id-keyed Map specifically
// because in-process workers shared process.env with the parent).
// =============================================================================

const DEFAULT_MAX_SUBAGENT_DEPTH = 2;

export function checkSubagentDepth(): { blocked: boolean; depth: number; maxDepth: number } {
	const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const maxDepth = Number.isFinite(Number(process.env.PI_SUBAGENT_MAX_DEPTH))
		? Number(process.env.PI_SUBAGENT_MAX_DEPTH)
		: DEFAULT_MAX_SUBAGENT_DEPTH;
	return {
		blocked: Number.isFinite(depth) && depth >= maxDepth,
		depth,
		maxDepth,
	};
}

function getSubagentDepthEnv(): Record<string, string> {
	const current = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const next = Number.isFinite(current) ? current + 1 : 1;
	const max = process.env.PI_SUBAGENT_MAX_DEPTH ?? String(DEFAULT_MAX_SUBAGENT_DEPTH);
	return { PI_SUBAGENT_DEPTH: String(next), PI_SUBAGENT_MAX_DEPTH: max };
}

// =============================================================================
// Env + CLI flag construction
// =============================================================================

export function getWorkerProcessEnv(worker: { agentName?: string; profileName?: string }): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...getSubagentDepthEnv(),
	};
	if (worker.agentName) env.PI_AGENT_NAME = worker.agentName;
	else delete env.PI_AGENT_NAME;
	if (worker.profileName) env.PI_PROFILE_NAME = worker.profileName;
	else delete env.PI_PROFILE_NAME;
	return env;
}

export function appendWorkerToolFlags(
	args: string[],
	spec: { tools?: string[]; excludeTools?: string[]; allowDelegation: boolean },
): void {
	if (spec.tools !== undefined) {
		if (spec.tools.length > 0) args.push("--tools", spec.tools.join(","));
		else args.push("--no-tools");
	}

	const excludedTools = new Set(spec.excludeTools);
	if (!spec.allowDelegation) excludedTools.add("task");
	if (excludedTools.size > 0) args.push("--exclude-tools", [...excludedTools].join(","));
}

export function appendProjectTrustFlags(args: string[], projectTrusted: boolean): void {
	if (projectTrusted) args.push("--approve");
	else args.push("--no-approve");
}

export function appendWorkerSkillFlags(
	args: string[],
	spec: { noSkills: boolean; additionalSkillPaths?: string[] },
): void {
	if (spec.noSkills) args.push("--no-skills");
	for (const skillPath of spec.additionalSkillPaths ?? []) args.push("--skill", skillPath);
}

async function writePromptToTempFile(label: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(
		path.join(os.tmpdir(), `pi-task-prompt-${label.replace(/[^a-zA-Z0-9._-]+/g, "-")}-`),
	);
	const filePath = path.join(dir, "system-prompt.txt");
	await fs.promises.writeFile(filePath, prompt, "utf8");
	return { dir, filePath };
}

/** Writes the composed system prompt to a temp file and appends the right CLI flag --
 * avoids CLI argv length/escaping issues a raw --system-prompt "<text>" argument would hit. */
export async function appendWorkerPromptFlags(
	args: string[],
	label: string,
	systemPrompt: string,
	systemPromptMode: "append" | "replace",
): Promise<{ dir: string | null; filePath: string | null }> {
	if (!systemPrompt.trim()) return { dir: null, filePath: null };
	const promptFile = await writePromptToTempFile(label, systemPrompt);
	const promptFlag = systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt";
	args.push(promptFlag, promptFile.filePath);
	return promptFile;
}

// =============================================================================
// Bounded stdout line accumulation + stderr capture
// =============================================================================

const MAX_CHILD_EVENT_LINE_BYTES = 1024 * 1024;
const MAX_CHILD_STDERR_BYTES = 256 * 1024;
const STDERR_TRUNCATION_MARKER = "\n[stderr truncated]\n";

function truncateUtf8ToBytes(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(text, "utf8");
	let result = bytes.subarray(0, maxBytes).toString("utf8");
	while (result.endsWith("�") || Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
	return result;
}

function appendBoundedText(current: string, text: string, maxBytes: number): string {
	if (!text) return current;
	const markerBytes = Buffer.byteLength(STDERR_TRUNCATION_MARKER, "utf8");
	const currentBytes = Buffer.byteLength(current, "utf8");
	if (currentBytes >= maxBytes) return current;
	const incomingBytes = Buffer.byteLength(text, "utf8");
	if (currentBytes + incomingBytes <= maxBytes) return current + text;
	const body = truncateUtf8ToBytes(text, Math.max(0, maxBytes - currentBytes - markerBytes));
	return current + body + STDERR_TRUNCATION_MARKER;
}

interface BoundedEventLineAccumulator {
	buffer: string;
	overflowed: boolean;
	maxBytes: number;
}

function consumeBoundedEventChunk(
	accumulator: BoundedEventLineAccumulator,
	text: string,
	onOverflow: () => void,
): string[] {
	if (accumulator.overflowed) return [];
	if (Buffer.byteLength(accumulator.buffer, "utf8") + Buffer.byteLength(text, "utf8") > accumulator.maxBytes) {
		accumulator.buffer = "";
		accumulator.overflowed = true;
		onOverflow();
		return [];
	}
	accumulator.buffer += text;
	const parts = accumulator.buffer.split("\n");
	accumulator.buffer = parts.pop() ?? "";
	return parts;
}

function createBoundedEventLineAccumulator(maxBytes: number): {
	push(text: string, onOverflow?: () => void): string[];
} {
	const accumulator: BoundedEventLineAccumulator = { buffer: "", overflowed: false, maxBytes };
	return {
		push: (text, onOverflow = () => {}) => consumeBoundedEventChunk(accumulator, text, onOverflow),
	};
}

function createUtf8StreamDecoder(append: (text: string) => void) {
	const decoder = new StringDecoder("utf8");
	return {
		write(chunk: Buffer) {
			append(decoder.write(chunk));
		},
	};
}

function mapTransportClose(
	code: number | null,
	signal: NodeJS.Signals | null,
	options: { aborted: boolean; intentionallyTerminated: boolean },
): { exitCode: number; signalMessage?: string } {
	if (options.aborted) return { exitCode: 130 };
	if (options.intentionallyTerminated) return { exitCode: 0 };
	if (code !== null) return { exitCode: code };
	return {
		exitCode: 1,
		signalMessage: signal ? `Task RPC process terminated by signal ${signal}` : undefined,
	};
}

const SUBPROCESS_SIGKILL_TIMEOUT_MS = 5_000;

function terminateProcessWithEscalation(
	proc: ChildProcessWithoutNullStreams,
	options?: { timeoutMs?: number; isExited?: () => boolean },
): Promise<void> {
	if (options?.isExited?.() ?? (proc.exitCode !== null || proc.signalCode !== null)) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const markExited = () => {
			if (settled) return;
			settled = true;
			if (killTimer) clearTimeout(killTimer);
			proc.removeListener("close", markExited);
			resolve();
		};
		proc.once("close", markExited);
		try {
			proc.kill("SIGTERM");
		} catch {
			markExited();
			return;
		}
		killTimer = setTimeout(() => {
			if (options?.isExited?.()) {
				markExited();
				return;
			}
			try {
				proc.kill("SIGKILL");
			} catch {
				markExited();
			}
		}, options?.timeoutMs ?? SUBPROCESS_SIGKILL_TIMEOUT_MS);
		killTimer.unref?.();
	});
}

// =============================================================================
// RPC command/response correlation
// =============================================================================

interface RpcResponseEnvelope {
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

// =============================================================================
// Turn-settle tracking, decoupled from process lifetime
//
// The pre-rewrite version of this coordinator watched agent_start/agent_end/agent_settled/
// queue_update and, once genuinely idle past a grace period, called `terminate()` --
// collapsing "this turn is done" and "kill the process" into the same signal, because a
// worker only ever ran one prompt() call for its whole lifetime back then. Interactive
// workers (built after that code was replaced) need those to be separate: a turn settling
// resolves the in-flight prompt()/steer() wait, but the process keeps running -- only
// task_complete, an explicit abort, or an unrecoverable error tears it down.
// =============================================================================

const SETTLE_GRACE_MS = 1000;

function createTurnSettleTracker(options: { getPendingRpcCount: () => number }) {
	let sawAgentStart = false;
	let sawAgentEnd = false;
	let steeringCount = 0;
	let followUpCount = 0;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	let onSettled: (() => void) | undefined;

	const clearGrace = () => {
		if (!graceTimer) return;
		clearTimeout(graceTimer);
		graceTimer = undefined;
	};

	const maybeScheduleSettle = () => {
		clearGrace();
		graceTimer = setTimeout(() => {
			graceTimer = undefined;
			if (steeringCount > 0 || followUpCount > 0) return;
			if (options.getPendingRpcCount() > 0) return;
			const fire = onSettled;
			onSettled = undefined;
			fire?.();
		}, SETTLE_GRACE_MS);
		graceTimer.unref?.();
	};

	return {
		dispose: clearGrace,
		/** Resolves once the current turn (including any retries/compaction/queued
		 * continuation) genuinely settles. Only one waiter at a time -- callers await
		 * prompt()/steer() sequentially, matching in-process AgentSession semantics. */
		waitForSettle(): Promise<void> {
			return new Promise((resolve) => {
				onSettled = resolve;
			});
		},
		onAgentStart() {
			sawAgentStart = true;
			sawAgentEnd = false;
			clearGrace();
		},
		onAgentEnd() {
			// agent_end can be followed by retry, compaction, or a queued continuation --
			// only agent_settled (below) means no further automatic continuation will happen.
			if (sawAgentStart) sawAgentEnd = true;
		},
		onAgentSettled() {
			if (!sawAgentStart || !sawAgentEnd) return;
			maybeScheduleSettle();
		},
		onQueueUpdate(nextSteeringCount: number, nextFollowUpCount: number) {
			steeringCount = nextSteeringCount;
			followUpCount = nextFollowUpCount;
			if (steeringCount > 0 || followUpCount > 0) {
				clearGrace();
				return;
			}
			if (sawAgentEnd) maybeScheduleSettle();
		},
	};
}

// =============================================================================
// The public handle
// =============================================================================

/** Signaled when the worker calls task_complete/ask_caller -- detected by the handle's own
 * event-stream watcher (tool_execution_start events), not by the tools' own execute() bodies,
 * since detection has to happen on the parent side of the RPC boundary regardless of what the
 * child-side tool implementation does. */
export interface WorkerControlSignal {
	onComplete: (summary: string) => void;
	onPing: (message: string) => void;
}

export type RpcWorkerEvent = Record<string, unknown>;
export type RpcWorkerListener = (event: RpcWorkerEvent) => void;

export interface RpcWorkerUiRequestHandler {
	(request: RpcWorkerEvent, respond: (response: Record<string, unknown>) => void): void;
}

export interface RpcWorkerHandle {
	sessionManager: { getSessionId: () => string; getSessionFile: () => string | undefined };
	isStreaming: boolean;
	messages: Message[];
	subscribe(listener: RpcWorkerListener): () => void;
	/** Sends `prompt`, resolves once the whole turn (incl. retries/compaction) settles. */
	prompt(text: string): Promise<void>;
	/** Sends `steer`, resolves once queued (matches in-process session.steer() semantics). */
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	/** Kills the child process. Only call when the worker is genuinely done (task_complete,
	 * abort, unrecoverable error) -- an interactive worker that merely paused stays alive. */
	dispose(): void;
}

export interface SpawnRpcWorkerOptions {
	cwd: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	sessionFile?: string;
	tmpPromptDir?: string | null;
	tmpPromptPath?: string | null;
	signal: WorkerControlSignal;
	onUiRequest?: RpcWorkerUiRequestHandler;
}

export interface SpawnRpcWorkerResult {
	handle?: RpcWorkerHandle;
	error?: string;
}

function createRpcRequestId(command: string): string {
	return `${command}-${randomUUID().slice(0, 8)}`;
}

/**
 * Spawns a `pi --mode rpc` child process and wraps it in an `RpcWorkerHandle`. `args` must
 * already include `--mode rpc` and every other flag the caller wants (session file, model,
 * tools, prompt, etc.) -- this function only owns the transport, not worker configuration.
 */
export async function spawnRpcWorker(options: SpawnRpcWorkerOptions): Promise<SpawnRpcWorkerResult> {
	const invocation = getPiInvocation(options.args);
	let proc: ChildProcessWithoutNullStreams;
	try {
		proc = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
		}) as ChildProcessWithoutNullStreams;
	} catch (error) {
		return {
			error: `Failed to spawn task worker process: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const pendingResponses = new Map<string, PendingRpcResponse>();
	const listeners = new Set<RpcWorkerListener>();
	const messages: Message[] = [];
	let sessionId: string | undefined;
	let sessionFile: string | undefined = options.sessionFile;
	let isStreaming = false;
	let stderrText = "";
	let disposed = false;
	let intentionallyTerminated = false;
	let cleanedUpTempFiles = false;

	const settleTracker = createTurnSettleTracker({ getPendingRpcCount: () => pendingResponses.size });

	const cleanupTempFiles = () => {
		if (cleanedUpTempFiles) return;
		cleanedUpTempFiles = true;
		if (options.tmpPromptPath) {
			try {
				fs.unlinkSync(options.tmpPromptPath);
			} catch {
				/* best effort */
			}
		}
		if (options.tmpPromptDir) {
			try {
				fs.rmdirSync(options.tmpPromptDir);
			} catch {
				/* best effort */
			}
		}
	};

	const rejectAllPending = (error: Error) => {
		for (const pending of pendingResponses.values()) pending.reject(error);
		pendingResponses.clear();
	};

	function sendCommand(command: Record<string, unknown>): Promise<RpcResponseEnvelope> {
		if (disposed || proc.exitCode !== null || proc.signalCode !== null) {
			return Promise.reject(new Error("Task worker process is not running."));
		}
		const id = createRpcRequestId(typeof command.type === "string" ? command.type : "cmd");
		const payload = { ...command, id };
		return new Promise<RpcResponseEnvelope>((resolve, reject) => {
			pendingResponses.set(id, { resolve, reject });
			proc.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
				if (!error) return;
				pendingResponses.delete(id);
				reject(error);
			});
		});
	}

	function handleLine(line: string): void {
		if (!line.trim()) return;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(event)) return;
		for (const listener of listeners) listener(event);

		if (event.type === "response") {
			const response = event as unknown as RpcResponseEnvelope;
			if (typeof response.id === "string") {
				const pending = pendingResponses.get(response.id);
				if (pending) {
					pendingResponses.delete(response.id);
					pending.resolve(response);
				}
			}
			return;
		}
		if (event.type === "agent_start") {
			isStreaming = true;
			settleTracker.onAgentStart();
			return;
		}
		if (event.type === "agent_end") {
			settleTracker.onAgentEnd();
			return;
		}
		if (event.type === "agent_settled") {
			isStreaming = false;
			settleTracker.onAgentSettled();
			return;
		}
		if (event.type === "queue_update") {
			const steering = Array.isArray(event.steering) ? event.steering.length : 0;
			const followUp = Array.isArray(event.followUp) ? event.followUp.length : 0;
			settleTracker.onQueueUpdate(steering, followUp);
			return;
		}
		if (event.type === "message_end" && isRecord(event.message)) {
			messages.push(event.message as unknown as Message);
			return;
		}
		if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
			const args = isRecord(event.args) ? event.args : {};
			if (event.toolName === "task_complete" && typeof args.summary === "string") {
				options.signal.onComplete(args.summary);
			} else if (event.toolName === "ask_caller" && typeof args.message === "string") {
				options.signal.onPing(args.message);
			}
			return;
		}
		if (event.type === "extension_ui_request") {
			options.onUiRequest?.(event, (response) => {
				if (disposed || proc.stdin.destroyed) return;
				proc.stdin.write(`${JSON.stringify(response)}\n`);
			});
			return;
		}
	}

	const eventLines = createBoundedEventLineAccumulator(MAX_CHILD_EVENT_LINE_BYTES);
	const stdoutDecoder = createUtf8StreamDecoder((text) => {
		for (const line of eventLines.push(text, () =>
			rejectAllPending(new Error("Task worker emitted an oversized event line.")),
		)) {
			handleLine(line);
		}
	});
	const stderrDecoder = createUtf8StreamDecoder((text) => {
		stderrText = appendBoundedText(stderrText, text, MAX_CHILD_STDERR_BYTES);
	});

	proc.stdout.on("data", (chunk: Buffer) => stdoutDecoder.write(chunk));
	proc.stderr.on("data", (chunk: Buffer) => stderrDecoder.write(chunk));

	let closeError: Error | undefined;
	proc.on("close", (code, signal) => {
		settleTracker.dispose();
		cleanupTempFiles();
		const outcome = mapTransportClose(code, signal, { aborted: false, intentionallyTerminated });
		closeError ??= outcome.signalMessage
			? new Error(outcome.signalMessage)
			: new Error("Task worker process exited.");
		rejectAllPending(closeError);
	});
	proc.on("error", (error) => {
		closeError = error;
		rejectAllPending(error);
	});

	// Confirm the process actually started and is servicing commands before handing back a
	// handle -- get_state doubles as the readiness probe (RPC mode has no separate "ready"
	// event; the SDK's own reference client just spawns and assumes readiness after a fixed
	// delay, but sending get_state immediately and awaiting it is more direct and correct).
	try {
		const stateResponse = await sendCommand({ type: "get_state" });
		if (stateResponse.success === false || !isRecord(stateResponse.data)) {
			const message =
				typeof stateResponse.error === "string" ? stateResponse.error : "Worker did not report its state.";
			terminateProcessWithEscalation(proc);
			cleanupTempFiles();
			return { error: message };
		}
		sessionId = typeof stateResponse.data.sessionId === "string" ? stateResponse.data.sessionId : undefined;
		if (typeof stateResponse.data.sessionFile === "string") sessionFile = stateResponse.data.sessionFile;
	} catch (error) {
		cleanupTempFiles();
		const detail = error instanceof Error ? error.message : String(error);
		return {
			error: stderrText.trim()
				? `Failed to start task worker: ${detail}\n${stderrText.trim()}`
				: `Failed to start task worker: ${detail}`,
		};
	}
	if (!sessionId) {
		terminateProcessWithEscalation(proc);
		cleanupTempFiles();
		return { error: "Task worker did not report a session id." };
	}

	const handle: RpcWorkerHandle = {
		sessionManager: {
			getSessionId: () => sessionId!,
			getSessionFile: () => sessionFile,
		},
		get isStreaming() {
			return isStreaming;
		},
		messages,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async prompt(text) {
			const settled = settleTracker.waitForSettle();
			const response = await sendCommand({ type: "prompt", message: text });
			if (response.success === false) {
				throw new Error(typeof response.error === "string" ? response.error : "Task prompt was rejected.");
			}
			await settled;
		},
		async steer(text) {
			const response = await sendCommand({ type: "steer", message: text });
			if (response.success === false) {
				throw new Error(typeof response.error === "string" ? response.error : "Task steer was rejected.");
			}
		},
		async abort() {
			await sendCommand({ type: "abort" });
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			intentionallyTerminated = true;
			rejectAllPending(new Error("Task worker session was closed."));
			void terminateProcessWithEscalation(proc, {
				isExited: () => proc.exitCode !== null || proc.signalCode !== null,
			});
			cleanupTempFiles();
		},
	};

	return { handle };
}
