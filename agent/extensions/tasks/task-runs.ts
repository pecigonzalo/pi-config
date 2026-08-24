import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ContextMode } from "./agents.js";
import { getTaskTerminalAttachment, isTaskTerminalBackendId, type TaskTerminalBackendId } from "./task-terminal.js";

export type TaskExecutionMode = "single" | "parallel" | "chain";
export type ChildSessionStatus = "created" | "succeeded" | "failed" | "aborted";
export type TaskRunStepStatus = ChildSessionStatus | "running" | "interrupted" | "not-persisted";
export type TaskRunStatus = "running" | "interrupted" | "failed" | "aborted" | "succeeded" | "not-persisted";

export interface TaskOriginSnapshot {
	originEntryId?: string;
	originUserEntryId?: string;
	originPreview?: string;
}

export interface ChildSessionSnapshot extends TaskOriginSnapshot {
	v: number;
	runId: string;
	toolCallId: string;
	mode: TaskExecutionMode;
	step: number;
	childSessionId: string;
	childSessionPath: string;
	childSessionName?: string;
	parentSessionId?: string;
	parentSessionPath?: string;
	terminalBackend?: TaskTerminalBackendId;
	terminalTargetId?: string;
	terminalWorkspace?: string;
	weztermPaneId?: string;
	weztermWorkspace?: string;
	effectiveContext: ContextMode;
	persist: boolean;
	agent?: string;
	profile?: string;
	taskPreview: string;
	createdAt: string;
	finishedAt?: string;
	status: ChildSessionStatus;
	exitCode?: number;
	stopReason?: string;
	errorMessage?: string;
}

export interface TaskChildSessionRecord {
	snapshot: ChildSessionSnapshot;
	sourceOrder: number;
	sourceSessionFile?: string;
	sourceSessionId?: string;
}

export interface TaskRunStepView {
	step: number;
	snapshot: ChildSessionSnapshot;
	status: TaskRunStepStatus;
	isLive: boolean;
	hasTerminalMetadata: boolean;
	warnings: string[];
	sourceOrder: number;
}

export interface TaskRunView {
	internalRunKey: string;
	runId: string;
	toolCallId: string;
	mode: TaskExecutionMode;
	sourceSessionFile?: string;
	sourceSessionId?: string;
	steps: TaskRunStepView[];
	stepCount: number;
	persistedStepCount: number;
	createdAt: string;
	updatedAt: string;
	status: TaskRunStatus;
	warnings: string[];
	latestSourceOrder: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function isTaskExecutionMode(value: unknown): value is TaskExecutionMode {
	return value === "single" || value === "parallel" || value === "chain";
}

function isChildSessionStatus(value: unknown): value is ChildSessionStatus {
	return value === "created" || value === "succeeded" || value === "failed" || value === "aborted";
}

function isContextMode(value: unknown): value is ContextMode {
	return value === "fresh" || value === "fork";
}

export function makeTaskRunStepKey(runId: string, step: number): string {
	return `${runId}:${step}`;
}

export function extractMessagePreviewText(message: unknown): string | undefined {
	if (!isRecord(message)) return undefined;
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		const textParts = message.content
			.flatMap((part) => {
				if (typeof part === "string") return [part];
				if (!isRecord(part)) return [];
				if (typeof part.text === "string") return [part.text];
				return [];
			})
			.join(" ")
			.trim();
		if (textParts) return textParts;
	}
	if (Array.isArray(message.parts)) {
		const textParts = message.parts
			.flatMap((part) => {
				if (!isRecord(part)) return [];
				if (part.type === "text" && typeof part.text === "string") return [part.text];
				return [];
			})
			.join(" ")
			.trim();
		if (textParts) return textParts;
	}
	return undefined;
}

export function resolveTaskOriginForBranch(
	entries: readonly SessionEntry[],
	createTaskPreview: (task: string, maxLength?: number) => string,
	leafId?: string | null,
): TaskOriginSnapshot | undefined {
	if (entries.length === 0) return undefined;
	const lastIndex = entries.length - 1;
	let targetIndex = lastIndex;
	if (leafId) {
		targetIndex = -1;
		for (let index = lastIndex; index >= 0; index--) {
			if (entries[index]?.id === leafId) {
				targetIndex = index;
				break;
			}
		}
	}
	let scanIndex = targetIndex >= 0 ? targetIndex : lastIndex;
	if (scanIndex < 0) return undefined;

	let originEntryId: string | undefined;
	let originUserEntryId: string | undefined;
	let originPreview: string | undefined;

	for (let index = scanIndex; index >= 0; index--) {
		const entry = entries[index];
		if (!entry) continue;
		if (!originEntryId && typeof entry.id === "string") originEntryId = entry.id;
		if (entry.type !== "message" || !isRecord(entry.message)) continue;
		if (entry.message.role !== "user") continue;
		originUserEntryId = typeof entry.id === "string" ? entry.id : undefined;
		const preview = extractMessagePreviewText(entry.message);
		originPreview = preview ? createTaskPreview(preview, 140) : undefined;
		break;
	}

	if (!originEntryId && !originUserEntryId && !originPreview) return undefined;
	return { originEntryId, originUserEntryId, originPreview };
}

