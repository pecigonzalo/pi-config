import { describe, expect, test } from "bun:test";
import { parseDistillationBatchResponse, parseDistillationResponse } from "./distill";
import type { LearningCandidate } from "./types";

const fallback: LearningCandidate = {
	id: "abc123",
	status: "pending",
	kind: "unknown",
	scope: "unknown",
	destination: "undecided",
	text: "raw",
	confidence: 0.5,
	reason: "fallback",
	evidence: [{ quote: "raw" }],
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("learning distillation parsing", () => {
	test("parses fenced JSON", () => {
		const result = parseDistillationResponse(
			'```json\n{"text":"Keep the learning extension simple and review-first.","kind":"workflow","scope":"global-user","destination":"global-agents","confidence":0.91,"reason":"User explicitly warned against bloated memory behavior."}\n```',
			fallback,
		);
		expect(result?.text).toBe("Keep the learning extension simple and review-first.");
		expect(result?.destination).toBe("global-agents");
		expect(result?.confidence).toBe(0.91);
	});

	test("parses JSON surrounded by prose", () => {
		const result = parseDistillationResponse(
			'Here is the distilled learning: {"normalizedLearning":"Prefer source-backed learning review over raw memory dumps.","kind":"workflow","scope":"global-user","destination":"global-agents","confidence":0.88,"rationale":"This captures the durable behavior."} Thanks.',
			fallback,
		);
		expect(result?.text).toBe("Prefer source-backed learning review over raw memory dumps.");
		expect(result?.reason).toBe("This captures the durable behavior.");
	});

	test("parses candidate-array response", () => {
		const result = parseDistillationResponse(
			'{"candidates":[{"text":"Use /learn subcommands with spaces, not dash-delimited command names.","kind":"project-convention","scope":"project-shared","destination":"project-agents","confidence":0.9,"reason":"User explicitly corrected command naming."}]}',
			fallback,
		);
		expect(result?.destination).toBe("project-agents");
		expect(result?.kind).toBe("project-convention");
	});

	test("parses batch responses by id", () => {
		const second = { ...fallback, id: "def456", text: "other", evidence: [{ quote: "other" }] };
		const results = parseDistillationBatchResponse(
			'{"results":[{"id":"abc123","keep":true,"text":"Keep learning review simple.","kind":"preference","scope":"global-user","destination":"global-agents","confidence":0.92,"reason":"User asked to avoid bloat."},{"id":"def456","keep":false,"text":"other","kind":"unknown","scope":"session-only","destination":"discard","confidence":0.4,"reason":"One-off."}]}',
			[fallback, second],
		);
		expect(results.get("abc123")?.text).toBe("Keep learning review simple.");
		expect(results.get("def456")?.destination).toBe("discard");
		expect(results.get("def456")?.keep).toBe(false);
	});

	test("returns undefined for invalid output", () => {
		expect(parseDistillationResponse("not json", fallback)).toBeUndefined();
	});
});
