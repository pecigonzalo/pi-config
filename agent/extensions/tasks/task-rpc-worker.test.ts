import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";

class FakeStream extends EventEmitter {
	destroyed = false;
	written: string[] = [];
	write(chunk: string, cb?: (err?: Error) => void): boolean {
		this.written.push(chunk);
		this.emit("write", chunk);
		cb?.();
		return true;
	}
}

class FakeChildProcess extends EventEmitter {
	stdin = new FakeStream();
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly signals: Array<NodeJS.Signals | number> = [];

	constructor() {
		super();
		// Auto-answer every get_state request so spawnRpcWorker's readiness handshake resolves
		// without each test having to wire that up itself.
		this.stdin.on("write", (chunk: string) => {
			for (const line of chunk.split("\n")) {
				if (!line.trim()) continue;
				const message = JSON.parse(line);
				if (message.type === "get_state") {
					queueMicrotask(() =>
						this.emitLine({
							type: "response",
							id: message.id,
							success: true,
							data: { sessionId: "child-session-1", sessionFile: undefined },
						}),
					);
				}
			}
		});
	}

	kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
		this.signals.push(signal);
		queueMicrotask(() => this.finishWithSignal(typeof signal === "string" ? signal : "SIGTERM"));
		return true;
	}

	finishWithSignal(signal: NodeJS.Signals): void {
		if (this.exitCode !== null || this.signalCode !== null) return;
		this.signalCode = signal;
		this.emit("close", null, signal);
	}

	emitLine(obj: Record<string, unknown>): void {
		this.stdout.emit("data", Buffer.from(`${JSON.stringify(obj)}\n`));
	}
}

let currentFake: FakeChildProcess;
const spawnCalls: Array<{ command: string; args: string[] }> = [];

mock.module("node:child_process", () => ({
	spawn: (command: string, args: string[]) => {
		spawnCalls.push({ command, args });
		return currentFake;
	},
}));

const {
	spawnRpcWorker,
	getPiInvocation,
	checkSubagentDepth,
	appendWorkerToolFlags,
	appendProjectTrustFlags,
	appendWorkerSkillFlags,
} = await import("./task-rpc-worker.js");

beforeEach(() => {
	currentFake = new FakeChildProcess();
	spawnCalls.length = 0;
});

describe("getPiInvocation", () => {
	it("falls back to the bare pi command for a generic node/bun runtime with no script path", () => {
		const originalArgv1 = process.argv[1];
		const originalExecPath = process.execPath;
		Object.defineProperty(process, "argv", { value: [process.argv[0], undefined], configurable: true });
		Object.defineProperty(process, "execPath", { value: "/usr/local/bin/node", configurable: true });

		const invocation = getPiInvocation(["--mode", "rpc"]);
		expect(invocation).toEqual({ command: "pi", args: ["--mode", "rpc"] });

		Object.defineProperty(process, "argv", { value: [process.argv[0], originalArgv1], configurable: true });
		Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
	});
});

describe("checkSubagentDepth", () => {
	afterEach(() => {
		delete process.env.PI_SUBAGENT_DEPTH;
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
	});

	it("is not blocked at depth 0 with the default max depth", () => {
		delete process.env.PI_SUBAGENT_DEPTH;
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		const result = checkSubagentDepth();
		expect(result.blocked).toBe(false);
		expect(result.depth).toBe(0);
		expect(result.maxDepth).toBe(2);
	});

	it("blocks once depth reaches the configured max", () => {
		process.env.PI_SUBAGENT_DEPTH = "2";
		process.env.PI_SUBAGENT_MAX_DEPTH = "2";
		expect(checkSubagentDepth().blocked).toBe(true);
	});
});