export function normalizeChildSessionSnapshot(
	data: unknown,
	metadataVersion: number,
): ChildSessionSnapshot | undefined {
	if (!isRecord(data)) return undefined;
	if (!isTaskExecutionMode(data.mode)) return undefined;
	if (typeof data.runId !== "string" || !data.runId.trim()) return undefined;
	if (typeof data.toolCallId !== "string" || !data.toolCallId.trim()) return undefined;
	if (typeof data.step !== "number" || !Number.isInteger(data.step) || data.step <= 0) return undefined;
	if (typeof data.createdAt !== "string" || !data.createdAt.trim()) return undefined;

	const persist = typeof data.persist === "boolean" ? data.persist : true;
	const childSessionId =
		typeof data.childSessionId === "string" && data.childSessionId.trim().length > 0
			? data.childSessionId
			: `${data.runId}-step-${data.step}`;
	const childSessionPath = typeof data.childSessionPath === "string" ? data.childSessionPath : "";
	if (persist && !childSessionPath.trim()) return undefined;

	const status = isChildSessionStatus(data.status) ? data.status : "created";
	const contextMode = isContextMode(data.effectiveContext) ? data.effectiveContext : "fresh";
	const attachment = getTaskTerminalAttachment({
		terminalBackend: isTaskTerminalBackendId(data.terminalBackend) ? data.terminalBackend : undefined,
		terminalTargetId: typeof data.terminalTargetId === "string" ? data.terminalTargetId : undefined,
		terminalWorkspace: typeof data.terminalWorkspace === "string" ? data.terminalWorkspace : undefined,
		weztermPaneId: typeof data.weztermPaneId === "string" ? data.weztermPaneId : undefined,
		weztermWorkspace: typeof data.weztermWorkspace === "string" ? data.weztermWorkspace : undefined,
	});

	return {
		v: typeof data.v === "number" && Number.isFinite(data.v) ? data.v : metadataVersion,
		runId: data.runId,
		toolCallId: data.toolCallId,
		mode: data.mode,
		step: data.step,
		childSessionId,
		childSessionPath,
		childSessionName: typeof data.childSessionName === "string" ? data.childSessionName : undefined,
		parentSessionId: typeof data.parentSessionId === "string" ? data.parentSessionId : undefined,
		parentSessionPath: typeof data.parentSessionPath === "string" ? data.parentSessionPath : undefined,
		originEntryId: typeof data.originEntryId === "string" ? data.originEntryId : undefined,
		originUserEntryId: typeof data.originUserEntryId === "string" ? data.originUserEntryId : undefined,
		originPreview: typeof data.originPreview === "string" ? data.originPreview : undefined,
		terminalBackend: attachment?.backend,
		terminalTargetId: attachment?.targetId,
		terminalWorkspace: attachment?.workspace,
		weztermPaneId: attachment?.backend === "wezterm" ? attachment.targetId : undefined,
		weztermWorkspace: attachment?.backend === "wezterm" ? attachment.workspace : undefined,
		effectiveContext: contextMode,
		persist,
		agent: typeof data.agent === "string" ? data.agent : undefined,
		profile: typeof data.profile === "string" ? data.profile : undefined,
		taskPreview: typeof data.taskPreview === "string" ? data.taskPreview : "",
		createdAt: data.createdAt,
		finishedAt: typeof data.finishedAt === "string" ? data.finishedAt : undefined,
		status,
		exitCode: typeof data.exitCode === "number" && Number.isFinite(data.exitCode) ? data.exitCode : undefined,
		stopReason: typeof data.stopReason === "string" ? data.stopReason : undefined,
		errorMessage: typeof data.errorMessage === "string" ? data.errorMessage : undefined,
	};
}

export function collectTaskMetadataRecordsFromEntries(
	entries: readonly SessionEntry[],
	customType: string,
	metadataVersion: number,
	sourceSessionFile?: string,
): TaskChildSessionRecord[] {
	const records: TaskChildSessionRecord[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (!entry || (entry as { type?: unknown }).type !== "custom") continue;
		const customEntry = entry as { customType?: unknown; data?: unknown };
		if (customEntry.customType !== customType) continue;
		const snapshot = normalizeChildSessionSnapshot(customEntry.data, metadataVersion);
		if (!snapshot) continue;
		records.push({ snapshot, sourceOrder: index, sourceSessionFile });
	}
	return records;
}

