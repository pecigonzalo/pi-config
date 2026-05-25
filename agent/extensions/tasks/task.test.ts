import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
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
		discoverResources: () => mockResources ?? createResources(),
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

describe("tasks extension persisted-session guardrails", () => {
	beforeEach(() => {
		mockResources = undefined;
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

	it("stores persisted child sessions as normal Pi sessions with parentSession headers", async () => {
		const parentSessionId = "parent-session-id";
		const parentSessionFile = path.join(testAgentDir, "sessions", "workspace", "main", "parent-session.jsonl");
		const expectedRunRoot = path.join(
			testAgentDir,
			"sessions",
			"workspace",
			"main",
			"task-runs",
			"parent-session-id--parent-session",
		);

		expect(__test__.resolvePersistedTaskSessionRoot(parentSessionFile, parentSessionId)).toBe(expectedRunRoot);

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
		expect(preflight.prepared?.sessionRunRoot).toStartWith(`${expectedRunRoot}${path.sep}`);
		const childSessionFile = preflight.prepared?.steps[0]?.session.sessionFile;
		expect(childSessionFile).toBeTruthy();
		expect(childSessionFile).not.toStartWith(preflight.prepared?.sessionRunRoot ?? "");
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

	it("does not resolve a parent session without a parentSession header", async () => {
		const currentSessionFile = path.join(testAgentDir, "sessions", "workspace", "child", "task-child.jsonl");
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
			"ℹ Bash sandbox active (mode=workspace-write)",
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
		__test__.terminateProcessWithEscalation(proc as any, { timeoutMs: 20 });
		setTimeout(() => {
			proc.exitCode = 0;
			proc.emit("close", 0);
		}, 5);
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(proc.signals).toEqual(["SIGTERM"]);
	});
});