describe("CLI flag builders", () => {
	it("appendWorkerToolFlags forces task into --exclude-tools when delegation is disallowed", () => {
		const args: string[] = [];
		appendWorkerToolFlags(args, { tools: undefined, excludeTools: ["bash"], allowDelegation: false });
		expect(args).toEqual(["--exclude-tools", "bash,task"]);
	});

	it("appendWorkerToolFlags emits --no-tools for an empty allowlist", () => {
		const args: string[] = [];
		appendWorkerToolFlags(args, { tools: [], excludeTools: undefined, allowDelegation: true });
		expect(args).toEqual(["--no-tools"]);
	});

	it("appendProjectTrustFlags toggles --approve/--no-approve", () => {
		expect(
			(() => {
				const args: string[] = [];
				appendProjectTrustFlags(args, false);
				return args;
			})(),
		).toEqual(["--no-approve"]);
		expect(
			(() => {
				const args: string[] = [];
				appendProjectTrustFlags(args, true);
				return args;
			})(),
		).toEqual(["--approve"]);
	});

	it("appendWorkerSkillFlags emits --no-skills and any explicit --skill paths", () => {
		const args: string[] = [];
		appendWorkerSkillFlags(args, { noSkills: true, additionalSkillPaths: ["/tmp/a", "/tmp/b"] });
		expect(args).toEqual(["--no-skills", "--skill", "/tmp/a", "--skill", "/tmp/b"]);
	});
});

describe("spawnRpcWorker", () => {
	function noopSignal() {
		return { onComplete: () => {}, onPing: () => {} };
	}

	it("resolves the handle once get_state responds, exposing the reported session id", async () => {
		const result = await spawnRpcWorker({
			cwd: "/tmp/worker",
			args: ["--mode", "rpc"],
			env: process.env,
			signal: noopSignal(),
		});

		expect(result.error).toBeUndefined();
		expect(result.handle?.sessionManager.getSessionId()).toBe("child-session-1");
	});

	it("detects task_complete via tool_execution_start, not the tool's own execute() completing", async () => {
		let completedWith: string | undefined;
		const result = await spawnRpcWorker({
			cwd: "/tmp/worker",
			args: ["--mode", "rpc"],
			env: process.env,
			signal: { onComplete: (summary) => (completedWith = summary), onPing: () => {} },
		});
		const handle = result.handle!;

		currentFake.emitLine({
			type: "tool_execution_start",
			toolName: "task_complete",
			args: { summary: "All done." },
		});
		await Promise.resolve();

		expect(completedWith).toBe("All done.");
	});

	it("detects ask_caller via tool_execution_start", async () => {
		let pingedWith: string | undefined;
		const result = await spawnRpcWorker({
			cwd: "/tmp/worker",
			args: ["--mode", "rpc"],
			env: process.env,
			signal: { onComplete: () => {}, onPing: (message) => (pingedWith = message) },
		});
		const handle = result.handle!;

		currentFake.emitLine({
			type: "tool_execution_start",
			toolName: "ask_caller",
			args: { message: "Which color?" },
		});
		await Promise.resolve();

		expect(pingedWith).toBe("Which color?");
	});

	it("prompt() resolves only once agent_settled fires after agent_start/agent_end, not on the prompt command's own ack", async () => {
		const result = await spawnRpcWorker({
			cwd: "/tmp/worker",
			args: ["--mode", "rpc"],
			env: process.env,
			signal: noopSignal(),
		});
		const handle = result.handle!;

		let settled = false;
		const promptPromise = handle.prompt("Task: do it").then(() => {
			settled = true;
		});

		// The prompt command's own ack -- must NOT resolve prompt() by itself.
		await Promise.resolve();
		const promptRequest = JSON.parse(currentFake.stdin.written.find((line) => line.includes('"prompt"'))!);
		currentFake.emitLine({ type: "response", id: promptRequest.id, success: true });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(settled).toBe(false);

		currentFake.emitLine({ type: "agent_start" });
		currentFake.emitLine({ type: "agent_end" });
		currentFake.emitLine({ type: "agent_settled" });

		await promptPromise;
		expect(settled).toBe(true);
	});

	it("dispose() kills the child process", async () => {
		const result = await spawnRpcWorker({
			cwd: "/tmp/worker",
			args: ["--mode", "rpc"],
			env: process.env,
			signal: noopSignal(),
		});
		result.handle!.dispose();
		expect(currentFake.signals).toContain("SIGTERM");
	});
});
