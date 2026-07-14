import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, test } from "bun:test";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";

let taskExtension: (typeof import("./task"))["default"];
let __test__: any;
let testAgentDir: string;
let sessionCounter = 0;
let mockResources: any;
let mockHasProjectTaskResources = false;
let mockHasCoreProjectResources = false;
let mockSavedProjectTrust: boolean | null = null;
const mockSavedProjectTrustByCwd = new Map<string, boolean>();
let lastDiscoveryProjectTrusted: boolean | undefined;

beforeAll(async () => {
	testAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tasks-ext-test-"));

	mock.module("@earendil-works/pi-ai", () => ({
		StringEnum: (values: readonly string[]) => ({ type: "string", enum: [...values] }),
	}));

	mock.module("typebox", () => ({
		Type: {
			Object: (properties: unknown, options?: Record<string, unknown>) => ({ type: "object", properties, ...options }),
			String: (options?: Record<string, unknown>) => ({ type: "string", ...options }),
			Optional: (value: unknown) => value,
			Number: (options?: Record<string, unknown>) => ({ type: "number", ...options }),
			Array: (items: unknown, options?: Record<string, unknown>) => ({ type: "array", items, ...options }),
			Boolean: (options?: Record<string, unknown>) => ({ type: "boolean", ...options }),
			Any: (options?: Record<string, unknown>) => ({ ...options }),
		},
	}));

	mock.module("@earendil-works/pi-tui", () => ({
		CURSOR_MARKER: "",
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
		matchesKey: () => false,
		truncateToWidth: (text: string, width: number) => text.slice(0, width),
		visibleWidth: (text: string) => text.length,
		wrapTextWithAnsi: (text: string, _width: number) => [text],
	}));

	mock.module("@earendil-works/pi-coding-agent", () => ({
		...piCodingAgent,
		hasTrustRequiringProjectResources: () => mockHasCoreProjectResources,
		ProjectTrustStore: class {
			get(cwd: string) {
				return mockSavedProjectTrustByCwd.get(cwd) ?? mockSavedProjectTrust;
			}
			set(cwd: string, trusted: boolean) {
				mockSavedProjectTrustByCwd.set(cwd, trusted);
			}
		},
		getAgentDir: () => testAgentDir,
		getMarkdownTheme: () => ({}),
		keyHint: (_binding: string, description: string) => `Ctrl+O ${description}`,
		withFileMutationQueue: async (_filePath: string, mutation: () => Promise<void>) => mutation(),
		SessionManager: {
			create: (cwd: string) => {
				sessionCounter += 1;
				const sessionId = `fresh-session-${sessionCounter}`;
				const sessionDir = path.join(testAgentDir, "sessions", cwd.replace(/[^a-zA-Z0-9._-]+/g, "-"));
				const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
				syncFs.mkdirSync(sessionDir, { recursive: true });
				return {
					getSessionFile: () => sessionFile,
					getSessionId: () => sessionId,
					getSessionDir: () => sessionDir,
				};
			},
			forkFrom: (sourcePath: string, targetCwd: string) => {
				sessionCounter += 1;
				const sessionId = `fork-session-${sessionCounter}`;
				const sessionDir = path.join(testAgentDir, "sessions", targetCwd.replace(/[^a-zA-Z0-9._-]+/g, "-"));
				const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
				syncFs.mkdirSync(sessionDir, { recursive: true });
				const sourceLines = syncFs.readFileSync(sourcePath, "utf-8").trim().split("\n").filter(Boolean);
				const [sourceHeader, ...rest] = sourceLines.map((line) => JSON.parse(line));
				const header = {
					type: "session",
					version: sourceHeader.version ?? 3,
					id: sessionId,
					timestamp: new Date().toISOString(),
					cwd: targetCwd,
					parentSession: sourcePath,
				};
				syncFs.writeFileSync(sessionFile, `${[header, ...rest].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
				const lastEntry = rest[rest.length - 1] as { id?: string } | undefined;
				return {
					getSessionFile: () => sessionFile,
					getSessionId: () => sessionId,
					getLeafId: () => (typeof lastEntry?.id === "string" ? lastEntry.id : null),
				};
			},
		},
	}));

	mock.module("./agents.js", () => ({
		discoverResources: (_cwd: string, _scope: string, projectTrusted?: boolean) => {
			lastDiscoveryProjectTrusted = projectTrusted;
			return mockResources ?? createResources();
		},
		hasProjectTaskResources: () => mockHasProjectTaskResources,
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
		efforts: [],
		globalTasksConfig: null,
		projectTasksConfig: null,
		globalTasksFile: path.join(testAgentDir, "tasks.json"),
		projectTasksFile: null,
		projectAgentsDir: null,
		projectProfilesDir: null,
		...overrides,
	};
}

function createExtensionHarness() {
	let tool: any;
	const eventHandlers: Record<string, (...args: any[]) => any> = {};
	const commandHandlers: Record<string, any> = {};
	const pi = {
		registerFlag: () => {},
		on: (eventName: string, handler: (...args: any[]) => any) => {
			eventHandlers[eventName] = handler;
		},
		registerCommand: (name: string, definition: any) => {
			commandHandlers[name] = definition;
		},
		registerShortcut: () => {},
		registerTool: (definition: any) => {
			tool = definition;
		},
		getFlag: () => undefined,
		getAllTools: () => [],
		getActiveTools: () => [],
		getThinkingLevel: () => "off",
		setActiveTools: () => {},
		setModel: async () => true,
		setThinkingLevel: () => {},
	};
	taskExtension(pi as any);
	return { tool, eventHandlers, commandHandlers, pi };
}

function createTaskTool() {
	return createExtensionHarness().tool;
}

function makeRun(runId: string, childSessionId: string, status: "running" | "succeeded" = "succeeded"): any {
	const timestamp = "2024-01-01T00:00:00.000Z";
	const stepStatus = status === "running" ? "running" : "succeeded";
	const snapshotStatus = status === "running" ? "created" : "succeeded";
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
					status: snapshotStatus,
				},
				status: stepStatus,
				isLive: status === "running",
				hasTerminalMetadata: status !== "running",
				warnings: [],
				sourceOrder: 1,
			},
		],
		stepCount: 1,
		persistedStepCount: 1,
		createdAt: timestamp,
		updatedAt: timestamp,
		status,
		warnings: [],
		latestSourceOrder: 1,
	};
}

describe("tasks extension UI chrome", () => {
	it("clears task widget and status on session lifecycle events", async () => {
		const { eventHandlers } = createExtensionHarness();
		const widgetCalls: any[][] = [];
		const statusCalls: any[][] = [];
		const ctx = {
			cwd: process.cwd(),
			hasUI: true,
			ui: {
				setWidget: (...args: any[]) => {
					widgetCalls.push(args);
				},
				setStatus: (...args: any[]) => {
					statusCalls.push(args);
				},
				notify: () => {},
			},
			sessionManager: {
				getSessionId: () => "session-1",
				getSessionFile: () => undefined,
				getBranch: () => [],
				appendCustomEntry: () => "entry-id",
			},
			modelRegistry: {
				find: () => undefined,
			},
		};

		await eventHandlers.session_start?.({}, ctx);
		expect(widgetCalls).toEqual([["tasks.runs", undefined]]);
		expect(statusCalls).toEqual([["tasks.runs", undefined]]);

		await eventHandlers.session_shutdown?.({}, ctx);
		expect(widgetCalls).toEqual([["tasks.runs", undefined], ["tasks.runs", undefined]]);
		expect(statusCalls).toEqual([["tasks.runs", undefined], ["tasks.runs", undefined]]);
	});

	it("awaits live controller shutdown and rejects pending RPCs", async () => {
		const { eventHandlers } = createExtensionHarness();
		const live = await import("./task-live.js");
		let rejectPending: ((error: Error) => void) | undefined;
		const pending = new Promise((_resolve, reject) => { rejectPending = reject; });
		let releaseClose: (() => void) | undefined;
		live.setLiveTaskController({
			key: "shutdown-test",
			close: async (error: Error = new Error("closed")) => {
				rejectPending?.(error);
				await new Promise<void>((resolve) => { releaseClose = resolve; });
			},
		} as any);
		const ctx = {
			cwd: process.cwd(),
			hasUI: false,
			ui: { setWidget: () => {}, setStatus: () => {} },
			sessionManager: { getSessionId: () => "shutdown", getSessionFile: () => undefined },
		};
		let shutdownFinished = false;
		const shutdown = eventHandlers.session_shutdown?.({}, ctx).then(() => { shutdownFinished = true; });
		await expect(pending).rejects.toThrow("shut down");
		expect(shutdownFinished).toBe(false);
		releaseClose?.();
		await shutdown;
		expect(live.listLiveTaskControllers()).toHaveLength(0);
	});

	it("toggles the task widget for the current session", async () => {
		const { commandHandlers } = createExtensionHarness();
		const widgetCalls: any[][] = [];
		const statusCalls: any[][] = [];
		const notifications: Array<{ message: string; level?: string }> = [];
		const ctx = {
			cwd: process.cwd(),
			hasUI: true,
			ui: {
				setWidget: (...args: any[]) => {
					widgetCalls.push(args);
				},
				setStatus: (...args: any[]) => {
					statusCalls.push(args);
				},
				notify: (message: string, level?: string) => {
					notifications.push({ message, level });
				},
			},
			sessionManager: {
				getSessionId: () => "session-1",
				getSessionFile: () => undefined,
				getBranch: () => [],
			},
			waitForIdle: async () => {},
		};

		await commandHandlers.tasks.handler("toggle", ctx);
		expect(widgetCalls[0]).toEqual([
			"tasks.runs",
			[
				"Task runs in current session (0):",
				"No task runs in current session.",
				"Use /tasks or Ctrl+Shift+T to browse · /tasks toggle hide",
			],
			{ placement: "aboveEditor" },
		]);
		expect(statusCalls[0]).toEqual(["tasks.runs", undefined]);
		expect(notifications[0]).toEqual({ message: "Tasks widget enabled for this session.", level: "info" });

		await commandHandlers.tasks.handler("toggle", ctx);
		expect(widgetCalls[1]).toEqual(["tasks.runs", undefined]);
		expect(statusCalls[1]).toEqual(["tasks.runs", undefined]);
		expect(notifications[1]).toEqual({ message: "Tasks widget hidden for this session.", level: "info" });
	});
});

describe("tasks project trust integration", () => {
	it("requires explicit trust for task-specific project resources", async () => {
		mockHasProjectTaskResources = true;
		try {
			const { eventHandlers } = createExtensionHarness();
			const trusted = await eventHandlers.project_trust?.(
				{ cwd: process.cwd() },
				{ hasUI: true, ui: { confirm: async () => true } },
			);
			const untrustedHeadless = await eventHandlers.project_trust?.(
				{ cwd: process.cwd() },
				{ hasUI: false, ui: { confirm: async () => true } },
			);

			expect(trusted).toEqual({ trusted: "yes", remember: true });
			expect(untrustedHeadless).toEqual({ trusted: "no" });
		} finally {
			mockHasProjectTaskResources = false;
		}
	});

	it("defers to Pi trust resolution when core project resources are present", async () => {
		mockHasProjectTaskResources = true;
		mockHasCoreProjectResources = true;
		try {
			const { eventHandlers } = createExtensionHarness();
			const result = await eventHandlers.project_trust?.(
				{ cwd: process.cwd() },
				{ hasUI: false, ui: { confirm: async () => false } },
			);

			expect(result).toEqual({ trusted: "undecided" });
		} finally {
			mockHasProjectTaskResources = false;
			mockHasCoreProjectResources = false;
		}
	});

	it("fails closed when Pi implicitly trusts a task-only project in headless mode", async () => {
		mockHasProjectTaskResources = true;
		mockHasCoreProjectResources = false;
		mockSavedProjectTrust = null;
		lastDiscoveryProjectTrusted = undefined;
		try {
			const { eventHandlers } = createExtensionHarness();
			const ctx = {
				cwd: process.cwd(),
				hasUI: false,
				isProjectTrusted: () => true,
				ui: {
					confirm: async () => true,
					notify: () => {},
					setStatus: () => {},
					setWidget: () => {},
				},
				model: { provider: "test", id: "model" },
				sessionManager: {
					getSessionFile: () => undefined,
					getSessionId: () => "trust-session",
					getBranch: () => [],
				},
			};

			await eventHandlers.session_start?.({ reason: "startup" }, ctx);
			await eventHandlers.before_agent_start?.({ systemPrompt: "base" }, ctx);

			expect(lastDiscoveryProjectTrusted as boolean | undefined).toEqual(false);
		} finally {
			mockHasProjectTaskResources = false;
			mockHasCoreProjectResources = false;
			mockSavedProjectTrust = null;
		}
	});

	it("does not discover project resources when ExtensionContext reports the project as untrusted", async () => {
		mockHasProjectTaskResources = true;
		mockSavedProjectTrust = true;
		lastDiscoveryProjectTrusted = undefined;
		try {
			const { eventHandlers } = createExtensionHarness();
			const ctx = {
				cwd: process.cwd(),
				hasUI: false,
				isProjectTrusted: () => false,
				ui: {
					confirm: async () => true,
					notify: () => {},
					setStatus: () => {},
					setWidget: () => {},
				},
				model: { provider: "test", id: "model" },
				sessionManager: {
					getSessionFile: () => undefined,
					getSessionId: () => "extension-context-untrusted-session",
					getBranch: () => [],
				},
			};

			await eventHandlers.session_start?.({ reason: "startup" }, ctx);
			await eventHandlers.before_agent_start?.({ systemPrompt: "base" }, ctx);

			expect(lastDiscoveryProjectTrusted as boolean | undefined).toBe(false);
		} finally {
			mockHasProjectTaskResources = false;
			mockSavedProjectTrust = null;
		}
	});

	it("discovers project resources when ExtensionContext and task trust agree", async () => {
		mockHasProjectTaskResources = true;
		mockSavedProjectTrust = true;
		lastDiscoveryProjectTrusted = undefined;
		try {
			const { eventHandlers } = createExtensionHarness();
			const ctx = {
				cwd: process.cwd(),
				hasUI: false,
				isProjectTrusted: () => true,
				ui: {
					confirm: async () => true,
					notify: () => {},
					setStatus: () => {},
					setWidget: () => {},
				},
				model: { provider: "test", id: "model" },
				sessionManager: {
					getSessionFile: () => undefined,
					getSessionId: () => "extension-context-trusted-session",
					getBranch: () => [],
				},
			};

			await eventHandlers.session_start?.({ reason: "startup" }, ctx);
			await eventHandlers.before_agent_start?.({ systemPrompt: "base" }, ctx);

			expect(lastDiscoveryProjectTrusted as boolean | undefined).toBe(true);
		} finally {
			mockHasProjectTaskResources = false;
			mockSavedProjectTrust = null;
		}
	});

	it("does not carry approval across project or session changes", async () => {
		const projectA = await fs.mkdtemp(path.join(os.tmpdir(), "pi-task-project-a-"));
		const projectB = await fs.mkdtemp(path.join(os.tmpdir(), "pi-task-project-b-"));
		mockHasProjectTaskResources = true;
		mockHasCoreProjectResources = false;
		mockSavedProjectTrust = null;
		mockSavedProjectTrustByCwd.clear();
		lastDiscoveryProjectTrusted = undefined;
		try {
			const { eventHandlers, tool } = createExtensionHarness();
			const createContext = (cwd: string, sessionId: string, hasUI: boolean, confirm: () => Promise<boolean>) => ({
				cwd,
				hasUI,
				isProjectTrusted: () => true,
				ui: { confirm, notify: () => {}, setStatus: () => {}, setWidget: () => {} },
				model: { provider: "test", id: "model" },
				modelRegistry: { find: () => undefined },
				sessionManager: {
					getSessionFile: () => undefined,
					getSessionId: () => sessionId,
					getBranch: () => [],
				},
			});
			const contextA = createContext(projectA, "session-a", true, async () => true);
			await eventHandlers.session_start?.({ reason: "startup" }, contextA);
			await eventHandlers.before_agent_start?.({ systemPrompt: "base" }, contextA);
			expect(lastDiscoveryProjectTrusted as boolean | undefined).toBe(true);

			const contextB = createContext(projectB, "session-b", false, async () => false);
			await eventHandlers.session_start?.({ reason: "switch" }, contextB);
			await eventHandlers.before_agent_start?.({ systemPrompt: "base" }, contextB);
			expect(lastDiscoveryProjectTrusted as boolean | undefined).toBe(false);

			mockResources = createResources({
				projectTasksConfig: { source: "project", filePath: path.join(projectB, ".pi", "tasks.json"), persist: false },
			});
			await expect(tool.execute(
				"tool-b",
				{ steps: [{ task: "Do work", prompt: "Worker prompt" }], agentScope: "both" },
				new AbortController().signal,
				() => {},
				contextB,
			)).rejects.toThrow("Project task resources require a trusted project");
		} finally {
			mockHasProjectTaskResources = false;
			mockSavedProjectTrust = null;
			mockSavedProjectTrustByCwd.clear();
			mockResources = undefined;
			await fs.rm(projectA, { recursive: true, force: true });
			await fs.rm(projectB, { recursive: true, force: true });
		}
	});

	it("fails closed when task resources appear after trust resolution", async () => {
		mockHasProjectTaskResources = false;
		mockHasCoreProjectResources = false;
		lastDiscoveryProjectTrusted = undefined;
		const { eventHandlers } = createExtensionHarness();
		const ctx = {
			cwd: process.cwd(),
			hasUI: false,
			isProjectTrusted: () => true,
			ui: {
				confirm: async () => true,
				notify: () => {},
				setStatus: () => {},
				setWidget: () => {},
			},
			model: { provider: "test", id: "model" },
			sessionManager: {
				getSessionFile: () => undefined,
				getSessionId: () => "dynamic-trust-session",
				getBranch: () => [],
			},
		};

		await eventHandlers.session_start?.({ reason: "startup" }, ctx);
		mockHasProjectTaskResources = true;
		try {
			await eventHandlers.before_agent_start?.({ systemPrompt: "base" }, ctx);
			expect(lastDiscoveryProjectTrusted as boolean | undefined).toEqual(false);
		} finally {
			mockHasProjectTaskResources = false;
		}
	});

	it("defers to Pi when no task-specific project resources exist", async () => {
		const { eventHandlers } = createExtensionHarness();
		const result = await eventHandlers.project_trust?.(
			{ cwd: process.cwd() },
			{ hasUI: false, ui: { confirm: async () => false } },
		);

		expect(result).toEqual({ trusted: "undecided" });
	});
});

describe("tasks extension compact schema", () => {
	it("publishes mode + steps parameters instead of duplicated mode arrays", () => {
		const tool = createTaskTool();

		expect(tool.parameters.properties.mode).toBeTruthy();
		expect(tool.parameters.properties.steps).toBeTruthy();
		expect(tool.parameters.properties.task).toBeUndefined();
		expect(tool.parameters.properties.tasks).toBeUndefined();
		expect(tool.parameters.properties.chain).toBeUndefined();
	});

	it("normalizes legacy task shapes before validation", () => {
		const tool = createTaskTool();

		expect(tool.prepareArguments({ agent: "reviewer", task: "Review", cwd: "/tmp" })).toMatchObject({
			mode: "single",
			steps: [{ agent: "reviewer", task: "Review", cwd: "/tmp" }],
		});
		expect(tool.prepareArguments({ tasks: [{ agent: "a", task: "A" }] })).toMatchObject({
			mode: "parallel",
			steps: [{ agent: "a", task: "A" }],
		});
		expect(tool.prepareArguments({ chain: [{ agent: "a", task: "Use {previous}" }] })).toMatchObject({
			mode: "chain",
			steps: [{ agent: "a", task: "Use {previous}" }],
		});
	});

	it("rejects invalid compact modes", async () => {
		const tool = createTaskTool();

		const result = await tool.execute(
			"tc-invalid-mode",
			{ mode: "fanout", steps: [{ task: "Work", prompt: "Worker" }] },
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

		expect(result.content[0].text).toContain('optional `mode` ("single", "parallel", or "chain")');
	});

	it("requires an explicit mode for multiple compact steps", async () => {
		const tool = createTaskTool();

		const result = await tool.execute(
			"tc-compact",
			{ steps: [{ task: "First", prompt: "Worker" }, { task: "Second", prompt: "Worker" }] },
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

		expect(result.content[0].text).toContain('Set `mode` to "parallel" or "chain"');
	});

	it("publishes guidance that task steps need worker behavior", () => {
		const tool = createTaskTool();

		expect(tool.promptSnippet).toContain("each step needs `agent` or behavioral `prompt`");
		expect(tool.promptGuidelines.join("\n")).toContain("do not send bare `{ task: ... }` steps");
		expect(tool.parameters.properties.steps.items.properties.agent.description).toContain("Required unless `prompt`");
		expect(tool.parameters.properties.steps.items.properties.prompt.description).toContain("Required for generic workers");
	});

	it("injects exact task agent and effort choices into the system prompt", async () => {
		mockResources = createResources({
			agents: [
				{
					name: "implementer",
					description: "Implementation worker",
					enabled: true,
					availability: "task",
					defaultEffort: "balanced",
					systemPromptMode: "append",
					systemPrompt: "Implement carefully.",
					source: "user",
					filePath: "/tmp/implementer.md",
				},
				{
					name: "orchestrator",
					description: "Main-session worker",
					enabled: true,
					availability: "main",
					systemPromptMode: "append",
					systemPrompt: "Coordinate work.",
					source: "user",
					filePath: "/tmp/orchestrator.md",
				},
			],
			efforts: [
				{
					name: "balanced",
					description: "Balanced effort",
					provider: "openai-codex",
					model: "gpt-5.6-terra",
					source: "user",
					filePath: "/tmp/tasks.json",
				},
				{
					name: "smart",
					description: "High-thinking effort",
					provider: "openai-codex",
					model: "gpt-5.6-sol",
					thinkingLevel: "high",
					source: "user",
					filePath: "/tmp/tasks.json",
				},
			],
		});
		const { eventHandlers } = createExtensionHarness();

		const result = await eventHandlers.before_agent_start?.(
			{ systemPrompt: "Base system prompt." },
			{ cwd: process.cwd() },
		);

		expect(result.systemPrompt).toContain("Task delegation choices for this directory:");
		expect(result.systemPrompt).toContain("`implementer` (default effort: `balanced`)");
		expect(result.systemPrompt).not.toContain("`orchestrator`");
		expect(result.systemPrompt).toContain("`balanced` (openai-codex/gpt-5.6-terra)");
		expect(result.systemPrompt).toContain("`smart` (openai-codex/gpt-5.6-sol, thinking: `high`)");
		expect(result.systemPrompt).toContain("do not use a thinking level such as `high` as an effort");
		expect(result.systemPrompt).toContain('omit `agent` and provide a behavioral `prompt`; do not set `agent: "generic"`');
		expect(result.systemPrompt).toContain("Child workers cannot use `task` unless their selected agent or profile declares `allowDelegation: true`");
	});

	it("rejects bare generic task steps with actionable recovery guidance", async () => {
		mockResources = createResources({
			agents: [
				{
					name: "reviewer",
					description: "Review worker",
					enabled: true,
					availability: "task",
					systemPromptMode: "append",
					systemPrompt: "Review code.",
					source: "user",
					filePath: "/tmp/reviewer.md",
				},
			],
		});
		const tool = createTaskTool();

		try {
			await tool.execute(
				"tc-bare-generic",
				{ steps: [{ task: "Independent read-only code review" }] },
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
			throw new Error("Expected bare generic task step to be rejected");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain("Step 1");
			expect(message).toContain("Generic task steps require worker behavior");
			expect(message).toContain("Use an agent such as `reviewer`");
			expect(message).toContain("Do not send bare `{ task: ... }` steps");
		}
	});
});

describe("tasks worker tool configuration", () => {
	it("resolves excluded tools from agent and profile configs", () => {
		const resources = createResources({
			agents: [
				{
					name: "reviewer",
					description: "Review code",
					enabled: true,
					availability: "task",
					excludeTools: ["bash", "write"],
					allowDelegation: true,
					systemPromptMode: "append",
					systemPrompt: "Review carefully.",
					source: "user",
					filePath: "/tmp/reviewer.md",
				},
			],
		});

		const resolved = __test__.resolveWorkerConfig({ agent: "reviewer", task: "Review" }, resources);

		expect(resolved.error).toBeUndefined();
		expect(resolved.config.excludeTools).toEqual(["bash", "write"]);
		expect(resolved.config.allowDelegation).toBeTrue();
	});

	it("inherits the profile delegation opt-in", () => {
		const resources = createResources({
			profiles: [
				{
					name: "delegating",
					description: "Can delegate",
					enabled: true,
					allowDelegation: true,
					systemPromptMode: "append",
					systemPrompt: "Delegate only when needed.",
					source: "user",
					filePath: "/tmp/delegating.md",
				},
			],
		});

		const resolved = __test__.resolveWorkerConfig({ profile: "delegating", task: "Plan" }, resources);

		expect(resolved.error).toBeUndefined();
		expect(resolved.config.allowDelegation).toBeTrue();
	});

	it("appends exclude-tools flags for child pi processes", () => {
		const args: string[] = [];

		__test__.appendWorkerToolFlags(args, {
			tools: ["read", "edit"],
			excludeTools: ["bash"],
			allowDelegation: true,
		});

		expect(args).toEqual(["--tools", "read,edit", "--exclude-tools", "bash"]);
	});

	it("disables task delegation for child workers by default", () => {
		const args: string[] = [];

		__test__.appendWorkerToolFlags(args, { tools: ["read", "task"] });

		expect(args).toEqual(["--tools", "read,task", "--exclude-tools", "task"]);
	});

	it("approves project-local inputs for child pi processes when project context is requested", () => {
		const args: string[] = [];

		__test__.appendProjectTrustFlags(
			args,
			{
				context: { mode: "fresh", project: true, skills: false },
				inheritProjectContext: false,
			},
			true,
		);

		expect(args).toEqual(["--approve"]);
	});

	it("does not approve project-local inputs when the launch directory is untrusted", () => {
		const args: string[] = [];

		__test__.appendProjectTrustFlags(
			args,
			{
				context: { mode: "fresh", project: true, skills: false },
				inheritProjectContext: true,
			},
			false,
		);

		expect(args).toEqual(["--no-approve"]);
	});

	it("does not approve project-local inputs when project context is not requested", () => {
		const args: string[] = [];

		__test__.appendProjectTrustFlags(
			args,
			{
				context: { mode: "fresh", project: false, skills: false },
				inheritProjectContext: false,
			},
			true,
		);

		expect(args).toEqual([]);
	});

	it("uses resolved context.skills as the canonical launch inheritance decision", () => {
		const inheritedArgs: string[] = [];
		__test__.appendWorkerSkillFlags(
			inheritedArgs,
			{ displayAgentName: "worker", context: { mode: "fork", project: false, skills: true } },
			process.cwd(),
			false,
		);

		const isolatedArgs: string[] = [];
		__test__.appendWorkerSkillFlags(
			isolatedArgs,
			{ displayAgentName: "worker", context: { mode: "fresh", project: false, skills: false } },
			process.cwd(),
			false,
		);

		const explicitEmptyArgs: string[] = [];
		__test__.appendWorkerSkillFlags(
			explicitEmptyArgs,
			{ skills: [], displayAgentName: "worker", context: { mode: "fork", project: false, skills: true } },
			process.cwd(),
			false,
		);

		expect(inheritedArgs).toEqual([]);
		expect(isolatedArgs).toEqual(["--no-skills"]);
		expect(explicitEmptyArgs).toEqual(["--no-skills"]);
	});

	it("clears inherited main worker environment while preserving explicit task worker config", () => {
		const previousAgent = process.env.PI_AGENT_NAME;
		const previousProfile = process.env.PI_PROFILE_NAME;
		process.env.PI_AGENT_NAME = "main-agent";
		process.env.PI_PROFILE_NAME = "main-profile";
		try {
			const genericEnv = __test__.getWorkerProcessEnv({});
			const explicitEnv = __test__.getWorkerProcessEnv({
				agent: { name: "task-agent" },
				profile: { name: "task-profile", permissionsProfile: "task-permissions" },
			});

			expect(genericEnv.PI_AGENT_NAME).toBeUndefined();
			expect(genericEnv.PI_PROFILE_NAME).toBeUndefined();
			expect(explicitEnv.PI_AGENT_NAME).toBe("task-agent");
			expect(explicitEnv.PI_PROFILE_NAME).toBe("task-permissions");
		} finally {
			if (previousAgent === undefined) delete process.env.PI_AGENT_NAME;
			else process.env.PI_AGENT_NAME = previousAgent;
			if (previousProfile === undefined) delete process.env.PI_PROFILE_NAME;
			else process.env.PI_PROFILE_NAME = previousProfile;
		}
	});
});

describe("tasks project resource execution guardrails", () => {
	const sessionManager = { getSessionFile: () => undefined, getBranch: () => [] };

	it("removes obsolete caller-controlled project confirmation fields", () => {
		const prepared = __test__.prepareTaskToolArguments({
			steps: [{ task: "Do work", prompt: "Worker prompt" }],
			confirmProjectAgents: false,
		});

		expect(prepared.confirmProjectAgents).toBeUndefined();
	});

	it("rejects an explicitly selected project profile when untrusted", async () => {
		const resources = createResources({
			profiles: [{
				name: "project-profile",
				description: "project profile",
				enabled: true,
				systemPromptMode: "append",
				systemPrompt: "Project behavior",
				source: "project",
				filePath: "/project/profiles/project-profile.md",
				persist: false,
			}],
		});

		const preflight = await __test__.preflightTaskRun(
			"single",
			[{ task: "Do work", profile: "project-profile" }],
			resources,
			process.cwd(),
			sessionManager,
			false,
		);

		expect(preflight.prepared).toBeUndefined();
		expect(preflight.error).toContain("Project task resources require a trusted project");
	});

	it("rejects project defaults and efforts in headless or otherwise untrusted execution", async () => {
		const resources = createResources({
			efforts: [{ name: "project-effort", model: "model", source: "project", filePath: "/project/tasks.json" }],
			projectTasksConfig: { source: "project", filePath: "/project/tasks.json", persist: false },
		});

		const preflight = await __test__.preflightTaskRun(
			"single",
			[{ task: "Do work", prompt: "Worker prompt", effort: "project-effort" }],
			resources,
			process.cwd(),
			sessionManager,
			false,
		);

		expect(preflight.prepared).toBeUndefined();
		expect(preflight.error).toContain("Project task resources require a trusted project");
	});

	it("allows project profiles and efforts after project trust is established", async () => {
		const resources = createResources({
			profiles: [{
				name: "project-profile",
				description: "project profile",
				enabled: true,
				systemPromptMode: "append",
				systemPrompt: "Project behavior",
				source: "project",
				filePath: "/project/profiles/project-profile.md",
				persist: false,
			}],
			efforts: [{ name: "project-effort", model: "model", source: "project", filePath: "/project/tasks.json" }],
		});

		const preflight = await __test__.preflightTaskRun(
			"single",
			[{ task: "Do work", profile: "project-profile", effort: "project-effort" }],
			resources,
			process.cwd(),
			sessionManager,
			true,
		);

		expect(preflight.error).toBeUndefined();
		expect(preflight.prepared?.steps[0]?.worker.profile?.source).toBe("project");
		expect(preflight.prepared?.steps[0]?.worker.effort?.source).toBe("project");
	});
});

describe("tasks extension persisted-session guardrails", () => {
	beforeEach(() => {
		mockResources = undefined;
	});

	it("rejects runtime persist override in compact steps", () => {
		expect(__test__.hasRuntimePersistOverride({ steps: [{ task: "Do work", persist: false }] })).toBe(true);
	});

	it("rejects runtime persist override in task execution", async () => {
		const tool = createTaskTool();

		await expect(
			tool.execute(
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
			),
		).rejects.toThrow("Runtime persist overrides are not supported");
	});

	it("does not transfer project trust to an overridden launch directory", async () => {
		const launchCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-task-untrusted-cwd-"));
		try {
			const preflight = await __test__.preflightTaskRun(
				"single",
				[{ task: "Do work", prompt: "Worker prompt", cwd: launchCwd }],
				createResources({
					globalTasksConfig: {
						context: { project: true },
						persist: false,
						source: "user",
						filePath: "/tmp/tasks.json",
					},
				}) as any,
				process.cwd(),
				{ getSessionFile: () => undefined, getBranch: () => [] },
				true,
			);

			expect(preflight.error).toBeUndefined();
			expect(preflight.prepared?.steps[0]?.projectTrusted).toBe(false);
		} finally {
			await fs.rm(launchCwd, { recursive: true, force: true });
		}
	});

	it("does not transfer project trust through an explicit cwd alias", async () => {
		const preflight = await __test__.preflightTaskRun(
			"single",
			[{ task: "Do work", prompt: "Worker prompt", cwd: process.cwd() }],
			createResources({
				globalTasksConfig: {
					context: { project: true },
					persist: false,
					source: "user",
					filePath: "/tmp/tasks.json",
				},
			}) as any,
			process.cwd(),
			{ getSessionFile: () => undefined, getBranch: () => [] },
			true,
		);

		expect(preflight.error).toBeUndefined();
		expect(preflight.prepared?.steps[0]?.projectTrusted).toBe(false);
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

	it("forks conversation while resetting inherited main-session composition", async () => {
		const parentSessionId = "persisted-parent-id";
		const parentSessionFile = path.join(testAgentDir, "sessions", "workspace", "parent.jsonl");
		const inheritedComposition = {
			type: "custom",
			id: "main-composition",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: "tasks.main-agent",
			data: { agent: "orchestrator", profile: "full", effort: "high" },
		};
		const parentMessage = {
			type: "message",
			id: "parent-message",
			parentId: inheritedComposition.id,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "retained fork context", timestamp: Date.now() },
		};
		await fs.mkdir(path.dirname(parentSessionFile), { recursive: true });
		await fs.writeFile(
			parentSessionFile,
			`${[
				{
					type: "session",
					version: 3,
					id: parentSessionId,
					timestamp: new Date().toISOString(),
					cwd: process.cwd(),
				},
				inheritedComposition,
				parentMessage,
			].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			"utf-8",
		);

		const preflight = await __test__.preflightTaskRun(
			"single",
			[{ agent: "task-worker", task: "Do work", context: "fork" }],
			createResources({
				agents: [
					{
						name: "task-worker",
						description: "Explicit task worker",
						enabled: true,
						availability: "task",
						systemPromptMode: "append",
						systemPrompt: "TASK WORKER PROMPT",
						source: "user",
						filePath: "/tmp/task-worker.md",
					},
				],
			}) as any,
			process.cwd(),
			{
				getSessionFile: () => parentSessionFile,
				getSessionId: () => parentSessionId,
				getBranch: () => [parentMessage] as any,
			},
		);

		expect(preflight.error).toBeUndefined();
		expect(preflight.prepared?.steps[0]?.session.parentSessionId).toBe(parentSessionId);
		expect(preflight.prepared?.steps[0]?.worker.agent?.name).toBe("task-worker");
		expect(preflight.prepared?.steps[0]?.worker.systemPrompt).toBe("TASK WORKER PROMPT");
		const childSessionFile = preflight.prepared?.steps[0]?.session.sessionFile;
		expect(childSessionFile).toBeTruthy();
		const childRaw = await fs.readFile(childSessionFile!, "utf-8");
		const childEntries = childRaw.trim().split("\n").map((line) => JSON.parse(line));
		expect(childEntries[0]).toMatchObject({ type: "session", parentSession: parentSessionFile });
		expect(childEntries).toContainEqual(inheritedComposition);
		expect(childEntries).toContainEqual(parentMessage);
		const childComposition = __test__.getPersistedMainAgentState(childEntries);
		expect(childComposition.found).toBe(true);
		expect(childComposition.agent).toBeUndefined();
		expect(childComposition.profile).toBeUndefined();
		expect(childComposition.effort).toBeUndefined();
	});

	it("reads parentSessionId from the persisted header when runtime identity is unavailable", async () => {
		const parentSessionId = "parent-id-from-file";
		const parentSessionFile = path.join(testAgentDir, "sessions", "workspace", "header-only-parent.jsonl");
		await fs.mkdir(path.dirname(parentSessionFile), { recursive: true });
		await fs.writeFile(
			parentSessionFile,
			JSON.stringify({ type: "session", version: 3, id: parentSessionId, timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\n",
			"utf-8",
		);

		const preflight = await __test__.preflightTaskRun(
			"single",
			[{ task: "Do work", prompt: "Worker prompt", context: "fresh" }],
			createResources() as any,
			process.cwd(),
			{
				getSessionFile: () => parentSessionFile,
				getBranch: () => [],
			},
		);

		expect(preflight.error).toBeUndefined();
		expect(preflight.prepared?.steps[0]?.session.parentSessionId).toBe(parentSessionId);
	});

	it("stores persisted child sessions as normal Pi sessions with parentSession headers", async () => {
		const parentSessionId = "parent-session-id";
		const parentSessionFile = path.join(testAgentDir, "sessions", "workspace", "main", "parent-session.jsonl");
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
		const childSessionFile = preflight.prepared?.steps[0]?.session.sessionFile;
		expect(childSessionFile).toBeTruthy();
		expect(childSessionFile).toContain(`${path.sep}sessions${path.sep}`);

		const raw = await fs.readFile(childSessionFile!, "utf-8");
		const entries = raw.trim().split("\n").map((line) => JSON.parse(line));
		expect(entries[0]).toMatchObject({
			type: "session",
			id: preflight.prepared?.steps[0]?.session.sessionId,
			parentSession: parentSessionFile,
		});
		expect(entries[1]).toMatchObject({
			type: "session_info",
			name: preflight.prepared?.steps[0]?.session.sessionName,
		});
		expect(entries).toHaveLength(2);
	});

	it("resolves parent session from child session headers", async () => {
		const parentSessionFile = path.join(testAgentDir, "sessions", "workspace", "main", "parent.jsonl");
		const childSessionFile = path.join(testAgentDir, "sessions", "workspace", "child", "task-child.jsonl");
		await fs.mkdir(path.dirname(childSessionFile), { recursive: true });
		await fs.writeFile(
			childSessionFile,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "child-session-id",
					timestamp: new Date().toISOString(),
					cwd: process.cwd(),
					parentSession: parentSessionFile,
				}),
				JSON.stringify({
					type: "session_info",
					id: "info-1",
					parentId: null,
					timestamp: new Date().toISOString(),
					name: "task: child",
				}),
			].join("\n") + "\n",
			"utf-8",
		);

		const resolved = await __test__.resolveParentSessionForCurrentSession(childSessionFile, [
			{ type: "session", id: "child-session-id", parentSession: parentSessionFile } as any,
		]);

		expect(resolved.error).toBeUndefined();
		expect(resolved.resolved).toMatchObject({
			parentSessionPath: parentSessionFile,
			source: "header",
		});
	});

	it("falls back to the session file when the in-memory branch omits the session header", async () => {
		const parentSessionFile = path.join(testAgentDir, "sessions", "workspace", "main", "parent-from-file.jsonl");
		const childSessionFile = path.join(testAgentDir, "sessions", "workspace", "child", "task-child-from-file.jsonl");
		await fs.mkdir(path.dirname(childSessionFile), { recursive: true });
		await fs.writeFile(
			childSessionFile,
			JSON.stringify({
				type: "session",
				version: 3,
				id: "child-session-id",
				timestamp: new Date().toISOString(),
				cwd: process.cwd(),
				parentSession: parentSessionFile,
			}) + "\n",
			"utf-8",
		);

		const resolved = await __test__.resolveParentSessionForCurrentSession(childSessionFile, []);

		expect(resolved.error).toBeUndefined();
		expect(resolved.resolved).toMatchObject({
			parentSessionPath: parentSessionFile,
			source: "header",
		});
	});

	it("does not resolve a parent session without a parentSession header", async () => {
		const currentSessionFile = path.join(testAgentDir, "sessions", "workspace", "child", "task-child-without-parent.jsonl");
		await fs.mkdir(path.dirname(currentSessionFile), { recursive: true });
		await fs.writeFile(
			currentSessionFile,
			JSON.stringify({ type: "session", id: "child-session-id", timestamp: new Date().toISOString() }) + "\n",
			"utf-8",
		);

		const resolved = await __test__.resolveParentSessionForCurrentSession(currentSessionFile, [
			{ type: "session", id: "child-session-id" } as any,
		]);

		expect(resolved.resolved).toBeUndefined();
		expect(resolved.noParent).toBe(true);
		expect(resolved.error).toContain("has no parentSession header");
	});
});

describe("effort resolution", () => {
	beforeEach(() => {
		mockResources = undefined;
	});

	it("uses provider to qualify bare effort models", () => {
		const resolved = __test__.resolveModelFromEffort(undefined, "smart", createResources({
			efforts: [{
				name: "smart",
				description: "smart effort",
				provider: "github-copilot",
				model: "gpt-5.4",
				thinkingLevel: "high",
				source: "user",
				filePath: "/tmp/tasks.json",
			}],
		}) as any);

		expect(resolved.error).toBeUndefined();
		expect(resolved.model).toBe("github-copilot/gpt-5.4");
		expect(resolved.effort?.name).toBe("smart");
	});

	it("rejects mismatched provider and fully qualified effort model", () => {
		const resolved = __test__.resolveModelFromEffort(undefined, "smart", createResources({
			efforts: [{
				name: "smart",
				description: "smart effort",
				provider: "openrouter",
				model: "github-copilot/gpt-5.4",
				thinkingLevel: "high",
				source: "user",
				filePath: "/tmp/tasks.json",
			}],
		}) as any);

		expect(resolved.model).toBeUndefined();
		expect(resolved.error).toContain('provider "openrouter"');
	});
});

describe("main-session effort command", () => {
	beforeEach(() => {
		mockResources = undefined;
	});

	it("applies effort thinking level when switching the main session", async () => {
		mockResources = createResources({
			efforts: [{
				name: "smart",
				description: "smart effort",
				provider: "github-copilot",
				model: "gpt-5.4",
				thinkingLevel: "high",
				source: "user",
				filePath: "/tmp/tasks.json",
			}],
		});
		const { commandHandlers, pi } = createExtensionHarness();
		const thinkingLevels: string[] = [];
		const models: Array<{ provider: string; id: string }> = [];
		(pi as any).setThinkingLevel = (level: string) => {
			thinkingLevels.push(level);
		};
		(pi as any).setModel = async (model: { provider: string; id: string }) => {
			models.push(model);
			return true;
		};

		const ctx = {
			cwd: process.cwd(),
			hasUI: true,
			waitForIdle: async () => {},
			ui: {
				confirm: async () => true,
				notify: () => {},
			},
			model: { provider: "github-copilot", id: "gpt-5-mini" },
			modelRegistry: {
				find: (provider: string, modelId: string) => ({ provider, id: modelId }),
			},
			sessionManager: {
				getSessionId: () => "session-effort",
				getBranch: () => [],
				appendCustomEntry: () => "entry-id",
			},
		};

		await commandHandlers.effort.handler("smart", ctx);

		expect(models).toEqual([{ provider: "github-copilot", id: "gpt-5.4" }]);
		expect(thinkingLevels).toContain("high");
	});

	it("resets thinking to the session baseline when the selected effort has no thinking level", async () => {
		mockResources = createResources({
			efforts: [
				{
					name: "smart",
					provider: "github-copilot",
					model: "gpt-5.4",
					thinkingLevel: "high",
					source: "user",
					filePath: "/tmp/tasks.json",
				},
				{
					name: "plain",
					provider: "github-copilot",
					model: "gpt-5.4-mini",
					source: "user",
					filePath: "/tmp/tasks.json",
				},
			],
		});
		const { commandHandlers, pi } = createExtensionHarness();
		const thinkingLevels: string[] = [];
		(pi as any).getThinkingLevel = () => "medium";
		(pi as any).setThinkingLevel = (level: string) => {
			thinkingLevels.push(level);
		};

		const ctx = {
			cwd: process.cwd(),
			hasUI: true,
			waitForIdle: async () => {},
			ui: { confirm: async () => true, notify: () => {} },
			model: { provider: "github-copilot", id: "gpt-5-mini" },
			modelRegistry: {
				find: (provider: string, modelId: string) => ({ provider, id: modelId }),
			},
			sessionManager: {
				getSessionId: () => "session-effort-baseline",
				getBranch: () => [],
				appendCustomEntry: () => "entry-id",
			},
		};

		await commandHandlers.effort.handler("smart", ctx);
		await commandHandlers.effort.handler("plain", ctx);

		expect(thinkingLevels).toEqual(["high", "medium"]);
	});
});

describe("main-session composition recovery", () => {
	beforeEach(() => {
		mockResources = createResources({
			agents: [
				{
					name: "role-a",
					description: "Role A",
					enabled: true,
					availability: "main",
					systemPromptMode: "append",
					systemPrompt: "ROLE A PROMPT",
					source: "user",
					filePath: "/tmp/role-a.md",
				},
				{
					name: "role-b",
					description: "Role B",
					enabled: true,
					availability: "main",
					systemPromptMode: "append",
					systemPrompt: "ROLE B PROMPT",
					source: "user",
					filePath: "/tmp/role-b.md",
				},
			],
			profiles: [
				{
					name: "safe-profile",
					description: "Safe profile",
					enabled: true,
					systemPromptMode: "append",
					systemPrompt: "SAFE PROFILE PROMPT",
					source: "user",
					filePath: "/tmp/safe-profile.md",
				},
			],
			efforts: [
				{
					name: "safe-effort",
					provider: "test",
					model: "safe-model",
					source: "user",
					filePath: "/tmp/tasks.json",
				},
			],
		});
	});

	function mainCompositionEntry(data: Record<string, unknown>): any {
		return { type: "custom", customType: "tasks.main-agent", data };
	}

	function createMainContext(sessionId: string, getBranch: () => any[]) {
		return {
			cwd: process.cwd(),
			hasUI: true,
			waitForIdle: async () => {},
			ui: {
				confirm: async () => true,
				notify: () => {},
				setStatus: () => {},
				setWidget: () => {},
			},
			model: { provider: "test", id: "baseline-model" },
			modelRegistry: {
				find: (provider: string, modelId: string) => ({ provider, id: modelId }),
			},
			sessionManager: {
				getSessionId: () => sessionId,
				getSessionFile: () => undefined,
				getBranch,
				appendCustomEntry: () => "entry-id",
			},
		};
	}

	it("reapplies the branch-local composition after session tree navigation", async () => {
		const { eventHandlers } = createExtensionHarness();
		let branch = [mainCompositionEntry({ agent: "role-a", profile: null, effort: null })];
		const ctx = createMainContext("session-tree-composition", () => branch);

		await eventHandlers.session_start?.({ reason: "startup" }, ctx);
		const beforeTree = await eventHandlers.before_agent_start?.({ systemPrompt: "BASE" }, ctx);
		branch = [mainCompositionEntry({ agent: "role-b", profile: null, effort: null })];
		await eventHandlers.session_tree?.({ newLeafId: "role-b" }, ctx);
		const afterTree = await eventHandlers.before_agent_start?.({ systemPrompt: "BASE" }, ctx);

		expect(beforeTree.systemPrompt).toContain("ROLE A PROMPT");
		expect(afterTree.systemPrompt).toContain("ROLE B PROMPT");
		expect(afterTree.systemPrompt).not.toContain("ROLE A PROMPT");
	});

	for (const recovery of [
		{ command: "agent", invalid: { agent: "missing-agent" }, valid: "role-a" },
		{ command: "profile", invalid: { profile: "missing-profile" }, valid: "safe-profile" },
		{ command: "effort", invalid: { effort: "missing-effort" }, valid: "safe-effort" },
	] as const) {
		it(`clears the startup composition error after successful /${recovery.command} recovery`, async () => {
			const { commandHandlers, eventHandlers } = createExtensionHarness();
			const branch = [mainCompositionEntry(recovery.invalid)];
			const ctx = createMainContext(`session-recovery-${recovery.command}`, () => branch);

			await eventHandlers.session_start?.({ reason: "startup" }, ctx);
			const blocked = await eventHandlers.before_agent_start?.({ systemPrompt: "BASE" }, ctx);
			expect(blocked.systemPrompt).toContain("Startup composition error.");

			await commandHandlers[recovery.command].handler(recovery.valid, ctx);
			const recovered = await eventHandlers.before_agent_start?.({ systemPrompt: "BASE" }, ctx);
			expect(recovered.systemPrompt).not.toContain("Startup composition error.");
			expect(recovered.systemPrompt).toContain("Task delegation choices");
		});
	}
});

describe("tasks extension RPC UI relay", () => {
	it("relays dialog requests to the parent UI and returns the selected value", async () => {
		const selectCalls: Array<{ title: string; options: string[]; dialogOptions?: { timeout?: number; signal?: AbortSignal } }> = [];
		const responses: Record<string, unknown>[] = [];

		await __test__.relayTaskExtensionUiRequest({
			request: {
				type: "extension_ui_request",
				id: "req-select",
				method: "select",
				title: "Permission required",
				options: ["Allow once", "Block"],
				timeout: 5000,
			},
			controller: { agent: "thinker", step: 1, key: "run-1:1" },
			parentUi: {
				hasUI: true,
				ui: {
					select: async (title: string, options: string[], dialogOptions?: { timeout?: number; signal?: AbortSignal }) => {
						selectCalls.push({ title, options, dialogOptions });
						return "Allow once";
					},
				},
			},
			sendResponse: async (payload: Record<string, unknown>) => {
				responses.push(payload);
			},
		});

		expect(selectCalls).toHaveLength(1);
		expect(selectCalls[0]?.title).toBe("Task thinker step 1 · Permission required");
		expect(selectCalls[0]?.options).toEqual(["Allow once", "Block"]);
		expect(selectCalls[0]?.dialogOptions?.timeout).toBe(5000);
		expect(responses).toEqual([{ type: "extension_ui_response", id: "req-select", value: "Allow once" }]);
	});

	it("serializes dialog relays from parallel child tasks", async () => {
		const confirmCalls: string[] = [];
		const responses: Record<string, unknown>[] = [];
		let releaseFirstConfirm: (() => void) | undefined;
		let firstConfirmStarted: (() => void) | undefined;
		const firstConfirmStartedPromise = new Promise<void>((resolve) => {
			firstConfirmStarted = resolve;
		});

		const parentUi = {
			hasUI: true,
			ui: {
				confirm: async (title: string) => {
					confirmCalls.push(title);
					if (title.includes("step 1")) {
						firstConfirmStarted?.();
						await new Promise<void>((resolve) => {
							releaseFirstConfirm = resolve;
						});
					}
					return true;
				},
			},
		};

		const firstRelay = __test__.relayTaskExtensionUiRequest({
			request: { type: "extension_ui_request", id: "req-confirm-1", method: "confirm", title: "Permission required" },
			controller: { agent: "thinker", step: 1, key: "run-dialog:1" },
			parentUi,
			sendResponse: async (payload: Record<string, unknown>) => {
				responses.push(payload);
			},
		});
		const secondRelay = __test__.relayTaskExtensionUiRequest({
			request: { type: "extension_ui_request", id: "req-confirm-2", method: "confirm", title: "Permission required" },
			controller: { agent: "thinker", step: 2, key: "run-dialog:2" },
			parentUi,
			sendResponse: async (payload: Record<string, unknown>) => {
				responses.push(payload);
			},
		});

		await firstConfirmStartedPromise;
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(confirmCalls).toHaveLength(1);
		expect(confirmCalls[0]).toContain("step 1");

		releaseFirstConfirm?.();
		await Promise.all([firstRelay, secondRelay]);

		expect(confirmCalls).toHaveLength(2);
		expect(confirmCalls[1]).toContain("step 2");
		expect(responses).toEqual([
			{ type: "extension_ui_response", id: "req-confirm-1", confirmed: true },
			{ type: "extension_ui_response", id: "req-confirm-2", confirmed: true },
		]);
	});

	it("cancels dialog requests when no parent UI is available", async () => {
		const responses: Record<string, unknown>[] = [];

		await __test__.relayTaskExtensionUiRequest({
			request: {
				type: "extension_ui_request",
				id: "req-missing-ui",
				method: "select",
				title: "Permission required",
				options: ["Allow once", "Block"],
			},
			controller: { agent: "thinker", step: 1, key: "run-2:1" },
			sendResponse: async (payload: Record<string, unknown>) => {
				responses.push(payload);
			},
		});

		expect(responses).toEqual([{ type: "extension_ui_response", id: "req-missing-ui", cancelled: true }]);
	});

	it("namespaces status and widget updates from child tasks", async () => {
		const statusCalls: any[][] = [];
		const widgetCalls: any[][] = [];
		const trackedStatusKeys = new Set<string>();
		const trackedWidgetKeys = new Set<string>();

		await __test__.relayTaskExtensionUiRequest({
			request: {
				type: "extension_ui_request",
				id: "req-status",
				method: "setStatus",
				statusKey: "permissions",
				statusText: "Waiting for approval",
			},
			controller: { agent: "thinker", step: 2, key: "run-3:2" },
			parentUi: {
				hasUI: true,
				ui: {
					setStatus: (...args: any[]) => {
						statusCalls.push(args);
					},
					setWidget: (...args: any[]) => {
						widgetCalls.push(args);
					},
				},
			},
			sendResponse: async () => {},
			trackedStatusKeys,
			trackedWidgetKeys,
		});

		await __test__.relayTaskExtensionUiRequest({
			request: {
				type: "extension_ui_request",
				id: "req-widget",
				method: "setWidget",
				widgetKey: "approval",
				widgetLines: ["Choose an option", "Allow once", "Block"],
				widgetPlacement: "belowEditor",
			},
			controller: { agent: "thinker", step: 2, key: "run-3:2" },
			parentUi: {
				hasUI: true,
				ui: {
					setStatus: (...args: any[]) => {
						statusCalls.push(args);
					},
					setWidget: (...args: any[]) => {
						widgetCalls.push(args);
					},
				},
			},
			sendResponse: async () => {},
			trackedStatusKeys,
			trackedWidgetKeys,
		});

		expect(statusCalls).toHaveLength(1);
		expect(statusCalls[0]?.[0]).toContain("tasks.rpc.run-3-2.status.permissions");
		expect(statusCalls[0]?.[1]).toBe("[Task thinker step 2] Waiting for approval");
		expect([...trackedStatusKeys]).toEqual([statusCalls[0]?.[0]]);

		expect(widgetCalls).toHaveLength(1);
		expect(widgetCalls[0]?.[0]).toContain("tasks.rpc.run-3-2.widget.approval");
		expect(widgetCalls[0]?.[1]).toEqual([
			"[Task thinker step 2] Choose an option",
			"Allow once",
			"Block",
		]);
		expect(widgetCalls[0]?.[2]).toEqual({ placement: "belowEditor" });
		expect([...trackedWidgetKeys]).toEqual([widgetCalls[0]?.[0]]);
	});

	it("does not emit out-of-band notifications for child notify requests", async () => {
		const notifyCalls: Array<{ message: string; level?: string }> = [];

		await __test__.relayTaskExtensionUiRequest({
			request: {
				type: "extension_ui_request",
				id: "req-notify",
				method: "notify",
				message: "Bash sandbox active (mode=workspace-write)",
				notifyType: "info",
			},
			controller: { agent: "implementer", step: 1, key: "run-notify:1" },
			parentUi: {
				hasUI: true,
				ui: {
					notify: (message: string, level?: string) => {
						notifyCalls.push({ message, level });
					},
				},
			},
			sendResponse: async () => {},
		});

		expect(notifyCalls).toEqual([]);
	});

	it("formats inline task notices for session-history rendering", () => {
		const result = {
			agent: "implementer",
			agentSource: "user",
			task: "test",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		} as any;

		__test__.addTaskInlineNotice(result, "Bash sandbox active (mode=workspace-write)", "info");
		__test__.addTaskInlineNotice(result, "Parent folder approved for this session:\n/private/tmp/pi-docs", "info");

		expect(__test__.buildTaskInlineNoticeLines(result.uiNotices ?? [])).toEqual([
			"ℹ Parent folder approved for this session:",
			"  /private/tmp/pi-docs",
		]);
	});
});

describe("task result formatting", () => {
	function assistantResult(agent: string, step: number, text: string): any {
		return {
			agent,
			agentSource: "user",
			task: `review step ${step}`,
			exitCode: 0,
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text }],
				},
			],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
			step,
		};
	}

	it("returns full parallel child outputs instead of previews", () => {
		const output = __test__.formatParallelResults([
			assistantResult("gpt-reviewer", 1, "first full review line\nsecond full review line"),
			assistantResult("claude-reviewer", 2, "another full review body with actionable detail"),
		]);

		expect(output).toContain("Parallel: 2/2 succeeded");
		expect(output).toContain("### Step 1 — gpt-reviewer (completed)");
		expect(output).toContain("first full review line\nsecond full review line");
		expect(output).toContain("### Step 2 — claude-reviewer (completed)");
		expect(output).toContain("another full review body with actionable detail");
		expect(output).not.toContain("...");
	});

	it("returns every chain step output, not only the final step", () => {
		const output = __test__.formatChainResults([
			assistantResult("step-one", 1, "first step analysis"),
			assistantResult("step-two", 2, "second step synthesis"),
		]);

		expect(output).toContain("Chain: 2/2 succeeded");
		expect(output).toContain("first step analysis");
		expect(output).toContain("second step synthesis");
	});

	it("joins multiple text parts in the final assistant message", () => {
		const output = __test__.getFinalOutput([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "part one" },
					{ type: "text", text: "part two" },
				],
			},
		] as any);

		expect(output).toBe("part one\npart two");
	});

	it("shows all tool calls but only edit and error tool results", () => {
		const items = __test__.getDisplayItems([
			{
				role: "assistant",
				content: [
					{ type: "toolCall", name: "read", arguments: { path: "README.md" } },
					{ type: "toolCall", name: "grep", arguments: { pattern: "TODO", path: "src" } },
					{ type: "toolCall", name: "bash", arguments: { command: "ls -la" } },
					{ type: "toolCall", name: "edit", arguments: { path: "README.md" } },
				],
			},
			{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "read output" }] },
			{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "bash output" }] },
			{
				role: "toolResult",
				toolName: "write",
				content: [{ type: "text", text: "wrote 900 lines" }],
				details: { diff: "@@ -0,0 +1,900 @@\n+..." },
			},
			{
				role: "toolResult",
				toolName: "grep",
				content: [{ type: "text", text: "grep failed" }],
				isError: true,
			},
			{
				role: "toolResult",
				toolName: "edit",
				content: [{ type: "text", text: "applied" }],
				details: { diff: "@@ -1 +1 @@\n-old\n+new" },
			},
		] as any);

		expect(items.filter((item: any) => item.type === "toolCall").map((item: any) => item.name)).toEqual([
			"read",
			"grep",
			"bash",
			"edit",
		]);
		expect(items.filter((item: any) => item.type === "toolResult").map((item: any) => item.name)).toEqual(["grep", "edit"]);
	});

	it("accepts namespaced edit tool names", () => {
		const items = __test__.getDisplayItems([
			{
				role: "assistant",
				content: [{ type: "toolCall", name: "functions.edit", arguments: { path: "a.ts" } }],
			},
			{
				role: "toolResult",
				toolName: "functions.edit",
				content: [{ type: "text", text: "ok" }],
				details: { diff: "@@ -1 +1 @@\n-a\n+b" },
			},
		] as any);

		expect(items.filter((item: any) => item.type === "toolCall").map((item: any) => item.name)).toEqual(["functions.edit"]);
		expect(items.filter((item: any) => item.type === "toolResult").map((item: any) => item.name)).toEqual(["functions.edit"]);
	});

	it("formats namespaced built-in tool calls compactly", () => {
		const fg = (_color: string, value: string) => value;

		expect(__test__.formatToolCall("functions.read", { path: "README.md" }, fg)).toBe("read: README.md");
		expect(__test__.formatToolCall("functions.grep", { pattern: "TODO", path: "src" }, fg)).toBe("grep: /TODO/ in src");
	});

	it("omits unknown fresh task metadata from headers", () => {
		const theme = {
			fg: (_color: string, value: string) => value,
			bold: (value: string) => value,
		};

		expect(
			__test__.formatTaskHeader(
				{
					agent: "generic",
					taskResult: { agentSource: "unknown", sessionMode: "fresh", profile: "read-only" },
				},
				theme,
			),
		).toBe("generic · profile: read-only");
	});

	it("summarizes task skills in headers", () => {
		const theme = {
			fg: (_color: string, value: string) => value,
			bold: (value: string) => value,
		};

		expect(
			__test__.formatTaskHeader(
				{
					agent: "reviewer",
					taskResult: {
						agentSource: "user",
						sessionMode: "fresh",
						profile: "read-only",
						effort: "balanced",
						skills: ["role-code-review", "standards-code"],
					},
				},
				theme,
			),
		).toBe("reviewer (user) · profile: read-only · effort: balanced · skills: 2");
	});

	it("formats expanded task configuration metadata", () => {
		const fg = (_color: string, value: string) => value;

		expect(
			__test__.formatTaskConfigurationLines(
				{
					agent: "reviewer",
					agentSource: "user",
					profile: "read-only",
					effort: "balanced",
					sessionMode: "fork",
					sessionPersist: true,
					skills: ["role-code-review", "standards-code"],
				},
				fg,
			),
		).toBe(
			[
				"agent: reviewer (user)",
				"profile: read-only",
				"effort: balanced",
				"context: fork",
				"persist: true",
				"skills: role-code-review, standards-code",
			].join("\n"),
		);
	});

	it("filters child runtime setup notices from inline task notices", () => {
		const result: any = { uiNotices: [] };

		expect(__test__.shouldDisplayTaskInlineNotice("Shell parser active: tree-sitter")).toBe(false);
		expect(__test__.shouldDisplayTaskInlineNotice("Bash sandbox active (mode=workspace-write)")).toBe(false);
		expect(__test__.shouldDisplayTaskInlineNotice("Running tests")).toBe(true);

		__test__.addTaskInlineNotice(result, "Shell parser active: tree-sitter\nRunning tests", "info");

		expect(result.uiNotices).toHaveLength(1);
		expect(result.uiNotices[0].lines).toEqual(["Running tests"]);
	});
});

