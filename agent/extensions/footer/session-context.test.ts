import { describe, expect, it } from "bun:test";
import { __test__ } from "./session-context";

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
