import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type ExtensionAPI,
	type TruncationResult,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { activePolicy, loadConfig } from "../permissions/config";
import { resolveCodemodePolicy } from "../permissions/codemode";
import { getEffectiveSandboxTmpDir, runSandboxedCommand } from "../permissions/sandbox";
import type { CodemodeCapability, CodemodeProfileName, SandboxManagerLike } from "../permissions/shared";
import * as taskAgents from "../tasks/agents.js";
import type { AgentScope } from "../tasks/agents.js";

const LOG_PREFIX = "__PI_CODEMODE_LOG__";
const RESULT_PREFIX = "__PI_CODEMODE_RESULT__";
const BRIDGE_REQUEST_PREFIX = "__PI_CODEMODE_BRIDGE_REQUEST__";
const BRIDGE_RESPONSE_PREFIX = "__PI_CODEMODE_BRIDGE_RESPONSE__";
const MAX_LOG_LINES = 200;
const MAX_LOG_BYTES = 32 * 1024;
const MAX_LOG_LINE_CHARS = 2_000;
const MAX_RAW_OUTPUT_BYTES = 256 * 1024;
const MAX_RESULT_PREVIEW = 8_000;
const TOOL_OUTPUT_MAX_LINES = Math.min(DEFAULT_MAX_LINES, 700);
const TOOL_OUTPUT_MAX_BYTES = Math.min(DEFAULT_MAX_BYTES, 30 * 1024);
const SUBPROCESS_SIGKILL_TIMEOUT_MS = 5000;

function terminateProcessWithEscalation(
	proc: Pick<ChildProcessWithoutNullStreams, "kill" | "once" | "exitCode" | "signalCode">,
	options?: { timeoutMs?: number; isExited?: () => boolean },
): void {
	let exited = options?.isExited?.() ?? (proc.exitCode !== null || proc.signalCode !== null);
	if (exited) return;

	let killTimer: ReturnType<typeof setTimeout> | undefined;
	const markExited = () => {
		exited = true;
		if (killTimer) clearTimeout(killTimer);
	};
	proc.once("exit", markExited);
	proc.once("close", markExited);

	try {
		proc.kill("SIGTERM");
	} catch {
		return;
	}

	killTimer = setTimeout(() => {
		if (exited || options?.isExited?.()) return;
		try {
			proc.kill("SIGKILL");
		} catch {
			// Ignore best-effort cleanup failures.
		}
	}, options?.timeoutMs ?? SUBPROCESS_SIGKILL_TIMEOUT_MS);
	killTimer.unref?.();
}

type ProtocolLog = {
	level?: string;
	args?: unknown[];
};

type ProtocolResult =
	| {
			ok: true;
			result: unknown;
	  }
	| {
			ok: false;
			error: {
				phase: "compile" | "execute" | "bridge" | "timeout" | "protocol";
				message: string;
				stack?: string;
			};
	  };

type BridgeRequest = {
	id: number;
	method: string;
	args: unknown;
};

type BridgeResponse = {
	id: number;
	ok: boolean;
	result?: unknown;
	error?: {
		message: string;
	};
};

type CodemodeArtifact = {
	name: string;
	path: string;
	size: number;
};

type CodemodeBridgeCall = {
	name: string;
	ok: boolean;
	argsPreview: string;
	startedAt: number;
	endedAt: number;
	error?: string;
};

type CodemodeDetails = {
	profile: CodemodeProfileName;
	cwd: string;
	timeout: number;
	code: string;
	exitCode: number | null;
	ok: boolean;
	result?: unknown;
	error?: ProtocolResult extends infer R ? R extends { ok: false; error: infer E } ? E : never : never;
	logs: string[];
	logNotice?: string;
	rawOutput: string;
	rawOutputNotice?: string;
	outputTruncation?: TruncationResult;
	artifacts: CodemodeArtifact[];
	bridgeCalls: CodemodeBridgeCall[];
	sandbox: {
		enabled: boolean;
		reason: string;
		mode: "dedicated";
	};
};

interface BridgeRuntimeState {
	capabilities: CodemodeCapability[];
	artifactsDir: string;
	artifacts: CodemodeArtifact[];
	bridgeCalls: CodemodeBridgeCall[];
	onUpdate?: Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>>[3];
	signal?: AbortSignal;
	cwd: string;
	allowProjectAgents: boolean;
}

const CodemodeParams = Type.Object({
	code: Type.String({ description: "TypeScript code to execute inside the CodeMode runtime" }),
	profile: Type.Optional(
		StringEnum(["analysis", "orchestrator"] as const, {
			description: "Execution profile controlling sandboxing and future bridge capabilities",
		}),
	),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (1..120, default 30)" })),
	cwd: Type.Optional(Type.String({ description: "Optional working directory override, relative to current cwd unless absolute" })),
});

function detectAgentName(pi: ExtensionAPI): string {
	if (process.env.PI_AGENT_NAME) return process.env.PI_AGENT_NAME;
	const flagValue = pi.getFlag("agent-name");
	if (typeof flagValue === "string" && flagValue.length > 0) return flagValue;
	return "default";
}