describe("/task command alias", () => {
	it("registers singular /task as an alias for /tasks", () => {
		const { commandHandlers } = createExtensionHarness();

		expect(commandHandlers.task).toBeDefined();
		expect(commandHandlers.task.handler).toBe(commandHandlers.tasks.handler);
	});

	it("routes /task parent through the task-session parent handler", async () => {
		const { commandHandlers } = createExtensionHarness();
		const notifications: Array<{ message: string; level?: string }> = [];
		let waitedForIdle = false;

		await commandHandlers.task.handler("parent", {
			waitForIdle: async () => {
				waitedForIdle = true;
			},
			ui: {
				notify: (message: string, level?: string) => {
					notifications.push({ message, level });
				},
			},
			sessionManager: {
				getSessionFile: () => undefined,
				getBranch: () => [],
			},
		});

		expect(waitedForIdle).toBe(true);
		expect(notifications[0]).toMatchObject({
			level: "error",
			message: expect.stringContaining("Current session is not persisted"),
		});
	});
});

describe("/tasks command parsing", () => {
	it("parses steer commands with selector and message", () => {
		const parsed = __test__.parseTasksCommand("steer task-1 focus only on auth");
		expect(parsed.error).toBeUndefined();
		expect(parsed.action).toBe("steer");
		expect(parsed.selector).toBe("task-1");
		expect(parsed.message).toBe("focus only on auth");
	});

	it("parses attach, origin, and view commands for the current scope", () => {
		const attach = __test__.parseTasksCommand("attach task-1");
		expect(attach.error).toBeUndefined();
		expect(attach.scope).toBe("current");
		expect(attach.action).toBe("attach");
		expect(attach.selector).toBe("task-1");

		const origin = __test__.parseTasksCommand("origin task-1");
		expect(origin.error).toBeUndefined();
		expect(origin.scope).toBe("current");
		expect(origin.action).toBe("origin");
		expect(origin.selector).toBe("task-1");

		const view = __test__.parseTasksCommand("view task-1");
		expect(view.error).toBeUndefined();
		expect(view.scope).toBe("current");
		expect(view.action).toBe("view");
		expect(view.selector).toBe("task-1");
	});

	it("rejects removed recent commands", () => {
		const parsed = __test__.parseTasksCommand("recent attach task-2");
		expect(parsed.scope).toBe("current");
		expect(parsed.action).toBe("list");
		expect(parsed.error).toContain("Unsupported /tasks arguments");
	});

	it("parses toggle commands for the current scope", () => {
		const parsed = __test__.parseTasksCommand("toggle");
		expect(parsed.error).toBeUndefined();
		expect(parsed.scope).toBe("current");
		expect(parsed.action).toBe("toggle");
	});
});

