import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let taskExtension: Awaited<ReturnType<typeof import("./task")>>["default"];
let __test__: Awaited<ReturnType<typeof import("./task")>>["__test"];
let testAgentDir: string;

beforeAll(async () => {
	testAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tasks-ext-test-"));

	mock.module("@mariozechner/pi-ai", () => ({
		StringEnum: (values: readonly string[]) => ({ type: "string", enum: [...values] }),
	}));

	mock.module("@sinclair/typebox", () => ({
		Type: {
			Object: (value: unknown) => value,
			String: (value?: unknown) => value,
			Optional: (value: unknown) => value,
			Array: (value: unknown) => value,
			Boolean: (value?: unknown) => value,
		},
	}));

	mock.module("@mariozechner/pi-tui", () => ({
		Container: class {
			addChild(_child: unknown) {}
		},
		Markdown: class {
			constructor(_text: string) {}
		},
		Spacer: class {
			constructor(_size: number) {}
		},
		Text: class {
			constructor(_text: string) {}
		},
	}));

	mock.module("@mariozechner/pi-coding-agent", () => ({
		getAgentDir: () => testAgentDir,
		getMarkdownTheme: () => ({}),
		withFileMutationQueue: async (_filePath: string, mutation: () => Promise<void>) => mutation(),
	}));

	mock.module("./agents.js", () => ({
		discoverResources: () => ({
			agents: [],
			profiles: [],
			modelTiers: [],
			globalTasksConfig: null,
			projectTasksConfig: null,
			globalTasksFile: path.join(testAgentDir, "tasks.json"),
			projectTasksFile: null,
			projectAgentsDir: null,
			projectProfilesDir: null,
			projectModelTiersFile: null,
		}),
		resolveSkillPaths: () => ({ paths: [], missing: [] }),
	}));

	const mod = await import("./task");
	taskExtension = mod.default;
	__test__ = mod.__test__;
});

afterAll(async () => {
	await fs.rm(testAgentDir, { recursive: true, force: true });
});

function createResources(overrides: Record<string, unknown> = {}) {
	return {
		agents: [],
		profiles: [],
		modelTiers: [],
		globalTasksConfig: null,
		projectTasksConfig: null,
		globalTasksFile: path.join(testAgentDir, "tasks.json"),
		projectTasksFile: null,
		projectAgentsDir: null,
		projectProfilesDir: null,
		projectModelTiersFile: null,
		...overrides,
	};
}

function createTaskTool() {
	let tool: any;
	const pi = {
		registerFlag: () => {},
		on: () => {},
		registerCommand: () => {},
		registerTool: (definition: any) => {
			tool = definition;
		},
		getFlag: () => undefined,
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => {},
		setModel: async () => true,
	};
	taskExtension(pi as any);
	return tool;
}

function makeRun(runId: string, childSessionId: string): any {
	const timestamp = "2024-01-01T00:00:00.000Z";
	return {
		internalRunKey: runId,
		runId,
		toolCallId: `tool-${runId}`,
		mode: "single",
		steps: [
			{
				step: 1,
				snapshot: {
					v: 1,
					runId,
					toolCallId: `tool-${runId}`,
					mode: "single",
					step: 1,
					childSessionId,
					childSessionPath: `/tmp/${childSessionId}.jsonl`,
					effectiveContext: "fresh",
					persist: true,
					taskPreview: "task",
					createdAt: timestamp,
					status: "succeeded",
				},
				status: "succeeded",
				isLive: false,
				hasTerminalMetadata: true,
				warnings: [],
				sourceOrder: 1,
			},
		],
		stepCount: 1,
		persistedStepCount: 1,
		createdAt: timestamp,
		updatedAt: timestamp,
		status: "succeeded",
		warnings: [],
		latestSourceOrder: 1,
	};
}