function detectProfileName(pi: ExtensionAPI): string | undefined {
	if (process.env.PI_PROFILE_NAME) return process.env.PI_PROFILE_NAME;
	const flagValue = pi.getFlag("profile-name");
	if (typeof flagValue === "string" && flagValue.length > 0) return flagValue;
	return undefined;
}

function clampTimeout(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 30;
	return Math.max(1, Math.min(120, value));
}

async function resolveExecutionCwd(baseCwd: string, requested: string | undefined): Promise<string> {
	const raw = (requested ?? ".").replace(/^@/, "");
	const resolved = path.resolve(baseCwd, raw);
	const stat = await fs.stat(resolved).catch(() => undefined);
	if (!stat) throw new Error(`CodeMode cwd does not exist: ${requested ?? baseCwd}`);
	if (!stat.isDirectory()) throw new Error(`CodeMode cwd is not a directory: ${requested ?? baseCwd}`);
	return resolved;
}

function serializeForDisplay(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

interface LogCaptureState {
	lines: string[];
	bytes: number;
	droppedLines: number;
	droppedBytes: number;
	clippedLines: number;
}

interface RawOutputCaptureState {
	value: string;
	bytes: number;
	droppedBytes: number;
	truncated: boolean;
}

function utf8Prefix(text: string, maxBytes: number): string {
	if (maxBytes <= 0 || text.length === 0) return "";
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	return text.slice(0, low);
}

function formatOutputTruncationNotice(truncation: TruncationResult): string {
	const omittedLines = truncation.totalLines - truncation.outputLines;
	const omittedBytes = truncation.totalBytes - truncation.outputBytes;
	return `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ${omittedLines} lines (${formatSize(omittedBytes)}) omitted.]`;
}

function truncateToolOutput(text: string): { text: string; truncation: TruncationResult } {
	const truncation = truncateHead(text, {
		maxLines: TOOL_OUTPUT_MAX_LINES,
		maxBytes: TOOL_OUTPUT_MAX_BYTES,
	});
	if (!truncation.truncated) return { text: truncation.content, truncation };
	return {
		text: `${truncation.content}\n\n${formatOutputTruncationNotice(truncation)}`,
		truncation,
	};
}

function createLogCaptureState(): LogCaptureState {
	return { lines: [], bytes: 0, droppedLines: 0, droppedBytes: 0, clippedLines: 0 };
}

function capLogLine(line: string): { line: string; clipped: boolean } {
	if (line.length <= MAX_LOG_LINE_CHARS) return { line, clipped: false };
	const omitted = line.length - MAX_LOG_LINE_CHARS;
	return {
		line: `${line.slice(0, MAX_LOG_LINE_CHARS)}… [line truncated: ${omitted} chars omitted]`,
		clipped: true,
	};
}

function appendLogLine(state: LogCaptureState, line: string): void {
	const capped = capLogLine(line);
	if (capped.clipped) state.clippedLines += 1;
	const bytes = Buffer.byteLength(capped.line, "utf8");
	state.lines.push(capped.line);
	state.bytes += bytes;

	while (state.lines.length > MAX_LOG_LINES || state.bytes > MAX_LOG_BYTES) {
		const removed = state.lines.shift();
		if (removed === undefined) break;
		const removedBytes = Buffer.byteLength(removed, "utf8");
		state.bytes -= removedBytes;
		state.droppedLines += 1;
		state.droppedBytes += removedBytes;
	}
}

function formatLogNotice(state: LogCaptureState): string | undefined {
	const parts: string[] = [];
	if (state.droppedLines > 0) {
		parts.push(`${state.droppedLines} older log line(s) (${formatSize(state.droppedBytes)}) were dropped to stay within ${MAX_LOG_LINES} lines/${formatSize(MAX_LOG_BYTES)}`);
	}
	if (state.clippedLines > 0) {
		parts.push(`${state.clippedLines} line(s) were clipped to ${MAX_LOG_LINE_CHARS} chars`);
	}
	if (parts.length === 0) return undefined;
	return `[Log output truncated: ${parts.join("; ")}.]`;
}

function createRawOutputCaptureState(): RawOutputCaptureState {
	return {
		value: "",
		bytes: 0,
		droppedBytes: 0,
		truncated: false,
	};
}

function appendRawOutput(state: RawOutputCaptureState, chunk: string): void {
	if (!chunk) return;
	const chunkBytes = Buffer.byteLength(chunk, "utf8");
	if (state.truncated) {
		state.droppedBytes += chunkBytes;
		return;
	}

	if (state.bytes + chunkBytes <= MAX_RAW_OUTPUT_BYTES) {
		state.value += chunk;
		state.bytes += chunkBytes;
		return;
	}

	const remaining = Math.max(0, MAX_RAW_OUTPUT_BYTES - state.bytes);
	if (remaining > 0) {
		state.value += utf8Prefix(chunk, remaining);
		state.bytes = MAX_RAW_OUTPUT_BYTES;
	}
	state.droppedBytes += Math.max(0, chunkBytes - remaining);
	state.truncated = true;
}

function finalizeRawOutput(state: RawOutputCaptureState): { text: string; notice?: string } {
	if (!state.truncated) return { text: state.value };
	const totalBytes = state.bytes + state.droppedBytes;
	const notice = `[Raw output truncated: captured ${formatSize(state.bytes)} of ${formatSize(totalBytes)} (${formatSize(state.droppedBytes)} omitted).]`;
	return {
		text: state.value ? `${state.value}\n\n${notice}` : notice,
		notice,
	};
}

function formatLogLine(log: ProtocolLog): string {
	const parts = (log.args ?? []).map((arg) => serializeForDisplay(arg));
	const prefix = log.level ? `[${log.level}] ` : "";
	return `${prefix}${parts.join(" ")}`.trim();
}

function parseProtocolOutput(rawOutput: string): { logs: string[]; result?: ProtocolResult } {
	const logState = createLogCaptureState();
	let result: ProtocolResult | undefined;

	for (const line of rawOutput.split(/\r?\n/)) {
		if (line.startsWith(LOG_PREFIX)) {
			try {
				const payload = JSON.parse(line.slice(LOG_PREFIX.length)) as ProtocolLog;
				appendLogLine(logState, formatLogLine(payload));
			} catch {
				appendLogLine(logState, `[protocol] could not parse log payload: ${line.slice(LOG_PREFIX.length)}`);
			}
			continue;
		}
		if (line.startsWith(RESULT_PREFIX)) {
			try {
				result = JSON.parse(line.slice(RESULT_PREFIX.length)) as ProtocolResult;
			} catch (error) {
				result = {
					ok: false,
					error: {
						phase: "protocol",
						message: `Failed to parse runtime result: ${error instanceof Error ? error.message : String(error)}`,
					},
				};
			}
		}
	}

	const logs = [...logState.lines];
	const notice = formatLogNotice(logState);
	if (notice) logs.push(notice);
	return { logs, result };
}

function buildRunnerSource(capabilities: CodemodeCapability[]): string {
	return `
const LOG_PREFIX = ${JSON.stringify(LOG_PREFIX)};
const RESULT_PREFIX = ${JSON.stringify(RESULT_PREFIX)};
const BRIDGE_REQUEST_PREFIX = ${JSON.stringify(BRIDGE_REQUEST_PREFIX)};
const BRIDGE_RESPONSE_PREFIX = ${JSON.stringify(BRIDGE_RESPONSE_PREFIX)};
const CAPABILITIES = ${JSON.stringify(capabilities)};

function serialize(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return value;
  if (type === "bigint") return value.toString();
  if (type === "function") return { __type: "function", name: value.name || "anonymous" };
  if (value instanceof Error) {
    return {
      __type: "error",
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (Array.isArray(value)) return value.map((item) => serialize(item, seen));
  if (type === "object") {
    if (seen.has(value)) return { __type: "circular" };
    seen.add(value);
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = serialize(entry, seen);
    seen.delete(value);
    return out;
  }
  return String(value);
}

function emit(prefix, payload) {
  process.stdout.write(prefix + JSON.stringify(payload) + "\\n");
}

function log(level, args) {
  emit(LOG_PREFIX, { level, args: args.map((arg) => serialize(arg)) });
}

console.log = (...args) => log("log", args);
console.info = (...args) => log("info", args);
console.warn = (...args) => log("warn", args);
console.error = (...args) => log("error", args);
console.debug = (...args) => log("debug", args);

let bridgeBuffer = "";
const bridgePending = new Map();
let bridgeNextId = 1;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  bridgeBuffer += chunk;
  const lines = bridgeBuffer.split(/\\r?\\n/);
  bridgeBuffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.startsWith(BRIDGE_RESPONSE_PREFIX)) continue;
    try {
      const payload = JSON.parse(line.slice(BRIDGE_RESPONSE_PREFIX.length));
      const pending = bridgePending.get(payload.id);
      if (!pending) continue;
      bridgePending.delete(payload.id);
      if (payload.ok) pending.resolve(payload.result);
      else pending.reject(new Error(payload.error?.message || "Bridge call failed"));
    } catch (error) {
      console.error("Failed to parse bridge response", error);
    }
  }
});

async function callHost(method, args) {
  const id = bridgeNextId++;
  emit(BRIDGE_REQUEST_PREFIX, { id, method, args: serialize(args) });
  return await new Promise((resolve, reject) => {
    bridgePending.set(id, { resolve, reject });
  });
}

const host = {
  async capabilities() {
    return [...CAPABILITIES];
  },
  async help() {
    return {
      message: "Pi CodeMode host bridge",
      available: [...CAPABILITIES],
    };
  },
  message: {
    async info(text) {
      return await callHost("message.info", { text });
    },
    async warn(text) {
      return await callHost("message.warn", { text });
    },
  },
  artifact: {
    async write(name, content) {
      return await callHost("artifact.write", { name, content });
    },
  },
  task: {
    async run(params) {
      return await callHost("task.run", params);
    },
  },
  todo: {
    async list() {
      return await callHost("todo.list", {});
    },
    async add(params) {
      return await callHost("todo.add", params);
    },
    async update(params) {
      return await callHost("todo.update", params);
    },
  },
};

const state = Object.create(null);

async function main() {
  let mod;
  try {
    mod = await import("./usercode.ts");
  } catch (error) {
    emit(RESULT_PREFIX, {
      ok: false,
      error: {
        phase: "compile",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
    process.exitCode = 1;
    return;
  }

  try {
    const result = await mod.default(host, state);
    emit(RESULT_PREFIX, { ok: true, result: serialize(result) });
  } catch (error) {
    emit(RESULT_PREFIX, {
      ok: false,
      error: {
        phase: "execute",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    });
    process.exitCode = 1;
  }
}

await main();
process.stdin.pause();
process.exit(process.exitCode ?? 0);
`.trimStart();
}

function splitImportsAndBody(code: string): { imports: string; body: string } {
	const lines = code.split("\n");
	let lastImportEndLine = -1;
	let inMultiLineImport = false;

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();

		if (inMultiLineImport) {
			if (/}\s*from\s+['"]/.test(trimmed) || /from\s+['"].*['"]/.test(trimmed)) {
				inMultiLineImport = false;
				lastImportEndLine = i;
			}
			continue;
		}

		// Skip blank lines and single-line comments (keep scanning for more imports)
		if (trimmed === "" || trimmed.startsWith("//")) continue;

		// Match import statements
		if (/^import\b/.test(trimmed)) {
			if (trimmed.includes("{") && !trimmed.includes("}")) {
				inMultiLineImport = true;
			} else {
				lastImportEndLine = i;
			}
			continue;
		}

		// First non-import, non-blank, non-comment line — stop
		break;
	}

	if (lastImportEndLine === -1) {
		return { imports: "", body: code };
	}

	return {
		imports: lines.slice(0, lastImportEndLine + 1).join("\n"),
		body: lines.slice(lastImportEndLine + 1).join("\n"),
	};
}

