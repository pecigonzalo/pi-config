import { randomBytes } from "node:crypto";

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
	exitCode?: number | null;
	outputSummary?: string;
}

export interface SessionEntryLike {
	customType?: string;
	data?: unknown;
}

function isJobStartedData(value: unknown): value is JobStartedData {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		typeof (value as JobStartedData).id === "string" &&
		typeof (value as JobStartedData).command === "string" &&
		typeof (value as JobStartedData).startedAt === "number"
	);
}

function isJobResolvedData(value: unknown): value is JobResolvedData {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		typeof (value as JobResolvedData).id === "string" &&
		typeof (value as JobResolvedData).resolvedAt === "number" &&
		typeof (value as JobResolvedData).status === "string"
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
		if (entry.customType === BACKGROUND_JOB_ENTRY_TYPE && isJobStartedData(entry.data)) {
			started.set(entry.data.id, entry.data);
		} else if (entry.customType === BACKGROUND_JOB_RESOLVED_ENTRY_TYPE && isJobResolvedData(entry.data)) {
			resolvedIds.add(entry.data.id);
		}
	}

	return [...started.values()].filter((job) => !resolvedIds.has(job.id));
}

export function formatOutputTail(text: string, maxLines = 20, maxChars = 4_000): string {
	const lines = text.split("\n");
	let tail = lines.length > maxLines ? lines.slice(-maxLines).join("\n") : text;
	if (tail.length > maxChars) tail = tail.slice(-maxChars);
	return tail;
}