describe("task origin resolution", () => {
	it("captures the nearest user message preview and origin ids", () => {
		const origin = __test__.resolveTaskOriginForBranch(
			[
				{ type: "message", id: "user-1", message: { role: "user", content: "Initial request" } },
				{ type: "message", id: "assistant-1", message: { role: "assistant", content: "Thinking" } },
				{ type: "message", id: "user-2", message: { role: "user", content: "Please continue with the task browser UX" } },
				{ type: "message", id: "assistant-2", message: { role: "assistant", content: "Calling task tool" } },
			] as any,
			"assistant-2",
		);

		expect(origin).toMatchObject({
			originEntryId: "assistant-2",
			originUserEntryId: "user-2",
			originPreview: "Please continue with the task browser UX",
		});
	});
});

describe("task terminal backend configuration", () => {
	it("parses disabled and explicit backend preferences", () => {
		expect(__test__.parseTaskTerminalBackendPreference("disabled")).toEqual({ preference: "disabled" });
		expect(__test__.parseTaskTerminalBackendPreference("wezterm")).toEqual({ preference: "wezterm" });
		expect(__test__.parseTaskTerminalBackendPreference("bogus")).toEqual({ preference: "disabled", unsupported: "bogus" });
	});

	it("normalizes legacy wezterm metadata into generic terminal fields", () => {
		const snapshot = __test__.normalizeChildSessionSnapshot({
			v: 1,
			runId: "run-1",
			toolCallId: "tool-1",
			mode: "single",
			step: 1,
			childSessionId: "child-1",
			childSessionPath: "/tmp/child-1.jsonl",
			effectiveContext: "fresh",
			persist: true,
			taskPreview: "task",
			createdAt: "2024-01-01T00:00:00.000Z",
			status: "succeeded",
			weztermPaneId: "42",
			weztermWorkspace: "pi-tasks",
		});

		expect(snapshot).toMatchObject({
			terminalBackend: "wezterm",
			terminalTargetId: "42",
			terminalWorkspace: "pi-tasks",
			weztermPaneId: "42",
			weztermWorkspace: "pi-tasks",
		});
	});

	it("preserves generic terminal metadata when already present", () => {
		const snapshot = __test__.normalizeChildSessionSnapshot({
			v: 1,
			runId: "run-2",
			toolCallId: "tool-2",
			mode: "single",
			step: 1,
			childSessionId: "child-2",
			childSessionPath: "/tmp/child-2.jsonl",
			effectiveContext: "fresh",
			persist: true,
			taskPreview: "task",
			createdAt: "2024-01-01T00:00:00.000Z",
			status: "succeeded",
			terminalBackend: "wezterm",
			terminalTargetId: "77",
			terminalWorkspace: "pi-tasks-alt",
		});

		expect(snapshot).toMatchObject({
			terminalBackend: "wezterm",
			terminalTargetId: "77",
			terminalWorkspace: "pi-tasks-alt",
			weztermPaneId: "77",
			weztermWorkspace: "pi-tasks-alt",
		});
	});

	it("keeps workspace-only terminal metadata when no pane id is recorded", () => {
		const snapshot = __test__.normalizeChildSessionSnapshot({
			v: 1,
			runId: "run-3",
			toolCallId: "tool-3",
			mode: "single",
			step: 1,
			childSessionId: "child-3",
			childSessionPath: "/tmp/child-3.jsonl",
			effectiveContext: "fresh",
			persist: true,
			taskPreview: "task",
			createdAt: "2024-01-01T00:00:00.000Z",
			status: "succeeded",
			terminalBackend: "wezterm",
			terminalWorkspace: "pi-session-abc",
		});

		expect(snapshot).toMatchObject({
			terminalBackend: "wezterm",
			terminalTargetId: undefined,
			terminalWorkspace: "pi-session-abc",
			weztermPaneId: undefined,
			weztermWorkspace: "pi-session-abc",
		});
	});
});