function buildUserModule(code: string): string {
	const { imports, body } = splitImportsAndBody(code);
	const parts: string[] = [];
	if (imports) parts.push(imports);
	parts.push("export default async function(host: any, state: any) {");
	parts.push(body);
	parts.push("}");
	return parts.join("\n");
}

async function createRuntimeFiles(runtimeDir: string, code: string, capabilities: CodemodeCapability[]): Promise<{ entryFile: string }> {
	const entryFile = path.join(runtimeDir, "runner.ts");
	const userFile = path.join(runtimeDir, "usercode.ts");
	await Promise.all([
		fs.writeFile(entryFile, buildRunnerSource(capabilities), "utf8"),
		fs.writeFile(userFile, buildUserModule(code), "utf8"),
	]);
	return { entryFile };
}

async function initializeSandboxManager(config: unknown): Promise<SandboxManagerLike> {
	const mod = await import("../permissions/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js");
	const sandboxManager = mod.SandboxManager as SandboxManagerLike;
	await sandboxManager.initialize(config as Parameters<SandboxManagerLike["initialize"]>[0]);
	return sandboxManager;
}

function sanitizeArtifactName(name: string): string {
	const trimmed = name.trim().replace(/^@/, "");
	const base = path.basename(trimmed || "artifact.txt");
	return base.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 128) || "artifact.txt";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	return { command: "pi", args };
}

