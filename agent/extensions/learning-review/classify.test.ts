import { describe, expect, test } from "bun:test";
import { classifyCandidate } from "./classify";
import type { LearningCandidate } from "./types";

function candidate(text: string): LearningCandidate {
	return {
		id: "abc123",
		status: "pending",
		kind: "unknown",
		scope: "unknown",
		destination: "undecided",
		text,
		confidence: 0.7,
		reason: "test",
		evidence: [{ quote: text }],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("heuristic learning classifier", () => {
	test("classifies global tool habits", () => {
		const result = classifyCandidate(candidate("Why did you use python << instead of your typescript tool?"));
		expect(result.kind).toBe("tool-habit");
		expect(result.scope).toBe("global-user");
		expect(result.destination).toBe("global-agents");
	});

	test("keeps project-specific extension advice project-scoped", () => {
		const result = classifyCandidate(
			candidate("Dependencies for @agent/extensions/footer should stay in its package.json"),
		);
		expect(result.scope).toBe("project-shared");
		expect(result.destination).toBe("project-agents");
	});

	test("routes procedural learnings toward skills", () => {
		const result = classifyCandidate(
			candidate("When debugging flaky tests, first run the focused test, then verify the full suite."),
		);
		expect(result.destination).toBe("skill");
	});
});
