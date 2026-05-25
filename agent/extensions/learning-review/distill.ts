import { complete } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LearningCandidate, LearningDestination, LearningKind, LearningScope } from "./types";

const KINDS: LearningKind[] = ["correction", "preference", "tool-habit", "workflow", "project-convention", "avoidance", "unknown"];
const SCOPES: LearningScope[] = ["global-user", "project-shared", "project-local", "session-only", "unknown"];
const DESTINATIONS: LearningDestination[] = ["global-agents", "project-agents", "global-memory", "project-memory", "skill", "discard", "undecided"];

type DistilledLearning = {
	id?: string;
	keep: boolean;
	text: string;
	kind: LearningKind;
	scope: LearningScope;
	destination: LearningDestination;
	confidence: number;
	reason: string;
};

export type DistillationBatchResult = {
	candidates: LearningCandidate[];
	failed: Array<{ id: string; error: string }>;
};

function clampConfidence(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(1, value));
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

function findBalancedJsonObject(text: string): string | undefined {
	const start = text.indexOf("{");
	if (start < 0) return undefined;

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') inString = false;
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") depth++;
		if (char === "}") depth--;
		if (depth === 0) return text.slice(start, index + 1);
	}

	return undefined;
}

function tryParseJson(raw: string): unknown | undefined {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function extractJson(text: string): unknown | undefined {
	const fencedBlocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]);
	for (const block of fencedBlocks) {
		const balanced = findBalancedJsonObject(block);
		const parsed = tryParseJson(block.trim()) ?? (balanced ? tryParseJson(balanced) : undefined);
		if (parsed) return parsed;
	}

	const balanced = findBalancedJsonObject(text);
	return balanced ? tryParseJson(balanced) : undefined;
}

function resultObjects(parsed: unknown): Array<Record<string, unknown>> {
	if (!parsed || typeof parsed !== "object") return [];
	if (Array.isArray(parsed)) return parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
	const input = parsed as Record<string, unknown>;
	for (const key of ["results", "candidates", "learnings", "items"]) {
		if (Array.isArray(input[key])) return resultObjects(input[key]);
	}
	if (input.learning && typeof input.learning === "object") return resultObjects(input.learning);
	if (input.distilled && typeof input.distilled === "object") return resultObjects(input.distilled);
	return [input];
}

function stringField(input: Record<string, unknown>, names: string[]): string {
	for (const name of names) {
		const value = input[name];
		if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim();
	}
	return "";
}

function parseObject(input: Record<string, unknown>, fallback: LearningCandidate): DistilledLearning | undefined {
	const rawDestination = enumValue(input.destination, DESTINATIONS, fallback.destination);
	const keep = typeof input.keep === "boolean" ? input.keep : rawDestination !== "discard";
	const destination = keep ? rawDestination : "discard";
	const distilledText = stringField(input, ["text", "learning", "normalizedLearning", "normalized_learning", "rule", "summary"])
		|| (fallback.rawText ?? fallback.text);
	if (!distilledText) return undefined;

	return {
		id: stringField(input, ["id", "candidateId", "candidate_id", "sourceCandidateId", "source_candidate_id"]) || fallback.id,
		keep,
		text: distilledText.length > 400 ? `${distilledText.slice(0, 397)}...` : distilledText,
		kind: enumValue(input.kind, KINDS, fallback.kind),
		scope: enumValue(input.scope, SCOPES, fallback.scope),
		destination,
		confidence: clampConfidence(input.confidence, fallback.confidence),
		reason: stringField(input, ["reason", "rationale", "why"]) || fallback.reason,
	};
}

export function parseDistillationResponse(text: string, fallback: LearningCandidate): DistilledLearning | undefined {
	return parseDistillationBatchResponse(text, [fallback]).get(fallback.id);
}

export function parseDistillationBatchResponse(text: string, fallbacks: LearningCandidate[]): Map<string, DistilledLearning> {
	const parsed = extractJson(text);
	const objects = resultObjects(parsed);
	const fallbackById = new Map(fallbacks.map((candidate) => [candidate.id, candidate]));
	const results = new Map<string, DistilledLearning>();

	for (const [index, object] of objects.entries()) {
		const explicitId = stringField(object, ["id", "candidateId", "candidate_id", "sourceCandidateId", "source_candidate_id"]);
		const fallback = explicitId ? fallbackById.get(explicitId) : fallbacks.length === 1 ? fallbacks[0] : fallbacks[index];
		if (!fallback) continue;
		const result = parseObject(object, fallback);
		if (result) results.set(fallback.id, result);
	}

	return results;
}