function normalizeLegacyModelName(model: string | undefined): string | undefined {
	if (!model || model.includes("/")) return model;
	return model.replace(/(\d)-(\d)(?=(?:\D|$))/g, "$1.$2");
}

function getFinalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "text") return part.text;
		}
	}
	return "";
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.mkdtemp(path.join(process.env.TMPDIR || "/tmp", "pi-codemode-task-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await fs.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

async function runTaskBridge(state: BridgeRuntimeState, args: unknown): Promise<unknown> {
	if (!state.capabilities.includes("task")) throw new Error("host.task.run is not available for this profile");
	if (!args || typeof args !== "object") throw new Error("host.task.run expects an object argument");
	const input = args as { agent?: unknown; task?: unknown; cwd?: unknown; agentScope?: unknown };
	if (typeof input.agent !== "string" || input.agent.trim() === "") throw new Error("host.task.run requires string field 'agent'");
	if (typeof input.task !== "string" || input.task.trim() === "") throw new Error("host.task.run requires string field 'task'");
	const agentScope = (input.agentScope ?? "user") as AgentScope;
	if (agentScope !== "user" && !state.allowProjectAgents) {
		throw new Error("host.task.run only allows agentScope='user' in this MVP");
	}
	const taskCwd = typeof input.cwd === "string" ? path.resolve(state.cwd, input.cwd) : state.cwd;
	const discovery = taskAgents.discoverAgents(taskCwd, agentScope);
	const agent = discovery.agents.find((candidate) => candidate.name === input.agent);
	if (!agent) throw new Error(`Unknown agent: ${input.agent}`);

	const piArgs: string[] = ["--mode", "json", "-p", "--no-session"];
	const model = normalizeLegacyModelName(agent.model);
	if (model) piArgs.push("--model", model);
	if (agent.tools && agent.tools.length > 0) piArgs.push("--tools", agent.tools.join(","));
	if (!agent.inheritProjectContext) piArgs.push("--no-context-files");
	if (!agent.inheritSkills) piArgs.push("--no-skills");

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	if (agent.systemPrompt.trim()) {
		const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
		tmpPromptDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		const promptFlag = agent.systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt";
		piArgs.push(promptFlag, tmpPromptPath);
	}
	piArgs.push(`Task: ${input.task}`);

	const invocation = getPiInvocation(piArgs);
	const messages: Message[] = [];
	let stderr = "";
	let buffer = "";

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: taskCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: process.env,
			});
			let procClosed = false;

			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line) as { type?: string; message?: Message };
					if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
						messages.push(event.message);
					}
				} catch {
					// ignore non-json lines
				}
			};

			proc.stdout.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				const lines = buffer.split(/\r?\n/);
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (chunk) => {
				stderr += chunk.toString("utf8");
			});
			proc.on("close", (code) => {
				procClosed = true;
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});
			proc.on("error", () => {
				procClosed = true;
				resolve(1);
			});

			if (state.signal) {
				let aborted = false;
				const onAbort = () => {
					if (aborted) return;
					aborted = true;
					terminateProcessWithEscalation(proc, { isExited: () => procClosed });
				};
				if (state.signal.aborted) onAbort();
				else state.signal.addEventListener("abort", onAbort, { once: true });
			}
		});

		return {
			agent: agent.name,
			agentSource: agent.source,
			exitCode,
			output: getFinalAssistantText(messages),
			stderr,
			messageCount: messages.length,
			model,
		};
	} finally {
		if (tmpPromptPath) await fs.rm(tmpPromptPath, { force: true }).catch(() => {});
		if (tmpPromptDir) await fs.rm(tmpPromptDir, { recursive: true, force: true }).catch(() => {});
	}
}

