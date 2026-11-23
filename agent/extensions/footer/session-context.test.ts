import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSessionContextController, __test__ } from "./session-context";

type AccountableEntries = Parameters<typeof __test__.getUsageTotals>[0];

interface TestUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function usage(overrides: Partial<TestUsage> = {}): Record<string, unknown> {
	const { cost = 0, ...rest } = overrides;
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		...rest,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function asEntries(entries: unknown[]): AccountableEntries {
	return entries as unknown as AccountableEntries;
}

describe("footer segment suppression", () => {
	const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };

	function makeController(options: { thinking?: string; agentName?: string } = {}) {
		const pi = {
			getFlag: () => options.agentName,
			getThinkingLevel: () => options.thinking ?? "high",
		} as unknown as ExtensionAPI;
		return createSessionContextController(pi);
	}

	function makeContext(options: { tokens?: number; entries?: unknown[]; contextWindow?: number }): ExtensionContext {
		return {
			cwd: "/tmp/workspace",
			ui: { theme },
			model: {
				id: "deepseek-v4.1-flash",
				provider: "opencode-go",
				contextWindow: options.contextWindow ?? 1_000_000,
			},
			getContextUsage: () => ({ tokens: options.tokens ?? 0 }),
			sessionManager: {
				getBranch: () => options.entries ?? [],
				getLeafId: () => 1,
			},
		} as unknown as ExtensionContext;
	}

	it("hides the agent name when it is the default", () => {
		const controller = makeController();
		controller.onSessionStart();

		expect(controller.renderSegment(makeContext({}), "agent")).toBeNull();
	});

	it("shows the agent name when it is not the default", () => {
		delete process.env.PI_AGENT_NAME;
		const controller = makeController({ agentName: "reviewer" });
		controller.onSessionStart();

		expect(controller.renderSegment(makeContext({}), "agent")).toContain("reviewer");
	});

	it("hides the thinking level while it matches the session baseline", () => {
		let level = "high";
		const pi = {
			getFlag: () => undefined,
			getThinkingLevel: () => level,
		} as unknown as ExtensionAPI;
		const controller = createSessionContextController(pi);
		controller.onSessionStart();
		const ctx = makeContext({});

		expect(controller.renderSegment(ctx, "thinking")).toBeNull();

		level = "xhigh";
		controller.onThinkingLevelSelect();
		expect(controller.renderSegment(ctx, "thinking")).not.toBeNull();
	});

	it("renders context as an integer percentage below the warning threshold", () => {
		const controller = makeController();
		controller.onSessionStart();

		const rendered = controller.renderSegment(
			makeContext({ tokens: 188_000, contextWindow: 1_000_000 }),
			"context",
		);

		expect(rendered).toContain("19%");
		expect(rendered).not.toContain("18.8%");
	});

	it("omits cache read and write totals when nothing was cached this session", () => {
		const controller = makeController();
		controller.onSessionStart();
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					usage: {
						input: 1_000,
						output: 500,
						cacheRead: 5_000,
						cacheWrite: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.163 },
					},
				},
			},
		];
		const ctx = makeContext({ entries });

		const tokens = controller.renderSegment(ctx, "tokens");
		expect(tokens).toContain("1.0k");
		expect(tokens).not.toContain("R5.0k");

		expect(controller.renderSegment(ctx, "cost")).toContain("0.16");
	});
});

describe("footer usage accounting", () => {
	it("totals assistant, tool-result, cache-warming, compaction, and branch-summary usage", () => {
		const entries = asEntries([
			{ type: "message", message: { role: "assistant", usage: usage({ input: 100, output: 60, cost: 0.01 }) } },
			{
				type: "message",
				message: { role: "toolResult", usage: usage({ input: 5, output: 2, cost: 0.001 }) },
			},
			{ type: "usage", kind: "cache_warm", provider: "p", model: "m", usage: usage({ input: 200, cost: 0.02 }) },
			{
				type: "compaction",
				summary: "s",
				firstKeptEntryId: "x",
				tokensBefore: 0,
				usage: usage({ input: 50, cost: 0.005 }),
			},
			{ type: "branch_summary", fromId: "y", summary: "z", usage: usage({ output: 8, cost: 0.002 }) },
			{ type: "message", message: { role: "user", content: "hi" } },
			{ type: "custom", customType: "example" },
		]);

		const totals = __test__.getUsageTotals(entries);

		expect(totals.tokIn).toBe(355);
		expect(totals.tokOut).toBe(70);
		expect(totals.cacheRead).toBe(0);
		expect(totals.cacheWrite).toBe(0);
		expect(totals.cost).toBeCloseTo(0.038, 5);
	});

	it("counts cache read and write tokens separately", () => {
		const entries = asEntries([
			{
				type: "message",
				message: { role: "assistant", usage: usage({ input: 10, cacheRead: 40, cacheWrite: 5 }) },
			},
		]);

		const totals = __test__.getUsageTotals(entries);

		expect(totals.tokIn).toBe(10);
		expect(totals.cacheRead).toBe(40);
		expect(totals.cacheWrite).toBe(5);
	});

	it("returns zero totals for entries without usage", () => {
		const entries = asEntries([
			{ type: "message", message: { role: "toolResult" } },
			{ type: "model_change", provider: "p", modelId: "m" },
		]);

		const totals = __test__.getUsageTotals(entries);

		expect(totals).toEqual({ tokIn: 0, tokOut: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
	});
});
