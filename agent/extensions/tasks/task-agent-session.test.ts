import { describe, expect, it, mock } from "bun:test";
import * as taskRpcWorker from "./task-rpc-worker.js";

let capturedArgs: string[] | undefined;
let capturedEnv: NodeJS.ProcessEnv | undefined;

mock.module("./task-rpc-worker.js", () => ({
	...taskRpcWorker,
	spawnRpcWorker: async (options: { args: string[]; env: NodeJS.ProcessEnv }) => {
		capturedArgs = options.args;
		capturedEnv = options.env;
		return {
			handle: {
				sessionManager: { getSessionId: () => "worker-session-1", getSessionFile: () => undefined },
				isStreaming: false,
				messages: [],
				subscribe: () => () => {},
				prompt: async () => {},
				steer: async () => {},
				abort: async () => {},
				dispose: () => {},
			},
		};
	},
}));

const { createWorkerAgentSession, TASK_COMPLETE_TOOL_NAME, ASK_CALLER_TOOL_NAME } =
	await import("./task-agent-session.js");

const noopControlSignal = { onComplete: () => {}, onPing: () => {} };

function flagValue(args: string[] | undefined, flag: string): string | undefined {
	const index = args?.indexOf(flag) ?? -1;
	return index >= 0 ? args?.[index + 1] : undefined;
}