export function collectLiveTaskRunSteps(entries: readonly SessionEntry[], metadataVersion: number): Set<string> {
	const live = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!isRecord(message) || message.role !== "toolResult" || message.toolName !== "task") continue;
		const details = message.details;
		if (!isRecord(details)) continue;

		const childSessions = Array.isArray(details.childSessions) ? details.childSessions : [];
		for (const value of childSessions) {
			const snapshot = normalizeChildSessionSnapshot(value, metadataVersion);
			if (!snapshot) continue;
			if (snapshot.status === "created") live.add(makeTaskRunStepKey(snapshot.runId, snapshot.step));
		}

		const results = Array.isArray(details.results) ? details.results : [];
		for (const rawResult of results) {
			if (!isRecord(rawResult)) continue;
			const snapshot = normalizeChildSessionSnapshot(rawResult.childSession, metadataVersion);
			if (!snapshot) continue;
			const exitCode = typeof rawResult.exitCode === "number" ? rawResult.exitCode : undefined;
			if (snapshot.status === "created" || exitCode === -1) {
				live.add(makeTaskRunStepKey(snapshot.runId, snapshot.step));
			}
		}
	}
	return live;
}

export function toMillis(value: string | undefined): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

export function getSnapshotEventTimestamp(snapshot: ChildSessionSnapshot): string {
	return snapshot.finishedAt ?? snapshot.createdAt;
}

export function formatTimestampCompact(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d{3}Z$/, "Z");
}

async function collectTaskMetadataRecordsFromSessionFile(
	sessionFile: string,
	customType: string,
	metadataVersion: number,
): Promise<TaskChildSessionRecord[]> {
	const records: TaskChildSessionRecord[] = [];
	const stream = fs.createReadStream(sessionFile, { encoding: "utf-8" });
	const lines = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	let lineNumber = 0;
	let sourceSessionId: string | undefined;

	try {
		for await (const line of lines) {
			lineNumber++;
			if (!line.trim()) continue;

			if (lineNumber === 1) {
				try {
					const parsedHeader = JSON.parse(line) as unknown;
					if (
						isRecord(parsedHeader) &&
						parsedHeader.type === "session" &&
						typeof parsedHeader.id === "string"
					) {
						sourceSessionId = parsedHeader.id;
					}
				} catch {
					// Ignore malformed header line.
				}
			}

			if (!line.includes(customType)) continue;

			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (!isRecord(parsed) || parsed.type !== "custom" || parsed.customType !== customType) continue;
			const snapshot = normalizeChildSessionSnapshot(parsed.data, metadataVersion);
			if (!snapshot) continue;
			records.push({
				snapshot,
				sourceOrder: lineNumber,
				sourceSessionFile: sessionFile,
				sourceSessionId,
			});
		}
	} finally {
		lines.close();
		stream.destroy();
	}

	return records;
}

function deriveTaskRunStepStatus(snapshot: ChildSessionSnapshot, isLive: boolean): TaskRunStepStatus {
	if (!snapshot.persist) return "not-persisted";
	if (snapshot.status === "created") return isLive ? "running" : "interrupted";
	return snapshot.status;
}

function deriveTaskRunStatus(stepStatuses: TaskRunStepStatus[]): TaskRunStatus {
	if (stepStatuses.some((status) => status === "running")) return "running";
	if (stepStatuses.some((status) => status === "interrupted")) return "interrupted";
	if (stepStatuses.some((status) => status === "failed")) return "failed";
	if (stepStatuses.some((status) => status === "aborted")) return "aborted";
	if (stepStatuses.some((status) => status === "succeeded")) return "succeeded";
	return "not-persisted";
}

