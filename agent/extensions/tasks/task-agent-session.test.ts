import { describe, expect, it, mock } from "bun:test";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";

let capturedResourceLoaderOptions: unknown;
let capturedCreateAgentSessionOptions: unknown;
const fakeRuntime = { flagValues: new Map<string, boolean | string>() };

// Spreads the real module first (like task.test.ts does) so other test files sharing this
// bun:test process still see the real getAgentDir/createBashTool/etc. -- replacing the whole
// module instead of just the handful of exports this file fakes previously broke
// permissions.test.ts when run as part of the full suite.
mock.module("@earendil-works/pi-coding-agent", () => ({
	...piCodingAgent,
	resolveCliModel: () => ({ model: undefined, error: undefined }),
	DefaultResourceLoader: class {
		constructor(options: unknown) {
			capturedResourceLoaderOptions = options;
		}
		async reload() {}
		getExtensions() {
			return { runtime: fakeRuntime };
		}
	},
	SessionManager: {
		inMemory: (cwd: string) => ({ cwd }),
		open: (file: string) => ({ file }),
	},
	createAgentSession: async (options: unknown) => {
		capturedCreateAgentSessionOptions = options;
		return { session: { sessionManager: { getSessionId: () => "worker-session-1" } } };
	},
}));

const { createWorkerAgentSession } = await import("./task-agent-session.js");

describe("createWorkerAgentSession", () => {
	it("sets agent-name/profile-name as session-scoped extension flag values, not process.env", async () => {
		fakeRuntime.flagValues.clear();
		const previousAgentEnv = process.env.PI_AGENT_NAME;
		const previousProfileEnv = process.env.PI_PROFILE_NAME;
		delete process.env.PI_AGENT_NAME;
		delete process.env.PI_PROFILE_NAME;

		const result = await createWorkerAgentSession({
			cwd: "/tmp/worker",
			agentDir: "/tmp/agent-dir",
			modelRegistry: {} as never,
			systemPrompt: "Be helpful.",
			systemPromptMode: "append",
			allowDelegation: false,
			projectTrusted: false,
			noContextFiles: true,
			noSkills: true,
			agentName: "reviewer",
			profileName: "review-permissions",
		});

		expect(result.error).toBeUndefined();
		expect(fakeRuntime.flagValues.get("agent-name")).toBe("reviewer");
		expect(fakeRuntime.flagValues.get("profile-name")).toBe("review-permissions");
		// The whole point: no global env var touched.
		expect(process.env.PI_AGENT_NAME).toBeUndefined();
		expect(process.env.PI_PROFILE_NAME).toBeUndefined();

		if (previousAgentEnv === undefined) delete process.env.PI_AGENT_NAME;
		else process.env.PI_AGENT_NAME = previousAgentEnv;
		if (previousProfileEnv === undefined) delete process.env.PI_PROFILE_NAME;
		else process.env.PI_PROFILE_NAME = previousProfileEnv;
	});

	it("leaves flag values untouched when the worker has no agent/profile name", async () => {
		fakeRuntime.flagValues.clear();

		await createWorkerAgentSession({
			cwd: "/tmp/worker",
			agentDir: "/tmp/agent-dir",
			modelRegistry: {} as never,
			systemPrompt: "",
			systemPromptMode: "append",
			allowDelegation: false,
			projectTrusted: false,
			noContextFiles: false,
			noSkills: false,
		});

		expect(fakeRuntime.flagValues.has("agent-name")).toBeFalse();
		expect(fakeRuntime.flagValues.has("profile-name")).toBeFalse();
	});

	it("adds task to excludeTools when the worker cannot delegate", async () => {
		await createWorkerAgentSession({
			cwd: "/tmp/worker",
			agentDir: "/tmp/agent-dir",
			modelRegistry: {} as never,
			systemPrompt: "",
			systemPromptMode: "append",
			allowDelegation: false,
			projectTrusted: false,
			noContextFiles: false,
			noSkills: false,
			excludeTools: ["bash"],
		});

		const options = capturedCreateAgentSessionOptions as { excludeTools?: string[] };
		expect(options.excludeTools).toContain("task");
		expect(options.excludeTools).toContain("bash");
	});

	it("passes noContextFiles/noSkills through to the resource loader", async () => {
		await createWorkerAgentSession({
			cwd: "/tmp/worker",
			agentDir: "/tmp/agent-dir",
			modelRegistry: {} as never,
			systemPrompt: "",
			systemPromptMode: "append",
			allowDelegation: true,
			projectTrusted: false,
			noContextFiles: true,
			noSkills: true,
			additionalSkillPaths: ["/tmp/skill"],
		});

		const options = capturedResourceLoaderOptions as {
			noContextFiles?: boolean;
			noSkills?: boolean;
			additionalSkillPaths?: string[];
		};
		expect(options.noContextFiles).toBeTrue();
		expect(options.noSkills).toBeTrue();
		expect(options.additionalSkillPaths).toEqual(["/tmp/skill"]);
	});
});