async function executeBridgeRequest(state: BridgeRuntimeState, request: BridgeRequest): Promise<unknown> {
	switch (request.method) {
		case "message.info": {
			const text = typeof (request.args as { text?: unknown })?.text === "string" ? (request.args as { text: string }).text : "";
			if (!state.capabilities.includes("message")) throw new Error("host.message.info is not available for this profile");
			state.onUpdate?.({ content: [{ type: "text", text }] });
			return { ok: true };
		}
		case "message.warn": {
			const text = typeof (request.args as { text?: unknown })?.text === "string" ? (request.args as { text: string }).text : "";
			if (!state.capabilities.includes("message")) throw new Error("host.message.warn is not available for this profile");
			state.onUpdate?.({ content: [{ type: "text", text: `WARNING: ${text}` }] });
			return { ok: true };
		}
		case "artifact.write": {
			if (!state.capabilities.includes("artifact")) throw new Error("host.artifact.write is not available for this profile");
			const input = request.args as { name?: unknown; content?: unknown };
			if (typeof input?.name !== "string") throw new Error("host.artifact.write requires string field 'name'");
			if (typeof input?.content !== "string") throw new Error("host.artifact.write requires string field 'content'");
			await fs.mkdir(state.artifactsDir, { recursive: true });
			const artifactName = sanitizeArtifactName(input.name);
			const artifactPath = path.join(state.artifactsDir, artifactName);
			await fs.writeFile(artifactPath, input.content, "utf8");
			const stat = await fs.stat(artifactPath);
			const artifact: CodemodeArtifact = {
				name: artifactName,
				path: artifactPath,
				size: stat.size,
			};
			state.artifacts.push(artifact);
			return artifact;
		}
		case "task.run":
			return runTaskBridge(state, request.args);
		case "todo.list":
		case "todo.add":
		case "todo.update":
			throw new Error("host.todo bridge is not implemented yet");
		default:
			throw new Error(`Unknown bridge method: ${request.method}`);
	}
}

function formatDurationMs(startedAt: number, endedAt: number): string {
	return `${Math.max(0, endedAt - startedAt)}ms`;
}

function formatCodePreview(code: string, expanded: boolean): string {
	const normalized = code.trim();
	if (!normalized) return "";
	const lines = normalized.split(/\r?\n/);
	const shownLines = expanded ? lines : lines.slice(0, 3);
	let preview = shownLines.join("\n");
	if (!expanded && lines.length > shownLines.length) {
		preview += `\n... ${lines.length - shownLines.length} more line(s)`;
	}
	return truncate(preview, expanded ? MAX_RESULT_PREVIEW : 400);
}