function candidateForPrompt(candidate: LearningCandidate) {
	return {
		id: candidate.id,
		rawText: candidate.rawText ?? candidate.text,
		currentText: candidate.text,
		currentHeuristic: {
			kind: candidate.kind,
			scope: candidate.scope,
			destination: candidate.destination,
			confidence: candidate.confidence,
			reason: candidate.reason,
		},
		evidence: candidate.evidence[0] ?? {},
	};
}

function buildBatchDistillationPrompt(candidates: LearningCandidate[]): string {
	return [
		"You distill Pi coding-agent learning candidates.",
		"Given raw correction/advice messages and nearby context, extract durable learnings. Discard non-actionable or one-off items.",
		"Return ONLY JSON with this exact shape:",
		'{ "results": [{ "id": string, "keep": boolean, "text": string, "kind": "correction|preference|tool-habit|workflow|project-convention|avoidance|unknown", "scope": "global-user|project-shared|project-local|session-only|unknown", "destination": "global-agents|project-agents|global-memory|project-memory|skill|discard|undecided", "confidence": number, "reason": string }] }',
		"",
		"Rules:",
		"- Do not copy raw user messages verbatim unless already concise rules.",
		"- Prefer short imperative rules that prevent future mistakes.",
		"- Project-specific facts must not become global memory or global AGENTS rules.",
		"- Use destination=skill for reusable multi-step procedures.",
		"- Use keep=false and destination=discard for one-off task details, vague design questions, or already non-actionable text.",
		"- Keep text under 200 characters when possible.",
		"- Return one result for every candidate id.",
		"",
		"Candidates:",
		JSON.stringify(candidates.map(candidateForPrompt), null, 2),
	].join("\n");
}

function buildRepairPrompt(originalPrompt: string, invalidResponse: string): string {
	return [
		"Your previous response was not valid JSON for the requested schema.",
		"Convert it into ONLY valid JSON with this exact shape:",
		'{ "results": [{ "id": string, "keep": boolean, "text": string, "kind": "correction|preference|tool-habit|workflow|project-convention|avoidance|unknown", "scope": "global-user|project-shared|project-local|session-only|unknown", "destination": "global-agents|project-agents|global-memory|project-memory|skill|discard|undecided", "confidence": number, "reason": string }] }',
		"Do not add markdown, prose, comments, or code fences.",
		"",
		"Original request:",
		originalPrompt,
		"",
		"Invalid response:",
		invalidResponse.slice(0, 6000),
	].join("\n");
}

async function runCompletion(prompt: string, ctx: ExtensionContext): Promise<string> {
	const model = ctx.model;
	if (!model) throw new Error("No active model available for learning distillation");

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error(`No API key for ${model.provider}`);

	const response = await complete(
		model,
		{
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: prompt }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens: 2000,
			reasoningEffort: "low",
			signal: ctx.signal,
		},
	);

	return response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function applyDistillation(candidate: LearningCandidate, distilled: DistilledLearning): LearningCandidate {
	return {
		...candidate,
		text: distilled.text,
		rawText: candidate.rawText ?? candidate.text,
		kind: distilled.kind,
		scope: distilled.scope,
		destination: distilled.destination,
		confidence: distilled.confidence,
		reason: `Distilled: ${distilled.reason}`,
		distillationStatus: "distilled",
		distillationError: undefined,
		updatedAt: new Date().toISOString(),
	};
}

function markFailed(candidate: LearningCandidate, error: string): LearningCandidate {
	return {
		...candidate,
		rawText: candidate.rawText ?? candidate.text,
		distillationStatus: "failed",
		distillationError: error,
		updatedAt: new Date().toISOString(),
	};
}

export async function distillCandidates(candidates: LearningCandidate[], ctx: ExtensionContext): Promise<DistillationBatchResult> {
	if (candidates.length === 0) return { candidates: [], failed: [] };
	const prompt = buildBatchDistillationPrompt(candidates);
	let responseText = await runCompletion(prompt, ctx);
	let parsed = parseDistillationBatchResponse(responseText, candidates);

	if (parsed.size === 0) {
		responseText = await runCompletion(buildRepairPrompt(prompt, responseText), ctx);
		parsed = parseDistillationBatchResponse(responseText, candidates);
	}

	const failed: Array<{ id: string; error: string }> = [];
	const next = candidates.map((candidate) => {
		const distilled = parsed.get(candidate.id);
		if (!distilled) {
			const error = "No valid distillation result returned for candidate";
			failed.push({ id: candidate.id, error });
			return markFailed(candidate, error);
		}
		return applyDistillation(candidate, distilled);
	});

	return { candidates: next, failed };
}

export async function distillCandidate(candidate: LearningCandidate, ctx: ExtensionContext): Promise<LearningCandidate> {
	const result = await distillCandidates([candidate], ctx);
	return result.candidates[0] ?? markFailed(candidate, "No distillation result returned");
}