describe("tasks extension persisted-session guardrails", () => {
	it("rejects runtime persist override in task execution", async () => {
		const tool = createTaskTool();

		const result = await tool.execute(
			"tc-1",
			{ task: "Do work", prompt: "Be concise", persist: true },
			undefined,
			undefined,
			{
				cwd: process.cwd(),
				hasUI: false,
				sessionManager: {
					getSessionFile: () => undefined,
					getBranch: () => [],
					appendCustomEntry: () => "entry-id",
				},
			},
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.type).toBe("text");
		expect(result.content[0]?.text).toContain("Runtime persist overrides are not supported");
	});

	it("fails preflight for fork context when effective persist is false", async () => {
		const resources = createResources({
			agents: [
				{
					name: "no-persist",
					description: "persist disabled",
					enabled: true,
					availability: "both",
					systemPromptMode: "append",
					systemPrompt: "",
					source: "user",
					filePath: "/tmp/no-persist.md",
					persist: false,
				},
			],
		});

		const preflight = await __test__.preflightTaskRun(
			"single",
			[{ agent: "no-persist", task: "Do work", context: "fork" }],
			resources as any,
			process.cwd(),
			{
				getSessionFile: () => path.join(testAgentDir, "sessions", "parent.jsonl"),
				getBranch: () => [{ type: "session", id: "parent" }] as any,
			},
		);

		expect(preflight.prepared).toBeUndefined();
		expect(preflight.error).toContain('context.mode="fork"');
		expect(preflight.error).toContain("persist=false");
	});

	it("fails preflight for fork context when parent session is missing", async () => {
		const preflight = await __test__.preflightTaskRun(
			"single",
			[{ task: "Do work", prompt: "Worker prompt", context: "fork" }],
			createResources() as any,
			process.cwd(),
			{
				getSessionFile: () => undefined,
				getBranch: () => [],
			},
		);

		expect(preflight.prepared).toBeUndefined();
		expect(preflight.error).toContain('context.mode="fork" requires a parent session file');
	});

	it("stores persisted child sessions under the parent session hierarchy", async () => {
		const parentSessionId = "parent-session-id";
		const parentSessionFile = path.join(testAgentDir, "sessions", "workspace", "main", "parent-session.jsonl");
		const expectedRoot = path.join(
			testAgentDir,
			"sessions",
			"workspace",
			"main",
			"task-runs",
			"parent-session-id--parent-session",
		);

		expect(__test__.resolvePersistedTaskSessionRoot(parentSessionFile, parentSessionId)).toBe(expectedRoot);

		const preflight = await __test__.preflightTaskRun(
			"single",
			[{ task: "Do work", prompt: "Worker prompt", context: "fresh" }],
			createResources() as any,
			process.cwd(),
			{
				getSessionFile: () => parentSessionFile,
				getBranch: () => [{ type: "session", id: parentSessionId, version: 3, timestamp: new Date().toISOString() }] as any,
			},
		);

		expect(preflight.error).toBeUndefined();
		expect(preflight.prepared?.sessionRunRoot).toStartWith(`${expectedRoot}${path.sep}`);
		expect(path.dirname(preflight.prepared?.sessionRunRoot ?? "")).toBe(expectedRoot);
		expect(preflight.prepared?.sessionRunRoot).not.toContain(path.join("agent", "extensions", "tasks", "sessions"));
		expect(preflight.prepared?.steps[0]?.session.sessionFile).toStartWith(preflight.prepared?.sessionRunRoot ?? "");
	});
});

describe("/tasks selector precedence", () => {
	it("resolves numeric selectors as list index before id-prefix matching", () => {
		const runs = [makeRun("alpha-run", "alpha-child"), makeRun("1-prefixed-run", "one-child")];

		const resolved = __test__.resolveTaskSelector("1", runs);
		expect(resolved.error).toBeUndefined();
		expect(resolved.resolution?.matchedBy).toBe("index");
		expect(resolved.resolution?.run.runId).toBe("alpha-run");
	});

	it("keeps non-numeric selector precedence for run-id and child-session matches", () => {
		const runs = [makeRun("focus-run", "session-a"), makeRun("other-run", "focus-child")];

		const byRunId = __test__.resolveTaskSelector("focus", runs);
		expect(byRunId.error).toBeUndefined();
		expect(byRunId.resolution?.matchedBy).toBe("runId");
		expect(byRunId.resolution?.run.runId).toBe("focus-run");

		const byChildSession = __test__.resolveTaskSelector("focus-child", runs);
		expect(byChildSession.error).toBeUndefined();
		expect(byChildSession.resolution?.matchedBy).toBe("childSession");
		expect(byChildSession.resolution?.step?.snapshot.childSessionId).toBe("focus-child");
	});
});