function buildContent(details: CodemodeDetails): string {
	if (details.ok) {
		const resultText = truncate(serializeForDisplay(details.result), MAX_RESULT_PREVIEW);
		const parts = ["TypeScript completed successfully.", "", "Result:", resultText];
		if (details.logs.length > 0 || details.logNotice) {
			parts.push("", "Logs:", ...details.logs);
			if (details.logNotice) parts.push(details.logNotice);
		}
		if (details.artifacts.length > 0) {
			parts.push("", "Artifacts:", ...details.artifacts.map((artifact) => `- ${artifact.name} (${artifact.size} bytes)`));
		}
		if (details.bridgeCalls.length > 0) {
			parts.push("", "Bridge calls:", ...details.bridgeCalls.map((call) => `- ${call.name}: ${call.ok ? "ok" : `error (${call.error})`}`));
		}
		return parts.join("\n");
	}

	const errorText = details.error ? `${details.error.phase}: ${details.error.message}` : "unknown error";
	const parts = ["TypeScript execution failed.", "", `Error: ${errorText}`];
	if (details.logs.length > 0 || details.logNotice) {
		parts.push("", "Logs:", ...details.logs);
		if (details.logNotice) parts.push(details.logNotice);
	}
	if (details.bridgeCalls.length > 0) {
		parts.push("", "Bridge calls:", ...details.bridgeCalls.map((call) => `- ${call.name}: ${call.ok ? "ok" : `error (${call.error})`}`));
	}
	return parts.join("\n");
}