export function buildTaskRunViews(records: TaskChildSessionRecord[], liveStepKeys: Set<string>): TaskRunView[] {
	const byRun = new Map<string, Map<number, TaskChildSessionRecord>>();

	for (const record of records) {
		const runKey = `${record.sourceSessionFile ?? "current"}::${record.snapshot.runId}`;
		let byStep = byRun.get(runKey);
		if (!byStep) {
			byStep = new Map();
			byRun.set(runKey, byStep);
		}
		const existing = byStep.get(record.snapshot.step);
		if (!existing || record.sourceOrder >= existing.sourceOrder) {
			byStep.set(record.snapshot.step, record);
		}
	}

	const runs: TaskRunView[] = [];
	for (const [internalRunKey, byStep] of byRun.entries()) {
		const orderedRecords = Array.from(byStep.values()).sort(
			(left, right) => left.snapshot.step - right.snapshot.step,
		);
		if (orderedRecords.length === 0) continue;

		const steps: TaskRunStepView[] = orderedRecords.map((record) => {
			const snapshot = record.snapshot;
			const isLive = liveStepKeys.has(makeTaskRunStepKey(snapshot.runId, snapshot.step));
			const status = deriveTaskRunStepStatus(snapshot, isLive);
			const hasTerminalMetadata = snapshot.status !== "created";
			const warnings: string[] = [];

			if (snapshot.persist) {
				if (!snapshot.childSessionPath.trim()) warnings.push("missing child session path (stale metadata)");
				else if (!fs.existsSync(snapshot.childSessionPath))
					warnings.push("child session file missing (stale metadata)");
			}
			if (!hasTerminalMetadata && !isLive) warnings.push("no terminal metadata; treated as interrupted");
			if (!snapshot.persist) warnings.push("legacy non-persisted child session metadata");

			return {
				step: snapshot.step,
				snapshot,
				status,
				isLive,
				hasTerminalMetadata,
				warnings,
				sourceOrder: record.sourceOrder,
			};
		});

		const latestStep = steps.reduce(
			(latest, current) => (current.sourceOrder > latest.sourceOrder ? current : latest),
			steps[0]!,
		);
		const createdAt = steps.reduce((minValue, step) => {
			const value = toMillis(step.snapshot.createdAt);
			if (value === 0) return minValue;
			return minValue === 0 ? value : Math.min(minValue, value);
		}, 0);
		const updatedAt = steps.reduce((maxValue, step) => {
			const value = toMillis(getSnapshotEventTimestamp(step.snapshot));
			return Math.max(maxValue, value);
		}, 0);
		const runWarnings = steps.flatMap((step) => step.warnings.map((warning) => `step ${step.step}: ${warning}`));
		const stepStatuses = steps.map((step) => step.status);
		const status = deriveTaskRunStatus(stepStatuses);

		runs.push({
			internalRunKey,
			runId: latestStep.snapshot.runId,
			toolCallId: latestStep.snapshot.toolCallId,
			mode: latestStep.snapshot.mode,
			sourceSessionFile: orderedRecords.find((record) => Boolean(record.sourceSessionFile))?.sourceSessionFile,
			sourceSessionId: orderedRecords.find((record) => Boolean(record.sourceSessionId))?.sourceSessionId,
			steps,
			stepCount: steps.length,
			persistedStepCount: steps.filter((step) => step.snapshot.persist).length,
			createdAt: createdAt > 0 ? new Date(createdAt).toISOString() : latestStep.snapshot.createdAt,
			updatedAt:
				updatedAt > 0 ? new Date(updatedAt).toISOString() : getSnapshotEventTimestamp(latestStep.snapshot),
			status,
			warnings: runWarnings,
			latestSourceOrder: Math.max(...steps.map((step) => step.sourceOrder)),
		});
	}

	return runs.sort((left, right) => {
		const updatedDiff = toMillis(right.updatedAt) - toMillis(left.updatedAt);
		if (updatedDiff !== 0) return updatedDiff;
		return right.latestSourceOrder - left.latestSourceOrder;
	});
}

export function reconstructCurrentTaskRuns(options: {
	entries: readonly SessionEntry[];
	sourceSessionFile?: string;
	customType: string;
	metadataVersion: number;
	extraLiveStepKeys?: Iterable<string>;
}): TaskRunView[] {
	const records = collectTaskMetadataRecordsFromEntries(
		options.entries,
		options.customType,
		options.metadataVersion,
		options.sourceSessionFile,
	);
	const liveSteps = collectLiveTaskRunSteps(options.entries, options.metadataVersion);
	for (const key of options.extraLiveStepKeys ?? []) liveSteps.add(key);
	return buildTaskRunViews(records, liveSteps);
}

export function resolveTaskRunOriginSnapshot(
	run: TaskRunView,
	selectedStep?: TaskRunStepView,
): TaskOriginSnapshot | undefined {
	if (selectedStep) {
		const { originEntryId, originUserEntryId, originPreview } = selectedStep.snapshot;
		if (originEntryId || originUserEntryId || originPreview)
			return { originEntryId, originUserEntryId, originPreview };
	}
	for (const step of run.steps) {
		const { originEntryId, originUserEntryId, originPreview } = step.snapshot;
		if (originEntryId || originUserEntryId || originPreview)
			return { originEntryId, originUserEntryId, originPreview };
	}
	return undefined;
}

export function getTaskOriginNavigationTarget(run: TaskRunView, selectedStep?: TaskRunStepView): string | undefined {
	const origin = resolveTaskRunOriginSnapshot(run, selectedStep);
	return origin?.originUserEntryId ?? origin?.originEntryId;
}