describe("createWorkerAgentSession", () => {
	it("sets agent-name/profile-name in the child process's own env, not the current process's", async () => {
		const previousAgentEnv = process.env.PI_AGENT_NAME;
		const previousProfileEnv = process.env.PI_PROFILE_NAME;
		delete process.env.PI_AGENT_NAME;
		delete process.env.PI_PROFILE_NAME;

		const result = await createWorkerAgentSession({
			cwd: "/tmp/worker",
			modelRegistry: {} as never,
			systemPrompt: "Be helpful.",
			systemPromptMode: "append",
			allowDelegation: false,
			projectTrusted: false,
			noContextFiles: true,
			noSkills: true,
			agentName: "reviewer",
			profileName: "review-permissions",
			controlSignal: noopControlSignal,
		});

		expect(result.error).toBeUndefined();
		expect(capturedEnv?.PI_AGENT_NAME).toBe("reviewer");
		expect(capturedEnv?.PI_PROFILE_NAME).toBe("review-permissions");
		// The whole point: the current (parent) process's own env is never touched.
		expect(process.env.PI_AGENT_NAME).toBeUndefined();
		expect(process.env.PI_PROFILE_NAME).toBeUndefined();

		if (previousAgentEnv === undefined) delete process.env.PI_AGENT_NAME;
		else process.env.PI_AGENT_NAME = previousAgentEnv;
		if (previousProfileEnv === undefined) delete process.env.PI_PROFILE_NAME;
		else process.env.PI_PROFILE_NAME = previousProfileEnv;
	});

	it("leaves the child's env without agent-name/profile-name when the worker has none", async () => {
		await createWorkerAgentSession({
			cwd: "/tmp/worker",
			modelRegistry: {} as never,
			systemPrompt: "",
			systemPromptMode: "append",
			allowDelegation: false,
			projectTrusted: false,
			noContextFiles: false,
			noSkills: false,
			controlSignal: noopControlSignal,
		});

		expect(capturedEnv?.PI_AGENT_NAME).toBeUndefined();
		expect(capturedEnv?.PI_PROFILE_NAME).toBeUndefined();
	});

	it("adds task to --exclude-tools when the worker cannot delegate", async () => {
		await createWorkerAgentSession({
			cwd: "/tmp/worker",
			modelRegistry: {} as never,
			systemPrompt: "",
			systemPromptMode: "append",
			allowDelegation: false,
			projectTrusted: false,
			noContextFiles: false,
			noSkills: false,
			excludeTools: ["bash"],
			controlSignal: noopControlSignal,
		});

		const excludeTools = flagValue(capturedArgs, "--exclude-tools");
		expect(excludeTools).toContain("task");
		expect(excludeTools).toContain("bash");
	});

	it("passes noContextFiles/noSkills through as CLI flags", async () => {
		await createWorkerAgentSession({
			cwd: "/tmp/worker",
			modelRegistry: {} as never,
			systemPrompt: "",
			systemPromptMode: "append",
			allowDelegation: true,
			projectTrusted: false,
			noContextFiles: true,
			noSkills: true,
			additionalSkillPaths: ["/tmp/skill"],
			controlSignal: noopControlSignal,
		});

		expect(capturedArgs).toContain("--no-context-files");
		expect(capturedArgs).toContain("--no-skills");
		expect(capturedArgs).toContain("--skill");
		expect(flagValue(capturedArgs, "--skill")).toBe("/tmp/skill");
	});

	it("leaves tools unrestricted when the worker has no explicit allowlist", async () => {
		await createWorkerAgentSession({
			cwd: "/tmp/worker",
			modelRegistry: {} as never,
			systemPrompt: "",
			systemPromptMode: "append",
			allowDelegation: false,
			projectTrusted: false,
			noContextFiles: false,
			noSkills: false,
			controlSignal: noopControlSignal,
		});

		expect(capturedArgs).not.toContain("--tools");
		expect(capturedArgs).not.toContain("--no-tools");
	});

	it("always includes task_complete/ask_caller in an explicit tools allowlist", async () => {
		await createWorkerAgentSession({
			cwd: "/tmp/worker",
			modelRegistry: {} as never,
			systemPrompt: "",
			systemPromptMode: "append",
			allowDelegation: false,
			projectTrusted: false,
			noContextFiles: false,
			noSkills: false,
			tools: ["read"],
			controlSignal: noopControlSignal,
		});

		const tools = flagValue(capturedArgs, "--tools");
		expect(tools).toContain("read");
		expect(tools).toContain(TASK_COMPLETE_TOOL_NAME);
		expect(tools).toContain(ASK_CALLER_TOOL_NAME);
	});

	it("still reaches task_complete/ask_caller when the worker is configured with zero tools", async () => {
		await createWorkerAgentSession({
			cwd: "/tmp/worker",
			modelRegistry: {} as never,
			systemPrompt: "",
			systemPromptMode: "append",
			allowDelegation: false,
			projectTrusted: false,
			noContextFiles: false,
			noSkills: false,
			tools: [],
			controlSignal: noopControlSignal,
		});

		expect(capturedArgs).not.toContain("--no-tools");
		const tools = flagValue(capturedArgs, "--tools");
		expect(tools?.split(",").sort()).toEqual([ASK_CALLER_TOOL_NAME, TASK_COMPLETE_TOOL_NAME].sort());
	});

	it("passes --session when persisted, --no-session when ephemeral", async () => {
		await createWorkerAgentSession({
			cwd: "/tmp/worker",
			modelRegistry: {} as never,
			systemPrompt: "",
			systemPromptMode: "append",
			allowDelegation: false,
			projectTrusted: false,
			noContextFiles: false,
			noSkills: false,
			controlSignal: noopControlSignal,
		});
		expect(capturedArgs).toContain("--no-session");

		await createWorkerAgentSession({
			cwd: "/tmp/worker",
			modelRegistry: {} as never,
			systemPrompt: "",
			systemPromptMode: "append",
			allowDelegation: false,
			projectTrusted: false,
			noContextFiles: false,
			noSkills: false,
			sessionFile: "/tmp/session.jsonl",
			controlSignal: noopControlSignal,
		});
		expect(flagValue(capturedArgs, "--session")).toBe("/tmp/session.jsonl");
	});

	it("passes --approve/--no-approve based on projectTrusted", async () => {
		await createWorkerAgentSession({
			cwd: "/tmp/worker",
			modelRegistry: {} as never,
			systemPrompt: "",
			systemPromptMode: "append",
			allowDelegation: false,
			projectTrusted: false,
			noContextFiles: false,
			noSkills: false,
			controlSignal: noopControlSignal,
		});
		expect(capturedArgs).toContain("--no-approve");

		await createWorkerAgentSession({
			cwd: "/tmp/worker",
			modelRegistry: {} as never,
			systemPrompt: "",
			systemPromptMode: "append",
			allowDelegation: false,
			projectTrusted: true,
			noContextFiles: false,
			noSkills: false,
			controlSignal: noopControlSignal,
		});
		expect(capturedArgs).toContain("--approve");
	});
});