function throwCodemodeExecutionError(details: CodemodeDetails): never {
	const errorText = details.error ? `${details.error.phase}: ${details.error.message}` : "unknown error";
	const error = new Error(`TypeScript execution failed: ${errorText}`) as Error & { details?: CodemodeDetails };
	error.details = details;
	throw error;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "typescript",
		label: "TypeScript",
		description:
			"Execute one-shot TypeScript in a sandboxed Bun runtime. Best for batched analysis and local data processing. Includes an MVP host bridge for message, artifact, and task operations.",
		promptSnippet:
			"Execute one-shot TypeScript in a sandboxed runtime for batched analysis, local data processing, artifact generation, and limited host-orchestrated workflows.",
		promptGuidelines: [
			"Use this CodeMode-style tool when the task benefits from batching multiple local operations into one scripted execution instead of many step-by-step tool calls.",
			"Prefer this tool for codebase analysis, structured extraction, summarization over many inputs, and artifact generation.",
			"Do not use this tool for trivial single-step actions when direct tools are simpler.",
			"Use profile \"analysis\" for read/analyze/report tasks and \"orchestrator\" only when host bridge operations like task delegation are needed.",
			"When using this tool, return a compact result and use artifact writing for larger outputs.",
		],
		parameters: CodemodeParams,
		renderCall(args, theme, context) {
			const profile = (args.profile ?? "analysis") as CodemodeProfileName;
			const code = typeof args.code === "string" ? args.code : "";
			const preview = formatCodePreview(code, context.expanded);
			let text =
				theme.fg("toolTitle", theme.bold("typescript ")) +
				theme.fg("accent", profile) +
				theme.fg("muted", ` timeout=${clampTimeout(args.timeout)}s`);
			if (args.cwd) text += theme.fg("dim", ` cwd=${args.cwd}`);
			if (preview) {
				text += `\n${theme.fg("muted", "script:")}`;
				text += `\n  ${theme.fg("dim", preview.replace(/\n/g, "\n  "))}`;
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as CodemodeDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const icon = details.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
			const sandboxLabel = `${details.sandbox.mode}${details.sandbox.enabled ? " sandbox" : " unsandboxed"}`;
			let text = `${icon} ${theme.fg("toolTitle", theme.bold("TypeScript"))} ${theme.fg("muted", `[${details.profile}] [${sandboxLabel}]`)}`;
			if (!details.ok && details.error) {
				text += `\n${theme.fg("error", `${details.error.phase}: ${details.error.message}`)}`;
			}

			if (details.ok) {
				const resultPreview = truncate(serializeForDisplay(details.result), expanded ? MAX_RESULT_PREVIEW : 300);
				text += `\n${theme.fg("muted", "result:")} ${theme.fg("toolOutput", resultPreview)}`;
			}

			if (details.artifacts.length > 0) {
				text += `\n${theme.fg("muted", `artifacts (${details.artifacts.length}):`)}`;
				for (const artifact of (expanded ? details.artifacts : details.artifacts.slice(0, 3))) {
					text += `\n  ${theme.fg("accent", artifact.name)}${theme.fg("dim", ` (${artifact.size} bytes)`)}`;
				}
				if (!expanded && details.artifacts.length > 3) {
					text += `\n  ${theme.fg("dim", `... ${details.artifacts.length - 3} more`)}`;
				}
			}

			if (details.bridgeCalls.length > 0) {
				text += `\n${theme.fg("muted", `bridge calls (${details.bridgeCalls.length}):`)}`;
				for (const call of (expanded ? details.bridgeCalls : details.bridgeCalls.slice(0, 4))) {
					const callIcon = call.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
					text += `\n  ${callIcon} ${theme.fg("accent", call.name)} ${theme.fg("dim", formatDurationMs(call.startedAt, call.endedAt))}`;
					if (expanded) {
						text += `\n    ${theme.fg("dim", truncate(call.argsPreview, 180).replace(/\n/g, "\n    "))}`;
						if (call.error) text += `\n    ${theme.fg("error", call.error)}`;
					}
				}
				if (!expanded && details.bridgeCalls.length > 4) {
					text += `\n  ${theme.fg("dim", `... ${details.bridgeCalls.length - 4} more`)}`;
				}
			}

			if (details.logs.length > 0 || details.logNotice) {
				const shownLogs = expanded ? details.logs : details.logs.slice(0, 3);
				text += `\n${theme.fg("muted", `logs (${details.logs.length}):`)}`;
				for (const line of shownLogs) {
					text += `\n  ${theme.fg("toolOutput", line)}`;
				}
				if (!expanded && details.logs.length > 3) {
					text += `\n  ${theme.fg("dim", `... ${details.logs.length - 3} more`)}`;
				}
				if (details.logNotice) {
					text += `\n  ${theme.fg("warning", details.logNotice)}`;
				}
			}

			if (details.outputTruncation?.truncated) {
				text += `\n${theme.fg("warning", formatOutputTruncationNotice(details.outputTruncation))}`;
			}

			if (!expanded) {
				text += `\n${theme.fg("dim", "expand to inspect script, bridge calls, logs, and sandbox details")}`;
			}

			if (expanded) {
				text += `\n${theme.fg("muted", `exit=${details.exitCode ?? "null"} timeout=${details.timeout}s cwd=${details.cwd}`)}`;
				text += `\n${theme.fg("muted", `sandbox reason: ${details.sandbox.reason}`)}`;
			}

			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const timeout = clampTimeout(params.timeout);
			const profile = (params.profile ?? "analysis") as CodemodeProfileName;
			const cwd = await resolveExecutionCwd(ctx.cwd, params.cwd);
			const config = loadConfig(cwd);
			const policy = activePolicy(config, detectAgentName(pi), detectProfileName(pi));
			const tmpBase = getEffectiveSandboxTmpDir(cwd, config.sandbox);
			await fs.mkdir(tmpBase, { recursive: true });
			const runtimeDir = await fs.mkdtemp(path.join(tmpBase, "codemode-"));
			const artifactsDir = path.join(runtimeDir, "artifacts");
			const resolvedPolicy = resolveCodemodePolicy(policy, cwd, config.sandbox, profile, runtimeDir);

			if (!resolvedPolicy.sandbox.enabled) {
				await fs.rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
				throw new Error(`TypeScript requires sandboxing, but sandboxing is disabled: ${resolvedPolicy.sandbox.reason}`);
			}

			onUpdate?.({ content: [{ type: "text", text: `Starting TypeScript (${profile})...` }] });

			let exitCode: number | null = null;
			const rawOutputState = createRawOutputCaptureState();
			const sandboxMode: "dedicated" = "dedicated";
			let protocolResult: ProtocolResult | undefined;
			const logState = createLogCaptureState();
			const artifacts: CodemodeArtifact[] = [];
			const bridgeCalls: CodemodeBridgeCall[] = [];
			const runtimeEnv = {
				...process.env,
				TMPDIR: runtimeDir,
				CLAUDE_TMPDIR: runtimeDir,
				PI_CODEMODE_PROFILE: profile,
				PI_CODEMODE_CWD: cwd,
			};
			const { entryFile } = await createRuntimeFiles(runtimeDir, params.code, resolvedPolicy.capabilities);
			const command = `bun ${JSON.stringify(entryFile)}`;
			let stdinWriter: NodeJS.WritableStream | undefined;
			let stdoutBuffer = "";

			const bridgeState: BridgeRuntimeState = {
				capabilities: resolvedPolicy.capabilities,
				artifactsDir,
				artifacts,
				bridgeCalls,
				onUpdate,
				signal,
				cwd,
				allowProjectAgents: resolvedPolicy.allowProjectAgents,
			};

			const handleProtocolLine = (line: string) => {
				if (!line) return;
				if (line.startsWith(LOG_PREFIX)) {
					try {
						const payload = JSON.parse(line.slice(LOG_PREFIX.length)) as ProtocolLog;
						appendLogLine(logState, formatLogLine(payload));
					} catch {
						appendLogLine(logState, `[protocol] could not parse log payload: ${line.slice(LOG_PREFIX.length)}`);
					}
					return;
				}
				if (line.startsWith(RESULT_PREFIX)) {
					try {
						protocolResult = JSON.parse(line.slice(RESULT_PREFIX.length)) as ProtocolResult;
					} catch (error) {
						protocolResult = {
							ok: false,
							error: {
								phase: "protocol",
								message: `Failed to parse runtime result: ${error instanceof Error ? error.message : String(error)}`,
							},
						};
					}
					return;
				}
				if (line.startsWith(BRIDGE_REQUEST_PREFIX)) {
					void (async () => {
						if (!stdinWriter) return;
						let response: BridgeResponse;
						let request: BridgeRequest | undefined;
						try {
							request = JSON.parse(line.slice(BRIDGE_REQUEST_PREFIX.length)) as BridgeRequest;
							const startedAt = Date.now();
							const call: CodemodeBridgeCall = {
								name: request.method,
								argsPreview: truncate(serializeForDisplay(request.args), 400),
								ok: false,
								startedAt,
								endedAt: startedAt,
							};
							try {
								const result = await executeBridgeRequest(bridgeState, request);
								call.ok = true;
								call.endedAt = Date.now();
								bridgeCalls.push(call);
								response = { id: request.id, ok: true, result };
							} catch (error) {
								call.ok = false;
								call.endedAt = Date.now();
								call.error = error instanceof Error ? error.message : String(error);
								bridgeCalls.push(call);
								response = {
									id: request.id,
									ok: false,
									error: { message: error instanceof Error ? error.message : String(error) },
								};
							}
						} catch (error) {
							response = {
								id: request?.id ?? -1,
								ok: false,
								error: { message: error instanceof Error ? error.message : String(error) },
							};
						}
						stdinWriter.write(`${BRIDGE_RESPONSE_PREFIX}${JSON.stringify(response)}\n`);
					})();
					return;
				}
			};

			const handleStdoutData = (chunk: Buffer) => {
				const text = chunk.toString("utf8");
				appendRawOutput(rawOutputState, text);
				stdoutBuffer += text;
				const lines = stdoutBuffer.split(/\r?\n/);
				stdoutBuffer = lines.pop() || "";
				for (const line of lines) handleProtocolLine(line);
			};
			const handleStderrData = (chunk: Buffer) => {
				appendRawOutput(rawOutputState, chunk.toString("utf8"));
			};

			try {
				const sandboxManager = await initializeSandboxManager(resolvedPolicy.sandbox.config);
				try {
					const result = await runSandboxedCommand(sandboxManager, {
						command,
						cwd,
						timeout,
						signal,
						env: runtimeEnv,
						stdinMode: "pipe",
						onSpawn: (child) => {
							stdinWriter = child.stdin ?? undefined;
						},
						onStdoutData: handleStdoutData,
						onStderrData: handleStderrData,
					});
					exitCode = result.exitCode;
				} finally {
					await sandboxManager.reset().catch(() => {});
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const rawOutput = finalizeRawOutput(rawOutputState);
				const logs = [...logState.lines];
				const logNotice = formatLogNotice(logState);
				const details: CodemodeDetails = {
					profile,
					cwd,
					timeout,
					code: params.code,
					exitCode,
					ok: false,
					error: {
						phase: message.startsWith("timeout:") ? "timeout" : "execute",
						message,
					},
					logs,
					logNotice,
					rawOutput: rawOutput.text,
					rawOutputNotice: rawOutput.notice,
					artifacts,
					bridgeCalls,
					sandbox: {
						enabled: resolvedPolicy.sandbox.enabled,
						reason: resolvedPolicy.sandbox.reason,
						mode: sandboxMode,
					},
				};
				throwCodemodeExecutionError(details);
			} finally {
				await fs.rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
			}

			if (stdoutBuffer.trim()) handleProtocolLine(stdoutBuffer.trim());
			const finalResult: ProtocolResult = protocolResult ?? {
				ok: false,
				error: {
					phase: "protocol",
					message: "Runtime did not emit a final result envelope",
				},
			};

			const rawOutput = finalizeRawOutput(rawOutputState);
			const logs = [...logState.lines];
			const logNotice = formatLogNotice(logState);
			const details: CodemodeDetails = {
				profile,
				cwd,
				timeout,
				code: params.code,
				exitCode,
				ok: finalResult.ok,
				result: finalResult.ok ? finalResult.result : undefined,
				error: finalResult.ok ? undefined : finalResult.error,
				logs,
				logNotice,
				rawOutput: rawOutput.text,
				rawOutputNotice: rawOutput.notice,
				artifacts,
				bridgeCalls,
				sandbox: {
					enabled: resolvedPolicy.sandbox.enabled,
					reason: resolvedPolicy.sandbox.reason,
					mode: sandboxMode,
				},
			};

			const output = truncateToolOutput(buildContent(details));
			details.outputTruncation = output.truncation;

			if (!details.ok) {
				throwCodemodeExecutionError(details);
			}

			return {
				content: [{ type: "text", text: output.text }],
				details,
			};
		},
	});
}

export const __test__ = {
	parseProtocolOutput,
	truncateToolOutput,
	createRawOutputCaptureState,
	appendRawOutput,
	finalizeRawOutput,
	buildRunnerSource,
	splitImportsAndBody,
	buildUserModule,
	resolveExecutionCwd,
	clampTimeout,
	sanitizeArtifactName,
	terminateProcessWithEscalation,
};
