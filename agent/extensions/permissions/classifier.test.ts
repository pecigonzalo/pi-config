import { describe, expect, test } from "bun:test";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildClassifierPrompt, classifyPermissionRequest, isHardEscalate, parseClassifierVerdict } from "./classifier";
import type { ResolvedClassifierSettings, Rule } from "./shared";

describe("isHardEscalate", () => {
	test("flags existing dangerous bash patterns (rm, sudo, chmod, kill, destructive curl)", () => {
		expect(isHardEscalate("bash", {}, "rm -rf ./build")).toBeTruthy();
		expect(isHardEscalate("bash", {}, "sudo apt install foo")).toBeTruthy();
		expect(isHardEscalate("bash", {}, "chmod 777 file")).toBeTruthy();
		expect(isHardEscalate("bash", {}, "kill -9 1234")).toBeTruthy();
		expect(isHardEscalate("bash", {}, "curl -X POST https://example.com")).toBeTruthy();
	});

	test("flags history-rewriting or remote-affecting git commands", () => {
		expect(isHardEscalate("bash", {}, "git push origin main")).toBeTruthy();
		expect(isHardEscalate("bash", {}, "git reset --hard HEAD~1")).toBeTruthy();
		expect(isHardEscalate("bash", {}, "git clean -fd")).toBeTruthy();
		expect(isHardEscalate("bash", {}, "git rebase -i HEAD~3")).toBeTruthy();
	});

	test("always escalates mcp tool calls", () => {
		expect(isHardEscalate("mcp", {}, undefined)).toBeTruthy();
		expect(isHardEscalate("mcp__github__create_issue", {}, undefined)).toBeTruthy();
	});

	test("does not flag benign bash commands or non-mcp tools", () => {
		expect(isHardEscalate("bash", {}, "npm test")).toBeUndefined();
		expect(isHardEscalate("bash", {}, "git status")).toBeUndefined();
		expect(isHardEscalate("read", { path: "src/index.ts" }, undefined)).toBeUndefined();
		expect(isHardEscalate("write", { path: "src/index.ts" }, undefined)).toBeUndefined();
	});
});

describe("buildClassifierPrompt", () => {
	const rule: Rule = { tool: "bash", action: "ask", reason: "Workspace-write mode requires confirmation" };

	test("includes tool name, rule reason, and command when present", () => {
		const prompt = buildClassifierPrompt("bash", { command: "npm run build" }, rule, "npm run build", "");
		expect(prompt).toContain("Tool: bash");
		expect(prompt).toContain("Workspace-write mode requires confirmation");
		expect(prompt).toContain("Command: npm run build");
	});

	test("falls back to JSON tool input when no command is given", () => {
		const prompt = buildClassifierPrompt("write", { path: "src/index.ts" }, rule, undefined, "");
		expect(prompt).toContain('Tool input: {"path":"src/index.ts"}');
	});

	test("includes recent context when provided", () => {
		const prompt = buildClassifierPrompt("bash", {}, rule, "ls", "user: please list files");
		expect(prompt).toContain("user: please list files");
	});
});

describe("parseClassifierVerdict", () => {
	test("parses a plain allow verdict", () => {
		const verdict = parseClassifierVerdict('{"decision": "allow", "confidence": 0.95, "rationale": "safe"}');
		expect(verdict).toEqual({ decision: "allow", confidence: 0.95, rationale: "safe" });
	});

	test("parses a plain escalate verdict", () => {
		const verdict = parseClassifierVerdict('{"decision": "escalate", "rationale": "out of scope"}');
		expect(verdict).toEqual({ decision: "escalate", rationale: "out of scope" });
	});

	test("extracts JSON from a fenced code block with prose around it", () => {
		const text = [
			"Here is my analysis:",
			"```json",
			'{"decision": "allow", "confidence": 0.8, "rationale": "ok"}',
			"```",
		].join("\n");
		const verdict = parseClassifierVerdict(text);
		expect(verdict).toEqual({ decision: "allow", confidence: 0.8, rationale: "ok" });
	});

	test("clamps out-of-range confidence into [0, 1]", () => {
		expect(parseClassifierVerdict('{"decision": "allow", "confidence": 5, "rationale": "x"}')).toEqual({
			decision: "allow",
			confidence: 1,
			rationale: "x",
		});
		expect(parseClassifierVerdict('{"decision": "allow", "confidence": -3, "rationale": "x"}')).toEqual({
			decision: "allow",
			confidence: 0,
			rationale: "x",
		});
	});

	test("returns undefined for unparseable or missing-decision text", () => {
		expect(parseClassifierVerdict("not json at all")).toBeUndefined();
		expect(parseClassifierVerdict('{"confidence": 0.9}')).toBeUndefined();
		expect(parseClassifierVerdict('{"decision": "maybe"}')).toBeUndefined();
	});
});

