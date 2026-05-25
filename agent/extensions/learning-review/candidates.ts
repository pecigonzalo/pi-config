import { createHash } from "node:crypto";
import type { LearningCandidate, LearningEvidence } from "./types";

type TextBlock = { type?: string; text?: string };
type ToolCallBlock = { type?: string; name?: string; arguments?: Record<string, unknown> };
type ContentBlock = { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> };
type MessageEntry = {
	type: string;
	id?: string;
	timestamp?: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

const STRONG_CORRECTION_PATTERNS = [
	/\bwhy did you\b/i,
	/\byou overdid\b/i,
	/\btoo aggressive\b/i,
	/\btoo aggresive\b/i,
	/\bdo not\b/i,
	/\bdon't\b/i,
	/\bdont\b/i,
	/\bnever\b/i,
	/\bavoid\b/i,
	/\binstead of\b/i,
	/\brather than\b/i,
	/\bwe forgot\b/i,
	/\byou forgot\b/i,
	/\bwrong\b/i,
	/\bincorrect\b/i,
	/\bi told you\b/i,
	/\bi said\b/i,
	/\bnot what\b/i,
	/\bwithout asking\b/i,
];

const WEAK_CORRECTION_PATTERNS = [
	/^no[,\s]/i,
	/\bi think\b/i,
	/\bmaybe\b/i,
	/\bshould\b/i,
	/\bshouldn't\b/i,
	/\bshould not\b/i,
	/\bcan we\b/i,
	/\bcould we\b/i,
];

const NEGATIVE_PATTERNS = [
	/\bno worries\b/i,
	/\blooks good\b/i,
	/\bactually looks great\b/i,
	/\bnice\b/i,
	/\bexcellent\b/i,
	/\bexcelent\b/i,
];

const DIRECTIVE_WORDS = [
	"use",
	"avoid",
	"prefer",
	"stop",
	"keep",
	"move",
	"add",
	"remove",
	"write",
	"create",
	"clone",
	"delegate",
	"rerun",
	"review",
	"plan",
	"implement",
	"instead",
	"rather",
	"only",
	"don't",
	"do not",
];

export function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: ContentBlock) => {
			if (part?.type === "text" && typeof part.text === "string") return part.text;
			if (part?.type === "toolCall" && typeof part.name === "string") return `Tool ${part.name} was called.`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function extractToolCallNames(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content
		.map((part: ToolCallBlock) => (part?.type === "toolCall" && typeof part.name === "string" ? part.name : undefined))
		.filter((name): name is string => !!name);
}

function hasDirectiveWord(text: string): boolean {
	const lower = text.toLowerCase();
	return DIRECTIVE_WORDS.some((word) => lower.includes(word));
}

export function looksLikeCorrectionOrAdvice(text: string): boolean {
	if (!text.trim()) return false;
	if (NEGATIVE_PATTERNS.some((pattern) => pattern.test(text))) return false;
	if (STRONG_CORRECTION_PATTERNS.some((pattern) => pattern.test(text))) return true;
	if (!WEAK_CORRECTION_PATTERNS.some((pattern) => pattern.test(text))) return false;
	return hasDirectiveWord(text);
}

function stableId(text: string, evidence: LearningEvidence): string {
	return createHash("sha1")
		.update([text, evidence.sessionFile ?? "", evidence.entryId ?? "", evidence.timestamp ?? ""].join("\n"))
		.digest("hex")
		.slice(0, 12);
}

function explicitStableId(text: string, evidence: LearningEvidence): string {
	return createHash("sha1")
		.update(["explicit", text, evidence.sessionFile ?? "", evidence.entryId ?? "", evidence.timestamp ?? ""].join("\n"))
		.digest("hex")
		.slice(0, 12);
}

function summarizeCandidateText(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > 260 ? `${normalized.slice(0, 257)}...` : normalized;
}

function previousMessage(messageEntries: MessageEntry[], index: number, role: string): MessageEntry | undefined {
	return [...messageEntries.slice(0, index)].reverse().find((candidate) => candidate.message?.role === role);
}

function nextMessage(messageEntries: MessageEntry[], index: number, role: string): MessageEntry | undefined {
	return messageEntries.slice(index + 1).find((candidate) => candidate.message?.role === role);
}

function entryText(entry: MessageEntry | undefined): string | undefined {
	if (!entry) return undefined;
	const text = summarizeCandidateText(extractText(entry.message?.content));
	return text || undefined;
}

function candidateFromMessageEntry(
	messageEntries: MessageEntry[],
	index: number,
	sessionFile: string | undefined,
	cwd: string,
	reason: string,
	confidence: number,
	idFactory: (text: string, evidence: LearningEvidence) => string,
): LearningCandidate | undefined {
	const entry = messageEntries[index];
	if (entry.message?.role !== "user") return undefined;

	const text = extractText(entry.message.content);
	const candidateText = summarizeCandidateText(text);
	if (!candidateText) return undefined;

	const previousUser = previousMessage(messageEntries, index, "user");
	const previousAssistant = previousMessage(messageEntries, index, "assistant");
	const nextAssistant = nextMessage(messageEntries, index, "assistant");
	const toolCalls = previousAssistant ? extractToolCallNames(previousAssistant.message?.content) : [];
	const contextEntryIds = [previousUser?.id, previousAssistant?.id, entry.id, nextAssistant?.id].filter((id): id is string => !!id);

	const evidence: LearningEvidence = {
		sessionFile,
		entryId: entry.id,
		timestamp: entry.timestamp,
		cwd,
		quote: candidateText,
		previousUserText: entryText(previousUser),
		previousAssistantText: entryText(previousAssistant),
		nextAssistantText: entryText(nextAssistant),
		toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
		contextEntryIds,
	};

	const now = new Date().toISOString();
	return {
		id: idFactory(candidateText, evidence),
		status: "pending",
		kind: "unknown",
		scope: "unknown",
		destination: "undecided",
		text: candidateText,
		rawText: candidateText,
		confidence,
		reason,
		distillationStatus: "raw",
		evidence: [evidence],
		createdAt: now,
		updatedAt: now,
	};
}

export function extractCandidatesFromEntries(entries: unknown[], sessionFile: string | undefined, cwd: string, maxCandidates: number): LearningCandidate[] {
	const candidates: LearningCandidate[] = [];
	const messageEntries = entries.filter((entry): entry is MessageEntry => !!entry && typeof entry === "object" && (entry as MessageEntry).type === "message");

	for (let index = 0; index < messageEntries.length; index++) {
		const entry = messageEntries[index];
		if (entry.message?.role !== "user") continue;

		const text = extractText(entry.message.content);
		if (!looksLikeCorrectionOrAdvice(text)) continue;

		const candidate = candidateFromMessageEntry(
			messageEntries,
			index,
			sessionFile,
			cwd,
			"User message looks like correction, advice, or a reusable preference.",
			STRONG_CORRECTION_PATTERNS.some((pattern) => pattern.test(text)) ? 0.85 : 0.65,
			stableId,
		);
		if (candidate) candidates.push(candidate);

		if (candidates.length >= maxCandidates) break;
	}

	return candidates;
}

export function listUserMessageChoices(entries: unknown[]): Array<{ id: string; label: string; text: string }> {
	const messageEntries = entries.filter((entry): entry is MessageEntry => !!entry && typeof entry === "object" && (entry as MessageEntry).type === "message");
	return messageEntries
		.filter((entry) => entry.message?.role === "user" && entry.id)
		.map((entry, index) => {
			const text = summarizeCandidateText(extractText(entry.message?.content));
			const label = `${String(index + 1).padStart(2, "0")} · ${entry.timestamp ?? "unknown time"} · ${text}`;
			return { id: entry.id!, label, text };
		})
		.filter((choice) => choice.text.length > 0);
}

export function extractExplicitCandidateFromEntryId(entries: unknown[], entryId: string, sessionFile: string | undefined, cwd: string): LearningCandidate | undefined {
	const messageEntries = entries.filter((entry): entry is MessageEntry => !!entry && typeof entry === "object" && (entry as MessageEntry).type === "message");
	const index = messageEntries.findIndex((entry) => entry.id === entryId && entry.message?.role === "user");
	if (index < 0) return undefined;
	return candidateFromMessageEntry(
		messageEntries,
		index,
		sessionFile,
		cwd,
		"User explicitly selected this message as a learning source.",
		0.9,
		explicitStableId,
	);
}

export function countUserMessages(entries: unknown[]): number {
	return entries.filter((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const candidate = entry as MessageEntry;
		return candidate.type === "message" && candidate.message?.role === "user";
	}).length;
}
