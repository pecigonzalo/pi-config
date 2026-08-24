import { randomBytes } from "node:crypto";
import { truncateTail } from "@earendil-works/pi-coding-agent";

export const BACKGROUND_JOB_ENTRY_TYPE = "background-job";
export const BACKGROUND_JOB_RESOLVED_ENTRY_TYPE = "background-job-resolved";

export type JobResolvedStatus = "done" | "error" | "cancelled" | "unknown";

export interface JobStartedData {
	id: string;
	command: string;
	startedAt: number;
}

export interface JobResolvedData {
	id: string;
	resolvedAt: number;
	status: JobResolvedStatus;
	outputSummary?: string;
}

/**
 * Minimal shape reconcilePendingJobs needs from a session entry. `type` is
 * required (unlike `customType`/`data`) so this stays structurally distinct
 * from an all-optional type — that lets callers pass the SDK's SessionEntry[]
 * (which includes non-custom entries with no customType/data) directly.
 */
export interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function isJobStartedData(value: unknown): value is JobStartedData {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.command === "string" &&
		typeof value.startedAt === "number"
	);
}

function isJobResolvedData(value: unknown): value is JobResolvedData {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.resolvedAt === "number" &&
		typeof value.status === "string"
	);
}

export function generateJobId(): string {
	return randomBytes(6).toString("hex");
}

/**
 * Reduces the full session entry history to the set of jobs that were
 * started but never resolved. A job can't be reattached after a process
 * restart, so on session_start these should be immediately marked resolved
 * with status "unknown" rather than treated as still running.
 */
export function reconcilePendingJobs(entries: SessionEntryLike[]): JobStartedData[] {
	const started = new Map<string, JobStartedData>();
	const resolvedIds = new Set<string>();

	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === BACKGROUND_JOB_ENTRY_TYPE && isJobStartedData(entry.data)) {
			started.set(entry.data.id, entry.data);
		} else if (entry.customType === BACKGROUND_JOB_RESOLVED_ENTRY_TYPE && isJobResolvedData(entry.data)) {
			resolvedIds.add(entry.data.id);
		}
	}

	return [...started.values()].filter((job) => !resolvedIds.has(job.id));
}

export function formatOutputTail(text: string, maxLines = 20, maxChars = 4_000): string {
	return truncateTail(text, { maxLines, maxBytes: maxChars }).content;
}