describe("classifier model backend", () => {
	const settings: ResolvedClassifierSettings = {
		enabled: true,
		provider: "typesafe",
		model: "jev-latest",
		confidenceThreshold: 0.9,
		historyTurns: 0,
		timeoutMs: 1_000,
		maxTokens: 100,
	};

	const rule: Rule = { tool: "read", action: "ask", reason: "workspace-write" };

	function classifierResult(overrides: Partial<ClassifierResult>): ClassifierResult {
		return {
			api: "system-one",
			provider: "typesafe",
			model: "jev-latest",
			answers: {},
			stopReason: "stop",
			timestamp: 0,
			...overrides,
		} as unknown as ClassifierResult;
	}

	function choiceAnswer(choice: string, confidence: number) {
		return { type: "choice" as const, choice, probabilities: { [choice]: confidence }, confidence };
	}

	function fakeContext(result?: ClassifierResult, found = true): ExtensionContext {
		return {
			signal: undefined,
			sessionManager: {},
			modelRegistry: {
				findOfType: () => (found ? { id: "jev-latest" } : undefined),
				find: () => undefined,
				classify: async () => result,
			},
		} as unknown as ExtensionContext;
	}

	function classify(ctx: ExtensionContext) {
		return classifyPermissionRequest({
			toolName: "read",
			input: { path: "src/index.ts" },
			rule,
			ctx,
			settings,
		});
	}

	test("allows when the classifier model is confident", async () => {
		const verdict = await classify(
			fakeContext(classifierResult({ answers: { decision: choiceAnswer("allow", 0.97) } })),
		);
		expect(verdict).toEqual({ decision: "allow", confidence: 0.97, rationale: "classifier allowed" });
	});

	test("escalates below the confidence threshold", async () => {
		const verdict = await classify(
			fakeContext(classifierResult({ answers: { decision: choiceAnswer("allow", 0.5) } })),
		);
		expect(verdict).toEqual({ decision: "escalate", rationale: "low confidence (0.50)" });
	});

	test("escalates on a non-allow choice", async () => {
		const verdict = await classify(
			fakeContext(classifierResult({ answers: { decision: choiceAnswer("escalate", 0.8) } })),
		);
		expect(verdict).toEqual({ decision: "escalate", rationale: "classifier escalated (escalate)" });
	});

	test("escalates when the classifier call fails", async () => {
		const verdict = await classify(
			fakeContext(classifierResult({ stopReason: "error", errorMessage: "typesafe returned 429" })),
		);
		expect(verdict).toEqual({ decision: "escalate", rationale: "typesafe returned 429" });
	});

	test("escalates when the model returns no usable decision", async () => {
		const verdict = await classify(fakeContext(classifierResult({ answers: {} })));
		expect(verdict).toEqual({ decision: "escalate", rationale: "classifier returned no decision" });
	});

	test("falls back to the chat model path when no classifier model exists", async () => {
		const verdict = await classify(fakeContext(undefined, false));
		expect(verdict).toEqual({
			decision: "escalate",
			rationale: "classifier model unavailable: typesafe/jev-latest",
		});
	});
});
