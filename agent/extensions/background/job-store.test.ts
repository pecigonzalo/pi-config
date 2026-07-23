import { describe, expect, it } from "bun:test";
import {
	BACKGROUND_JOB_ENTRY_TYPE,
	BACKGROUND_JOB_RESOLVED_ENTRY_TYPE,
	formatOutputTail,
	generateJobId,
	reconcilePendingJobs,
	type SessionEntryLike,
} from "./job-store";

function started(id: string, command = "sleep 5", startedAt = 0): SessionEntryLike {
	return { customType: BACKGROUND_JOB_ENTRY_TYPE, data: { id, command, startedAt } };
}

function resolved(
	id: string,
	status: "done" | "error" | "cancelled" | "unknown" = "done",
	resolvedAt = 1,
): SessionEntryLike {
	return { customType: BACKGROUND_JOB_RESOLVED_ENTRY_TYPE, data: { id, resolvedAt, status } };
}

describe("reconcilePendingJobs", () => {
	it("returns nothing for an empty history", () => {
		expect(reconcilePendingJobs([])).toEqual([]);
	});

	it("returns a job that was started but never resolved", () => {
		const entries = [started("a", "sleep 5", 100)];
		expect(reconcilePendingJobs(entries)).toEqual([{ id: "a", command: "sleep 5", startedAt: 100 }]);
	});

	it("excludes a job that has a matching resolved entry", () => {
		const entries = [started("a"), resolved("a")];
		expect(reconcilePendingJobs(entries)).toEqual([]);
	});

	it("is order-independent: a resolved entry preceding its started entry still cancels it out", () => {
		const entries = [resolved("a"), started("a")];
		expect(reconcilePendingJobs(entries)).toEqual([]);
	});

	it("handles a mix of resolved and still-pending jobs", () => {
		const entries = [started("a"), started("b"), resolved("a")];
		expect(reconcilePendingJobs(entries)).toEqual([{ id: "b", command: "sleep 5", startedAt: 0 }]);
	});

	it("ignores unrelated custom entries and malformed data", () => {
		const entries: SessionEntryLike[] = [
			{ customType: "something-else", data: { id: "a" } },
			{ customType: BACKGROUND_JOB_ENTRY_TYPE, data: { id: "a" } }, // missing command/startedAt
			{ customType: BACKGROUND_JOB_ENTRY_TYPE, data: undefined },
		];
		expect(reconcilePendingJobs(entries)).toEqual([]);
	});

	it("dedupes duplicate started entries for the same id, keeping the last one", () => {
		const entries = [started("a", "sleep 1", 0), started("a", "sleep 2", 5)];
		expect(reconcilePendingJobs(entries)).toEqual([{ id: "a", command: "sleep 2", startedAt: 5 }]);
	});
});

describe("generateJobId", () => {
	it("produces distinct hex ids", () => {
		const a = generateJobId();
		const b = generateJobId();
		expect(a).not.toBe(b);
		expect(a).toMatch(/^[0-9a-f]+$/);
	});
});

describe("formatOutputTail", () => {
	it("returns short text unchanged", () => {
		expect(formatOutputTail("hello")).toBe("hello");
	});

	it("keeps only the last N lines", () => {
		const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
		const tail = formatOutputTail(text, 5);
		expect(tail.split("\n")).toEqual(["line 25", "line 26", "line 27", "line 28", "line 29"]);
	});

	it("bounds the total character length", () => {
		const tail = formatOutputTail("x".repeat(10_000), 20, 100);
		expect(tail.length).toBe(100);
	});
});
