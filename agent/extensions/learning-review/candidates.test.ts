import { describe, expect, test } from "bun:test";
import { extractCandidatesFromEntries, extractExplicitCandidateFromEntryId, listUserMessageChoices, looksLikeCorrectionOrAdvice } from "./candidates";

describe("learning candidate extraction", () => {
	test("detects strong corrections", () => {
		expect(looksLikeCorrectionOrAdvice("Why did you use python << instead of typescript?")).toBe(true);
		expect(looksLikeCorrectionOrAdvice("No worries, looks good")).toBe(false);
	});

	test("requires directive words for weak candidates", () => {
		expect(looksLikeCorrectionOrAdvice("I think this is interesting")).toBe(false);
		expect(looksLikeCorrectionOrAdvice("I think we should use the task runner instead")).toBe(true);
	});

	test("extracts user-message candidates with evidence context window", () => {
		const entries = [
			{ type: "message", id: "u1", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "Can you explore the API?" }] } },
			{ type: "message", id: "a", timestamp: "2026-01-01T00:00:30.000Z", message: { role: "assistant", content: [{ type: "text", text: "I used python." }, { type: "toolCall", name: "bash", arguments: { command: "python <<'PY'" } }] } },
			{ type: "message", id: "b", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "Why did you use python << instead of your typescript tool?" }] } },
			{ type: "message", id: "c", timestamp: "2026-01-01T00:02:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "You're right, I should have used typescript." }] } },
		];

		const candidates = extractCandidatesFromEntries(entries, "/tmp/session.jsonl", "/tmp/project", 10);
		expect(candidates).toHaveLength(1);
		const evidence = candidates[0]?.evidence[0];
		expect(evidence?.entryId).toBe("b");
		expect(evidence?.previousUserText).toContain("explore the API");
		expect(evidence?.previousAssistantText).toContain("I used python");
		expect(evidence?.nextAssistantText).toContain("should have used typescript");
		expect(evidence?.toolCalls).toEqual(["bash"]);
		expect(evidence?.contextEntryIds).toEqual(["u1", "a", "b", "c"]);
	});

	test("lists user messages and creates explicit candidates", () => {
		const entries = [
			{ type: "message", id: "u1", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "Please remember this workflow preference." }] } },
			{ type: "message", id: "a1", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "Acknowledged." }] } },
		];

		const choices = listUserMessageChoices(entries);
		expect(choices).toHaveLength(1);
		expect(choices[0]?.id).toBe("u1");
		expect(choices[0]?.label).toContain("Please remember");

		const candidate = extractExplicitCandidateFromEntryId(entries, "u1", "/tmp/session.jsonl", "/tmp/project");
		expect(candidate?.reason).toContain("explicitly selected");
		expect(candidate?.confidence).toBe(0.9);
		expect(candidate?.evidence[0]?.nextAssistantText).toContain("Acknowledged");
	});
});