describe("/tasks list formatting", () => {
	it("includes attach guidance in list output", () => {
		const output = __test__.formatTaskRunList("current", [makeRun("alpha-run", "alpha-child")]);
		expect(output).toContain("/tasks attach <selector>");
		expect(output).toContain("/tasks attach 1");
	});

	it("uses the same run summary lines for the persistent task widget", () => {
		const widgetLines = __test__.buildTaskWidgetLines({
			totalRuns: 2,
			runningRuns: 1,
			runs: [makeRun("alpha-run", "alpha-child", "running")],
		});
		expect(widgetLines[0]).toBe("Task runs in current session (1):");
		expect(widgetLines[1]).toContain("1. running alpha-run");
		expect(widgetLines[2]).toContain("Hidden non-active runs: 1");
		expect(widgetLines[3]).toBe("Use /tasks or Ctrl+Shift+T to interact · /tasks toggle hide");
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

describe("tasks process termination escalation", () => {
	class FakeProcess extends EventEmitter {
		exitCode: number | null = null;
		signalCode: NodeJS.Signals | null = null;
		signals: string[] = [];

		kill(signal: NodeJS.Signals): boolean {
			this.signals.push(signal);
			if (signal === "SIGKILL") this.signalCode = signal;
			return true;
		}
	}

	it("escalates to SIGKILL when the process stays running", async () => {
		const proc = new FakeProcess();
		__test__.terminateProcessWithEscalation(proc as any, { timeoutMs: 10 });
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("does not escalate once close is observed", async () => {
		const proc = new FakeProcess();
		const closure = __test__.terminateProcessWithEscalation(proc as any, { timeoutMs: 20 });
		setTimeout(() => {
			proc.exitCode = 0;
			proc.emit("close", 0);
		}, 5);
		await closure;
		expect(proc.signals).toEqual(["SIGTERM"]);
	});

	it("escalates from TERM to KILL and awaits process close", async () => {
		const proc = new FakeProcess();
		let resolved = false;
		const closure = __test__.terminateProcessWithEscalation(proc as any, { timeoutMs: 5 }).then(() => {
			resolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 15));
		expect(proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(resolved).toBe(false);
		proc.emit("close", null, "SIGKILL");
		await closure;
		expect(resolved).toBe(true);
	});
});

describe("parallel cancellation", () => {
	it("does not start queued work after cancellation", async () => {
		const abortController = new AbortController();
		const started: number[] = [];
		let release: (() => void) | undefined;
		const resultsPromise = __test__.mapWithConcurrencyLimit(
			[0, 1, 2],
			1,
			async (item: number) => {
				started.push(item);
				await new Promise<void>((resolve) => { release = resolve; });
				return item;
			},
			{
				isCancelled: () => abortController.signal.aborted,
				onCancelled: () => -1,
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		abortController.abort();
		release?.();
		expect(await resultsPromise).toEqual([0, -1, -1]);
		expect(started).toEqual([0]);
	});
});

describe("tasks transport helpers", () => {
	it("decodes split UTF-8 stderr and flushes an incomplete final sequence", () => {
		let output = "";
		const decoder = __test__.createUtf8StreamDecoder((text: string) => {
			output += text;
		});
		const bytes = Buffer.from("A€");

		decoder.write(bytes.subarray(0, 2));
		decoder.write(bytes.subarray(2));
		decoder.write(Buffer.from([0xe2, 0x82]));
		decoder.flush();

		expect(output).toBe("A€�");
	});

	it("maps natural nonzero exits and signals", () => {
		expect(
			__test__.mapTransportClose(7, null, {
				aborted: false,
				transportLabel: "Task process",
			}),
		).toEqual({ exitCode: 7 });
		expect(
			__test__.mapTransportClose(null, "SIGKILL", {
				aborted: false,
				transportLabel: "Task process",
			}),
		).toEqual({
			exitCode: 1,
			signalMessage: "Task process terminated by signal SIGKILL",
		});
	});

	it("maps intentional settlement termination and aborts", () => {
		expect(
			__test__.mapTransportClose(null, "SIGTERM", {
				aborted: false,
				intentionalSignal: "SIGTERM",
				transportLabel: "Task RPC process",
			}),
		).toEqual({ exitCode: 0 });
		expect(
			__test__.mapTransportClose(null, "SIGTERM", {
				aborted: true,
				intentionalSignal: "SIGTERM",
				transportLabel: "Task RPC process",
			}),
		).toEqual({ exitCode: 130 });
	});
});

describe("tasks RPC completion coordination", () => {
	function createCompletionHarness(delayMs = 10) {
		const controller = {
			isStreaming: false,
			pendingSteeringCount: 0,
			pendingFollowUpCount: 0,
		};
		let closed = false;
		let terminateCount = 0;
		const coordinator = __test__.createRpcCompletionCoordinator({
			controller,
			isClosed: () => closed,
			terminate: () => {
				terminateCount += 1;
				closed = true;
			},
			delayMs,
		});
		return {
			controller,
			coordinator,
			get terminateCount() {
				return terminateCount;
			},
		};
	}

	it("waits for agent_settled after agent_end", async () => {
		const harness = createCompletionHarness();
		harness.coordinator.onAgentEnd();

		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(harness.terminateCount).toBe(0);

		harness.coordinator.onAgentSettled();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(harness.terminateCount).toBe(1);
	});

	it("resets settlement authorization on every agent_start", async () => {
		const harness = createCompletionHarness();
		harness.coordinator.onAgentStart();
		harness.coordinator.onAgentSettled();
		harness.controller.isStreaming = true;
		harness.coordinator.onAgentStart();
		harness.controller.isStreaming = false;
		harness.coordinator.onQueueUpdate(0, 0);

		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(harness.terminateCount).toBe(0);

		harness.coordinator.onAgentSettled();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(harness.terminateCount).toBe(1);
	});

	it("waits for queued continuation and its settlement", async () => {
		const harness = createCompletionHarness();
		harness.coordinator.onAgentEnd();
		harness.coordinator.onQueueUpdate(0, 1);

		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(harness.terminateCount).toBe(0);

		harness.controller.isStreaming = true;
		harness.coordinator.onAgentStart();
		harness.coordinator.onQueueUpdate(0, 0);
		harness.controller.isStreaming = false;
		harness.coordinator.onAgentEnd();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(harness.terminateCount).toBe(0);

		harness.coordinator.onAgentSettled();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(harness.terminateCount).toBe(1);
	});
});

test("tasks completions list all accepted subcommands", () => {
	expect(__test__.TASKS_COMPLETIONS.map((s: { value: string }) => s.value)).toEqual([
		"list", "show", "view", "open", "attach", "origin", "steer", "parent", "toggle",
	]);
});

test("tasks completions filter by prefix", () => {
	const results = __test__.TASKS_COMPLETIONS.filter((s: { value: string }) => s.value.startsWith("st"));
	expect(results.map((s: { value: string }) => s.value)).toEqual(["steer"]);
});

test("tasks completions return nothing for unrecognised prefix", () => {
	expect(__test__.TASKS_COMPLETIONS.filter((s: { value: string }) => s.value.startsWith("xyz"))).toEqual([]);
});

test("agent completions list clear", () => {
	expect(__test__.AGENT_COMPLETIONS.map((s: { value: string }) => s.value)).toEqual(["clear"]);
});

test("profile completions list clear", () => {
	expect(__test__.PROFILE_COMPLETIONS.map((s: { value: string }) => s.value)).toEqual(["clear"]);
});

test("effort completions list clear", () => {
	expect(__test__.EFFORT_COMPLETIONS.map((s: { value: string }) => s.value)).toEqual(["clear"]);
});
