/**
 * Task Tool - Delegate work to specialized agents
 *
 * Runs each delegated task step as a real, in-process AgentSession -- the same session type,
 * the same prompt()/steer()/subscribe() primitives, that a normal interactive pi session uses.
 * No subprocess, no pty, no RPC-over-pipes protocol: a live controller registry (task-live.ts)
 * tracks running steps so /tasks steer can reach them directly in-process.
 *
 * Supports a compact mode + steps API:
 *   - Single: { steps: [{ agent: "name", task: "..." }] }
 *   - Parallel: { mode: "parallel", steps: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { mode: "chain", steps: [{ agent: "name", task: "... {previous} ..." }, ...] }
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
	type ModelRegistry,
	type SessionEntry,
	SessionManager,
	ProjectTrustStore,
	getAgentDir,
	hasTrustRequiringProjectResources,
	keyHint,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { MAIN_SESSION_AGENT_CUSTOM_TYPE } from "../shared/agent-state";
import {
	type AgentConfig,
	type AgentScope,
	type ContextMode,
	type EffortConfig,
	type ProfileConfig,
	type ResourceDiscoveryResult,
	discoverResources,
	hasProjectTaskResources,
	resolveSkillPaths,
} from "./agents.js";
import { parseTasksCommand, resolveTaskSelector, type TasksScope } from "./task-command-utils.js";
import {
	type DisplayItem,
	type TaskInlineNotice,
	type UsageStats,
	addTaskInlineNotice,
	appendTaskOutputSection,
	buildTaskInlineNoticeLines,
	createTaskPreview,
	formatChainResults,
	formatParallelResults,
	formatTaskCallHeading,
	formatTaskConfigurationLines,
	formatTaskHeader,
	formatTaskInlineNoticeLines,
	formatTaskSnippetLines,
	formatToolCall,
	formatUsageStats,
	getDisplayItems,
	getFinalOutput,
	shortenHomePath,
	shouldDisplayTaskInlineNotice,
	truncateOutput,
} from "./task-display.js";
import {
	ASK_CALLER_TOOL_NAME,
	createWorkerAgentSession,
	TASK_COMPLETE_TOOL_NAME,
	type WorkerControlSignal,
} from "./task-agent-session.js";
import { checkSubagentDepth, type RpcWorkerEvent } from "./task-rpc-worker.js";
import {
	extractMessagePreviewText,
	formatTimestampCompact,
	getSnapshotEventTimestamp,
	getTaskOriginNavigationTarget,
	makeTaskRunStepKey,
	normalizeChildSessionSnapshot,
	reconstructCurrentTaskRuns,
	resolveTaskOriginForBranch,
	resolveTaskRunOriginSnapshot,
	toMillis,
	type ChildSessionSnapshot,
	type ChildSessionStatus,
	type TaskExecutionMode,
	type TaskOriginSnapshot,
	type TaskRunStatus,
	type TaskRunStepStatus,
	type TaskRunStepView,
	type TaskRunView,
} from "./task-runs.js";
import {
	deleteLiveTaskController,
	deliverToLiveSession,
	getLiveTaskController,
	isLiveController,
	listLiveTaskControllers,
	readLiveTaskRuntimeInfo,
	registerAgentSessionController,
	type LiveTaskController,
	type LiveTaskRuntimeInfo,
} from "./task-live.js";
import { validateTaskSessionReference } from "./task-session-validation.js";
import { TaskAttachOverlay, type TaskAttachOverlayState } from "./task-attach-view.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const TASK_SESSION_VERSION_FALLBACK = 3;
const TASK_CHILD_SESSION_CUSTOM_TYPE = "tasks.child-session";
const TASK_CHILD_SESSION_METADATA_VERSION = 1;
const TASKS_PARENT_SESSION_ROOT = path.join(getAgentDir(), "sessions");
const TASKS_NO_CURRENT_RUNS_MESSAGE = "No task runs in current session.";
const TASKS_BROWSER_SHORTCUT = "ctrl+shift+t";
const TASKS_COMMAND_USAGE = [
	"/tasks",
	"/tasks list",
	"/tasks toggle",
	"/tasks parent",
	"/tasks view <selector>",
	"/tasks open <selector>",
	"/tasks origin <selector>",
	"/tasks steer <selector> <message>",
].join(" | ");

const taskWidgetEnabledSessions = new Set<string>();
let taskDialogRelayQueue: Promise<unknown> = Promise.resolve();

function formatShortcutLabel(shortcut: string): string {
	return shortcut
		.split("+")
		.map((part) => {
			const token = part.trim().toLowerCase();
			if (token === "ctrl") return "Ctrl";
			if (token === "shift") return "Shift";
			if (token === "alt") return "Alt";
			if (token === "super") return "Super";
			if (token === "escape" || token === "esc") return "Esc";
			if (token === "return") return "Enter";
			if (token === "pageup") return "PgUp";
			if (token === "pagedown") return "PgDn";
			if (token.length === 1) return token.toUpperCase();
			return token.charAt(0).toUpperCase() + token.slice(1);
		})
		.join("+");
}

const TASKS_BROWSER_SHORTCUT_LABEL = formatShortcutLabel(TASKS_BROWSER_SHORTCUT);

const MAX_PARENT_MESSAGES = 512;
const MAX_PARENT_MESSAGE_BYTES = 4 * 1024 * 1024;
const TRUNCATION_MARKER = "\n[output truncated; full output is in the child session]\n";

function truncateUtf8ToBytes(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(text, "utf8");
	let result = bytes.subarray(0, maxBytes).toString("utf8");
	while (result.endsWith("�") || Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
	return result;
}

function appendBoundedText(current: string, text: string, maxBytes: number): string {
	if (!text) return current;
	const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
	const currentBytes = Buffer.byteLength(current, "utf8");
	if (currentBytes >= maxBytes) return current;
	const incoming = Buffer.byteLength(text, "utf8");
	if (currentBytes + incoming <= maxBytes) return current + text;
	const body = truncateUtf8ToBytes(text, Math.max(0, maxBytes - currentBytes - markerBytes));
	const marker = truncateUtf8ToBytes(TRUNCATION_MARKER, Math.min(markerBytes, maxBytes));
	return truncateUtf8ToBytes(current + body, Math.max(0, maxBytes - Buffer.byteLength(marker))) + marker;
}

interface MessageByteState {
	totalBytes: number;
	sizes: WeakMap<object, number>;
}
const messageByteStates = new WeakMap<Message[], MessageByteState>();

function estimateBytes(value: unknown, limit: number, seen = new WeakSet<object>(), depth = 0): number {
	if (limit <= 0) return 0;
	if (value === null || typeof value !== "object") return Buffer.byteLength(String(value), "utf8");
	if (seen.has(value) || depth > 32) return 8;
	seen.add(value);
	let total = Array.isArray(value) ? 2 : 2;
	if (Array.isArray(value))
		for (const item of value) {
			total += estimateBytes(item, limit - total, seen, depth + 1);
			if (total > limit) return limit + 1;
		}
	else
		for (const [key, item] of Object.entries(value)) {
			total +=
				Buffer.byteLength(JSON.stringify(key), "utf8") +
				1 +
				estimateBytes(item, limit - total, seen, depth + 1);
			if (total > limit) return limit + 1;
		}
	return total;
}

function pushBoundedMessage(messages: Message[], message: Message): boolean {
	if (messages.length >= MAX_PARENT_MESSAGES) return false;
	let state = messageByteStates.get(messages);
	if (!state) {
		state = { totalBytes: 0, sizes: new WeakMap() };
		messageByteStates.set(messages, state);
	}
	const messageObject = message as unknown as object;
	const bytes = state.sizes.get(messageObject) ?? estimateBytes(message, MAX_PARENT_MESSAGE_BYTES + 1);
	if (state.totalBytes + bytes > MAX_PARENT_MESSAGE_BYTES) return false;
	state.sizes.set(messageObject, bytes);
	state.totalBytes += bytes;
	messages.push(message);
	return true;
}

interface TaskStepConfig {
	agent?: string;
	profile?: string;
	effort?: string;
	task: string;
	cwd?: string;
	model?: string;
	skills?: string[];
	prompt?: string;
	context?: ContextMode;
	interactive?: boolean;
	resumeSessionId?: string;
}

interface TaskToolParams {
	mode?: TaskExecutionMode;
	steps?: TaskStepConfig[];
	agentScope?: AgentScope;
}

interface PreparedTaskToolParams extends TaskToolParams {
	steps: TaskStepConfig[];
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	profile?: string;
	effort?: string;
	skills?: string[];
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	sessionMode?: ContextMode;
	sessionPersist?: boolean;
	sessionFile?: string;
	childSession?: ChildSessionSnapshot;
	uiNotices?: TaskInlineNotice[];
	/** The worker's own session id, always set once its session exists -- unlike `childSession`,
	 * which is only populated for persisted steps. Lets a pingback point back at a live or
	 * resumable worker (via `resumeSessionId`) regardless of persistence. */
	sessionId?: string;
	/** Set when the worker called `task_complete`; the authoritative final answer, if present. */
	completionSummary?: string;
	/** Set when the worker called `ask_caller`; what it needs from the caller. */
	pendingQuestion?: string;
	/** True when an interactive worker's session is being kept alive (not disposed) because it
	 * hasn't called `task_complete` yet -- resumable via `resumeSessionId` or `/tasks open`. */
	awaitingReply?: boolean;
}

function boundParentResult(result: SingleResult): SingleResult {
	return {
		...result,
		stderr: truncateOutput(result.stderr),
		errorMessage: result.errorMessage ? truncateOutput(result.errorMessage) : undefined,
		childSession: result.childSession
			? {
					...result.childSession,
					errorMessage: result.childSession.errorMessage
						? createTaskPreview(truncateOutput(result.childSession.errorMessage), 240)
						: undefined,
				}
			: undefined,
	};
}

interface TaskDetails {
	mode: TaskExecutionMode;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	sessionRunId?: string;
	toolCallId?: string;
	childSessions?: ChildSessionSnapshot[];
}

type TaskExtensionUiNotifyType = "info" | "warning" | "error";

function sanitizeTaskUiKeySegment(value: string | undefined, fallback: string): string {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return fallback;
	const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || fallback;
}

function getTaskUiLabel(controller: Pick<LiveTaskController, "agent" | "step">): string {
	return `Task ${controller.agent}${controller.step > 0 ? ` step ${controller.step}` : ""}`;
}

function getTaskUiPrefix(controller: Pick<LiveTaskController, "agent" | "step">): string {
	return `[${getTaskUiLabel(controller)}]`;
}

function formatTaskExtensionUiTitle(
	controller: Pick<LiveTaskController, "agent" | "step">,
	title: string | undefined,
): string {
	const label = getTaskUiLabel(controller);
	const trimmedTitle = title?.trim();
	return trimmedTitle ? `${label} · ${trimmedTitle}` : label;
}

function enqueueTaskDialogRelay<T>(action: () => Promise<T>): Promise<T> {
	const run = taskDialogRelayQueue.catch(() => {}).then(action);
	taskDialogRelayQueue = run.catch(() => {});
	return run;
}

function getTaskStatusRelayKey(controller: Pick<LiveTaskController, "key">, statusKey: string | undefined): string {
	return `tasks.${sanitizeTaskUiKeySegment(controller.key, "task")}.status.${sanitizeTaskUiKeySegment(statusKey, "status")}`;
}

function getTaskWidgetRelayKey(controller: Pick<LiveTaskController, "key">, widgetKey: string | undefined): string {
	return `tasks.${sanitizeTaskUiKeySegment(controller.key, "task")}.widget.${sanitizeTaskUiKeySegment(widgetKey, "widget")}`;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Relays one `extension_ui_request` event from a delegated worker's RPC child process to the
 * parent's real UI, prefixed with the worker's task label -- a worker has no terminal of its
 * own, so its dialogs (select/confirm/input/editor) and ambient status/widget updates need
 * somewhere to go. Dialogs from concurrently-running steps are serialized through
 * enqueueTaskDialogRelay so only one shows on the real terminal at a time. Without a real
 * parent UI (or for methods a worker's own TUI would normally handle, like setTitle), this
 * simply never responds -- the worker's own extension host auto-resolves the dialog to its
 * default after a timeout, exactly like RPC mode does when nothing is attached.
 */
function relayTaskExtensionUiRequest(params: {
	event: RpcWorkerEvent;
	controller: Pick<LiveTaskController, "agent" | "step" | "key">;
	parentUi: ExtensionUIContext | undefined;
	relayedKeys: { status: Set<string>; widget: Set<string> };
	respond: (response: Record<string, unknown>) => void;
}): void {
	const { event, controller, parentUi, relayedKeys, respond } = params;
	const id = event.id;
	const method = asString(event.method);
	if (typeof id !== "string" || !method) return;
	const title = formatTaskExtensionUiTitle(controller, asString(event.title));
	const prefix = getTaskUiPrefix(controller);
	const cancelled = () => respond({ type: "extension_ui_response", id, cancelled: true });

	switch (method) {
		case "select": {
			if (!parentUi) return void cancelled();
			void enqueueTaskDialogRelay(async () => {
				const value = await parentUi.select(title, asStringArray(event.options));
				respond(
					value !== undefined
						? { type: "extension_ui_response", id, value }
						: { type: "extension_ui_response", id, cancelled: true },
				);
			});
			return;
		}
		case "confirm": {
			if (!parentUi) return void respond({ type: "extension_ui_response", id, confirmed: false });
			void enqueueTaskDialogRelay(async () => {
				const confirmed = await parentUi.confirm(title, asString(event.message) ?? "");
				respond({ type: "extension_ui_response", id, confirmed });
			});
			return;
		}
		case "input": {
			if (!parentUi) return void cancelled();
			void enqueueTaskDialogRelay(async () => {
				const value = await parentUi.input(title, asString(event.placeholder));
				respond(
					value !== undefined
						? { type: "extension_ui_response", id, value }
						: { type: "extension_ui_response", id, cancelled: true },
				);
			});
			return;
		}
		case "editor": {
			if (!parentUi) return void cancelled();
			void enqueueTaskDialogRelay(async () => {
				const value = await parentUi.editor(title, asString(event.prefill));
				respond(
					value !== undefined
						? { type: "extension_ui_response", id, value }
						: { type: "extension_ui_response", id, cancelled: true },
				);
			});
			return;
		}
		case "setStatus": {
			if (!parentUi) return;
			const relayKey = getTaskStatusRelayKey(controller, asString(event.statusKey));
			relayedKeys.status.add(relayKey);
			const statusText = asString(event.statusText);
			parentUi.setStatus(relayKey, statusText ? `${prefix} ${statusText}` : undefined);
			return;
		}
		case "setWidget": {
			if (!parentUi) return;
			const relayKey = getTaskWidgetRelayKey(controller, asString(event.widgetKey));
			relayedKeys.widget.add(relayKey);
			const widgetLines = asStringArray(event.widgetLines);
			parentUi.setWidget(
				relayKey,
				widgetLines.length > 0
					? widgetLines.map((line, index) => (index === 0 ? `${prefix} ${line}` : line))
					: undefined,
				event.widgetPlacement === "belowEditor" ? { placement: "belowEditor" } : undefined,
			);
			return;
		}
		// Notifications, title, and editor-text pushes have no meaningful destination on the
		// parent's real UI (which isn't the worker's own terminal) -- never responding lets the
		// worker's own extension host fall through to its default resolution.
		default:
			return;
	}
}

/** Clears any status/widget entries a worker relayed to the parent's real ui via createWorkerUiContext, so nothing lingers after the step finishes. */
function clearRelayedTaskUi(
	parentUi: Pick<ExtensionUIContext, "setStatus" | "setWidget"> | undefined,
	relayedKeys: { status: Set<string>; widget: Set<string> },
): void {
	if (!parentUi) return;
	for (const key of relayedKeys.status) {
		try {
			parentUi.setStatus(key, undefined);
		} catch {
			// Best-effort cleanup.
		}
	}
	for (const key of relayedKeys.widget) {
		try {
			parentUi.setWidget(key, undefined);
		} catch {
			// Best-effort cleanup.
		}
	}
}

function resolveChildSessionTerminalStatus(result: SingleResult): Exclude<ChildSessionStatus, "created"> {
	if (result.stopReason === "aborted") return "aborted";
	if (result.exitCode === 0 && result.stopReason !== "error") return "succeeded";
	return "failed";
}

function formatChildSessionStatus(status: ChildSessionStatus, themeFg: (color: any, text: string) => string): string {
	switch (status) {
		case "created":
			return themeFg("warning", status);
		case "succeeded":
			return themeFg("success", status);
		case "aborted":
			return themeFg("warning", status);
		default:
			return themeFg("error", status);
	}
}

function formatChildSessionCompact(
	snapshot: ChildSessionSnapshot,
	themeFg: (color: any, text: string) => string,
): string {
	const shortId = snapshot.childSessionId.slice(0, 8);
	return [
		themeFg("muted", "session: "),
		themeFg("accent", shortId),
		themeFg("muted", " · "),
		formatChildSessionStatus(snapshot.status, themeFg),
	].join("");
}

function formatChildSessionExpanded(
	snapshot: ChildSessionSnapshot,
	themeFg: (color: any, text: string) => string,
): string {
	const shortId = snapshot.childSessionId.slice(0, 8);
	const parts = [
		themeFg("muted", "session: "),
		themeFg("accent", shortId),
		themeFg("muted", " · "),
		formatChildSessionStatus(snapshot.status, themeFg),
		themeFg("muted", " · "),
		themeFg("dim", snapshot.effectiveContext),
		themeFg("muted", " · "),
		themeFg("dim", shortenHomePath(snapshot.childSessionPath)),
	];
	return parts.join("");
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
	cancellation?: {
		isCancelled: () => boolean;
		onCancelled: (item: TIn, index: number) => TOut;
	},
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			if (nextIndex >= items.length) return;
			const current = nextIndex++;
			const item = items[current] as TIn;
			if (cancellation?.isCancelled()) {
				results[current] = cancellation.onCancelled(item, current);
				continue;
			}
			results[current] = await fn(item, current);
		}
	});
	await Promise.all(workers);
	return results;
}

function normalizeLegacyModelName(model: string | undefined): string | undefined {
	if (!model || model.includes("/")) return model;
	return model.replace(/(\d)-(\d)(?=(?:\D|$))/g, "$1.$2");
}

type OnUpdateCallback = (partial: AgentToolResult<TaskDetails>) => void;

interface ResolvedWorkerConfig {
	agent?: AgentConfig;
	profile?: ProfileConfig;
	effort?: EffortConfig;
	model?: string;
	skills?: string[];
	tools?: string[];
	excludeTools?: string[];
	context: {
		mode: ContextMode;
		project: boolean;
		skills: boolean;
	};
	persist: boolean;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	allowDelegation: boolean;
	/** Whether this worker stays alive after its first turn instead of auto-finishing; only ends when it calls `task_complete`. */
	interactive: boolean;
	systemPrompt: string;
	systemPromptMode: "append" | "replace";
	displayAgentName: string;
}

function isTaskCallableAgent(agent: AgentConfig): boolean {
	return agent.enabled && (agent.availability === "task" || agent.availability === "both");
}

function getTaskCallableAgents(resources: ResourceDiscoveryResult): AgentConfig[] {
	return resources.agents.filter(isTaskCallableAgent);
}

function formatCallableAgentList(resources: ResourceDiscoveryResult): string {
	return (
		getTaskCallableAgents(resources)
			.map((a) => `${a.name} (${a.source})`)
			.join(", ") || "none"
	);
}

function formatGenericWorkerBehaviorError(resources: ResourceDiscoveryResult): string {
	const callableAgents = getTaskCallableAgents(resources);
	const preferredAgentNames = ["reviewer", "thinker", "implementer"].filter((name) =>
		callableAgents.some((agent) => agent.name === name),
	);
	const suggestedAgentNames =
		preferredAgentNames.length > 0 ? preferredAgentNames : callableAgents.slice(0, 3).map((agent) => agent.name);
	const agentSuggestion =
		suggestedAgentNames.length > 0
			? `Use an agent such as ${suggestedAgentNames.map((name) => `\`${name}\``).join(", ")}.`
			: "No task agents are available, so include a behavioral `prompt`.";

	return [
		"Invalid task configuration. Generic task steps require worker behavior: set `agent`, select a behavior-bearing `profile`, or provide `prompt`.",
		agentSuggestion,
		'For generic workers, add `prompt`, for example: `prompt: "You are an independent read-only code reviewer. Report findings with severity and file references."`.',
		"Do not send bare `{ task: ... }` steps.",
		`Available task agents: ${formatCallableAgentList(resources)}.`,
	].join(" ");
}

function formatProfileList(resources: ResourceDiscoveryResult): string {
	return (
		resources.profiles
			.filter((profile) => profile.enabled)
			.map((profile) => `${profile.name} (${profile.source})`)
			.join(", ") || "none"
	);
}

function formatEffortList(resources: ResourceDiscoveryResult): string {
	return resources.efforts.map((effort) => `${effort.name} (${effort.source})`).join(", ") || "none";
}

function formatTaskAgentOptions(resources: ResourceDiscoveryResult): string {
	return (
		getTaskCallableAgents(resources)
			.map((agent) => {
				const defaultEffort = agent.defaultEffort ? ` (default effort: \`${agent.defaultEffort}\`)` : "";
				return `\`${agent.name}\`${defaultEffort}`;
			})
			.join(", ") || "none"
	);
}

function formatTaskEffortOptions(resources: ResourceDiscoveryResult): string {
	return (
		resources.efforts
			.map((effort) => {
				const model = effort.provider ? `${effort.provider}/${effort.model}` : effort.model;
				const thinkingLevel = effort.thinkingLevel ? `, thinking: \`${effort.thinkingLevel}\`` : "";
				return `\`${effort.name}\` (${model}${thinkingLevel})`;
			})
			.join(", ") || "none"
	);
}

function formatTaskDelegationGuidance(cwd: string, projectTrusted = false): string {
	const userResources = discoverResources(cwd, "user", projectTrusted);
	const projectResources = discoverResources(cwd, "project", projectTrusted);
	const combinedResources = discoverResources(cwd, "both", projectTrusted);

	return [
		"Task delegation choices for this directory:",
		`- With the default \`agentScope: "user"\`, valid task agents are: ${formatTaskAgentOptions(userResources)}.`,
		`- With \`agentScope: "project"\`, valid task agents are: ${formatTaskAgentOptions(projectResources)}. With \`agentScope: "both"\`, valid task agents are: ${formatTaskAgentOptions(combinedResources)}.`,
		`- Valid \`effort\` presets are: ${formatTaskEffortOptions(combinedResources)}. Use these exact preset names; do not use a thinking level such as \`high\` as an effort. Omit \`effort\` to use the selected agent's default.`,
		'- To create a generic worker, omit `agent` and provide a behavioral `prompt`; do not set `agent: "generic"`.',
		"- Child workers cannot use `task` unless their selected agent or profile declares `allowDelegation: true`.",
		"- An agent must be listed above for its selected scope; a main-session-only agent is not valid for `task`.",
	].join("\n");
}

function composePromptLayers(...layers: string[]): string {
	const trimmed = layers.map((layer) => layer.trim()).filter(Boolean);
	return trimmed.join("\n\n---\n\n");
}

function escapeXmlAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

let discoveredSkills: Array<{ name: string; filePath: string }> = [];

function extractDiscoveredSkills(skills: unknown[] | undefined): Array<{ name: string; filePath: string }> {
	return (skills ?? []).flatMap((skill) => {
		if (!skill || typeof skill !== "object") return [];
		const candidate = skill as { name?: unknown; filePath?: unknown };
		if (typeof candidate.name !== "string" || typeof candidate.filePath !== "string") return [];
		return [{ name: candidate.name, filePath: candidate.filePath }];
	});
}

async function loadRequiredSkillInstructions(skillPaths: string[]): Promise<string> {
	const instructionPaths: string[] = [];
	for (const skillPath of skillPaths) {
		try {
			const stats = await fs.promises.stat(skillPath);
			instructionPaths.push(stats.isDirectory() ? path.join(skillPath, "SKILL.md") : skillPath);
		} catch (error) {
			const detail = error instanceof Error ? `: ${error.message}` : "";
			throw new Error(`Failed to read required skill at "${skillPath}"${detail}`);
		}
	}

	const sections: string[] = [];
	for (const instructionPath of new Set(instructionPaths)) {
		let content: string;
		try {
			content = await fs.promises.readFile(instructionPath, "utf-8");
		} catch (error) {
			const detail = error instanceof Error ? `: ${error.message}` : "";
			throw new Error(`Failed to read required skill at "${instructionPath}"${detail}`);
		}
		sections.push(
			`<required_skill path="${escapeXmlAttribute(instructionPath)}">\n${content.trim()}\n</required_skill>`,
		);
	}
	if (sections.length === 0) return "";
	return [
		"The following skills are required for this task and are already loaded.",
		"Follow their instructions. Resolve relative paths against the directory containing each listed skill path.",
		...sections,
	].join("\n\n");
}

function composeWorkerSystemPrompt(systemPrompt: string, requiredSkillInstructions: string): string {
	return composePromptLayers(systemPrompt, requiredSkillInstructions);
}

async function prepareWorkerSystemPrompt(
	worker: Pick<ResolvedWorkerConfig, "displayAgentName" | "skills" | "systemPrompt">,
	launchCwd: string,
	projectTrusted: boolean,
): Promise<string> {
	if (!worker.skills || worker.skills.length === 0) return worker.systemPrompt;
	const { paths, missing } = resolveSkillPaths(worker.skills, launchCwd, projectTrusted, discoveredSkills);
	if (missing.length > 0) {
		throw new Error(
			`Failed to resolve required skills for worker "${worker.displayAgentName}": ${missing.join(", ")}.`,
		);
	}
	const requiredSkillInstructions = await loadRequiredSkillInstructions(paths);
	return composeWorkerSystemPrompt(worker.systemPrompt, requiredSkillInstructions);
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
	for (const value of values) {
		if (value !== undefined) return value;
	}
	return undefined;
}

function buildEffortModelSpec(effort: EffortConfig): {
	model?: string;
	error?: string;
} {
	const normalizedModel = normalizeLegacyModelName(effort.model)?.trim();
	if (!normalizedModel) {
		return { error: `Effort "${effort.name}" has no model configured.` };
	}

	const slashIndex = normalizedModel.indexOf("/");
	if (slashIndex !== -1) {
		const modelProvider = normalizedModel.slice(0, slashIndex).trim();
		const modelId = normalizedModel.slice(slashIndex + 1).trim();
		if (!modelProvider || !modelId) {
			return {
				error: `Effort "${effort.name}" has an invalid model spec: "${effort.model}".`,
			};
		}
		if (effort.provider && effort.provider !== modelProvider) {
			return {
				error: `Effort "${effort.name}" has provider "${effort.provider}" but model "${effort.model}" is qualified for provider "${modelProvider}".`,
			};
		}
		return { model: `${modelProvider}/${modelId}` };
	}

	if (effort.provider) {
		return { model: `${effort.provider}/${normalizedModel}` };
	}

	return { model: normalizedModel };
}

function resolveModelFromEffort(
	model: string | undefined,
	effortName: string | undefined,
	resources: ResourceDiscoveryResult,
): { model?: string; effort?: EffortConfig; error?: string } {
	if (model) return { model: normalizeLegacyModelName(model) };
	if (!effortName) return {};
	const effort = resources.efforts.find((candidate) => candidate.name === effortName);
	if (!effort) {
		return {
			error: `Unknown effort: "${effortName}". Available efforts: ${formatEffortList(resources)}.`,
		};
	}
	const resolvedModel = buildEffortModelSpec(effort);
	if (resolvedModel.error) return { error: resolvedModel.error };
	return { model: resolvedModel.model, effort };
}

function resolveWorkerConfig(
	step: TaskStepConfig,
	resources: ResourceDiscoveryResult,
	options: { requireBehavior?: boolean; context?: "task" | "main" } = {},
): { config?: ResolvedWorkerConfig; error?: string } {
	const context = options.context ?? "task";
	const agent = step.agent ? resources.agents.find((candidate) => candidate.name === step.agent) : undefined;
	if (step.agent) {
		if (!agent) {
			return {
				error:
					context === "main"
						? `Unknown agent: "${step.agent}". Available main-session agents: ${formatMainSessionAgentList(resources.agents)}.`
						: `Unknown agent: "${step.agent}". Available task agents: ${formatCallableAgentList(resources)}.`,
			};
		}
		if (!agent.enabled) return { error: `Agent "${step.agent}" is disabled.` };
		if (context === "task" && agent.availability === "main") {
			return {
				error: `Agent "${step.agent}" is not task-callable (availability: main).`,
			};
		}
		if (context === "main" && agent.availability === "task") {
			return {
				error: `Agent "${step.agent}" is not main-session callable (availability: task).`,
			};
		}
	}

	const profileName = step.profile ?? agent?.defaultProfile;
	const profile = profileName ? resources.profiles.find((candidate) => candidate.name === profileName) : undefined;
	if (profileName) {
		if (!profile) {
			return {
				error: `Unknown profile: "${profileName}". Available profiles: ${formatProfileList(resources)}.`,
			};
		}
		if (!profile.enabled) return { error: `Profile "${profileName}" is disabled.` };
	}

	const resolvedModel = resolveModelFromEffort(
		step.model ?? agent?.model,
		step.effort ?? agent?.defaultEffort,
		resources,
	);
	if (resolvedModel.error) return { error: resolvedModel.error };

	const skills = step.skills ?? agent?.defaultSkills;
	const prompt = composePromptLayers(profile?.systemPrompt ?? "", agent?.systemPrompt ?? "", step.prompt ?? "");
	const tools = agent?.tools ?? profile?.tools;
	const excludeTools = agent?.excludeTools ?? profile?.excludeTools;
	const systemPromptMode = agent?.systemPromptMode ?? profile?.systemPromptMode ?? "append";
	const displayAgentName = agent?.name ?? "generic";

	const globalTaskDefaults = resources.globalTasksConfig;
	const projectTaskDefaults = resources.projectTasksConfig;

	const agentContextMode = agent?.context?.mode;
	const profileContextMode = profile?.context?.mode;
	const agentContextProject = firstDefined(agent?.context?.project, agent?.inheritProjectContext);
	const profileContextProject = firstDefined(profile?.context?.project, profile?.inheritProjectContext);
	const agentContextSkills = firstDefined(agent?.context?.skills, agent?.inheritSkills);
	const profileContextSkills = firstDefined(profile?.context?.skills, profile?.inheritSkills);
	const agentPersist = agent?.persist;
	const profilePersist = profile?.persist;

	const modeCandidates: Array<{
		source: string;
		mode?: ContextMode;
		invalidModeValue?: unknown;
		invalidShapeValue?: unknown;
	}> = [
		{
			source: "runtime step context",
			mode: step.context,
		},
	];
	if (agent) {
		modeCandidates.push({
			source: `agent "${agent.name}" (${agent.source})`,
			mode: agentContextMode,
			invalidModeValue: agent.context?.invalidModeValue,
			invalidShapeValue: agent.context?.invalidShapeValue,
		});
	}
	if (profile) {
		modeCandidates.push({
			source: `profile "${profile.name}" (${profile.source})`,
			mode: profileContextMode,
			invalidModeValue: profile.context?.invalidModeValue,
			invalidShapeValue: profile.context?.invalidShapeValue,
		});
	}
	if (projectTaskDefaults) {
		modeCandidates.push({
			source: `project tasks config (${projectTaskDefaults.filePath})`,
			mode: projectTaskDefaults.context?.mode,
			invalidModeValue: projectTaskDefaults.context?.invalidModeValue,
			invalidShapeValue: projectTaskDefaults.context?.invalidShapeValue,
		});
	}
	if (globalTaskDefaults) {
		modeCandidates.push({
			source: `global tasks config (${globalTaskDefaults.filePath})`,
			mode: globalTaskDefaults.context?.mode,
			invalidModeValue: globalTaskDefaults.context?.invalidModeValue,
			invalidShapeValue: globalTaskDefaults.context?.invalidShapeValue,
		});
	}

	let effectiveContextMode: ContextMode = "fresh";
	for (const candidate of modeCandidates) {
		if (context === "task" && candidate.invalidShapeValue !== undefined) {
			let rendered = "";
			if (typeof candidate.invalidShapeValue === "string") rendered = candidate.invalidShapeValue;
			else {
				try {
					rendered = JSON.stringify(candidate.invalidShapeValue) ?? String(candidate.invalidShapeValue);
				} catch {
					rendered = String(candidate.invalidShapeValue);
				}
			}
			return {
				error: `Invalid context from ${candidate.source}: "${rendered}". Expected an object with optional keys "mode", "project", and "skills".`,
			};
		}
		if (candidate.mode === "fresh" || candidate.mode === "fork") {
			effectiveContextMode = candidate.mode;
			break;
		}
		if (context === "task" && candidate.invalidModeValue !== undefined) {
			let rendered = "";
			if (typeof candidate.invalidModeValue === "string") rendered = candidate.invalidModeValue;
			else {
				try {
					rendered = JSON.stringify(candidate.invalidModeValue) ?? String(candidate.invalidModeValue);
				} catch {
					rendered = String(candidate.invalidModeValue);
				}
			}
			return {
				error: `Invalid context.mode from ${candidate.source}: "${rendered}". Expected "fresh" or "fork".`,
			};
		}
	}

	const effectiveContextProject =
		firstDefined(
			agentContextProject,
			profileContextProject,
			projectTaskDefaults?.context?.project,
			globalTaskDefaults?.context?.project,
		) ?? false;
	const effectiveContextSkills =
		firstDefined(
			agentContextSkills,
			profileContextSkills,
			projectTaskDefaults?.context?.skills,
			globalTaskDefaults?.context?.skills,
		) ?? false;
	const effectivePersist =
		firstDefined(agentPersist, profilePersist, projectTaskDefaults?.persist, globalTaskDefaults?.persist) ?? true;

	const inheritProjectContext = agent?.inheritProjectContext ?? profile?.inheritProjectContext ?? false;
	const inheritSkills = agent?.inheritSkills ?? profile?.inheritSkills ?? false;
	const allowDelegation = agent?.allowDelegation ?? profile?.allowDelegation ?? false;
	const interactive = step.interactive ?? agent?.interactive ?? profile?.interactive ?? false;

	if ((options.requireBehavior ?? true) && !agent && !prompt.trim()) {
		return { error: formatGenericWorkerBehaviorError(resources) };
	}

	return {
		config: {
			agent,
			profile,
			effort: resolvedModel.effort,
			model: resolvedModel.model,
			skills,
			tools,
			excludeTools,
			context: {
				mode: effectiveContextMode,
				project: effectiveContextProject,
				skills: effectiveContextSkills,
			},
			persist: effectivePersist,
			inheritProjectContext,
			inheritSkills,
			allowDelegation,
			interactive,
			systemPrompt: prompt,
			systemPromptMode,
			displayAgentName,
		},
	};
}

interface MainSessionBaseline {
	sessionId: string;
	model?: { provider: string; id: string };
	thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	tools: string[];
}

interface PersistedMainAgentState {
	found: boolean;
	agent?: string;
	profile?: string;
	effort?: string;
}

let mainSessionBaseline: MainSessionBaseline | undefined;
let activeMainWorker: ResolvedWorkerConfig | undefined;
let startupCompositionError: string | undefined;
interface TaskProjectTrustState {
	canonicalCwd: string;
	sessionId?: string;
	projectResourcesPresent: boolean;
	trusted: boolean;
}

let taskProjectTrustState: TaskProjectTrustState | undefined;

function canonicalizeTaskProjectCwd(cwd: string): string {
	try {
		return fs.realpathSync(cwd);
	} catch {
		return path.resolve(cwd);
	}
}

function getProjectTrustOverride(): boolean | undefined {
	let override: boolean | undefined;
	for (const argument of process.argv) {
		if (argument === "--approve" || argument === "-a") override = true;
		if (argument === "--no-approve" || argument === "-na") override = false;
	}
	return override;
}

async function resolveTaskProjectTrust(ctx: {
	cwd: string;
	hasUI: boolean;
	isProjectTrusted?: () => boolean;
	ui: { confirm(title: string, message: string): Promise<boolean> };
}): Promise<boolean> {
	const canonicalCwd = canonicalizeTaskProjectCwd(ctx.cwd);
	const coreTrusted = ctx.isProjectTrusted?.() === true;
	if (!hasProjectTaskResources(canonicalCwd)) return coreTrusted;
	if (hasTrustRequiringProjectResources(canonicalCwd)) return coreTrusted;

	const override = getProjectTrustOverride();
	if (override !== undefined) return override;
	const trustStore = new ProjectTrustStore(getAgentDir());
	const saved = trustStore.get(canonicalCwd);
	if (saved !== null) return saved;
	if (!ctx.hasUI) return false;

	const trusted = await ctx.ui.confirm(
		"Trust project configuration?",
		[
			`Task agents, profiles, or defaults were found for ${canonicalCwd}.`,
			"Project configuration is repository-controlled and can change worker prompts, tools, models, and context access.",
			"Trust all project-local configuration in this directory?",
		].join("\n\n"),
	);
	trustStore.set(canonicalCwd, trusted);
	return trusted;
}

function isTaskProjectTrusted(ctx: {
	cwd: string;
	isProjectTrusted?: () => boolean;
	sessionManager?: { getSessionId?: () => string };
}): boolean {
	if (ctx.isProjectTrusted?.() !== true) return false;
	const canonicalCwd = canonicalizeTaskProjectCwd(ctx.cwd);
	if (!hasProjectTaskResources(canonicalCwd)) return true;
	const state = taskProjectTrustState;
	return (
		state !== undefined &&
		state.canonicalCwd === canonicalCwd &&
		state.sessionId === ctx.sessionManager?.getSessionId?.() &&
		state.projectResourcesPresent &&
		state.trusted
	);
}

function isMainSessionCallableAgent(agent: AgentConfig): boolean {
	return agent.enabled && (agent.availability === "main" || agent.availability === "both");
}

function getMainSessionCallableAgents(agents: AgentConfig[]): AgentConfig[] {
	return agents.filter(isMainSessionCallableAgent);
}

function formatMainSessionAgentList(agents: AgentConfig[]): string {
	return (
		getMainSessionCallableAgents(agents)
			.map((agent) => `${agent.name} (${agent.source})`)
			.join(", ") || "none"
	);
}

function getCurrentModelRef(ctx: {
	model?: { provider: string; id: string };
}): { provider: string; id: string } | undefined {
	return ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
}

function ensureMainSessionBaseline(
	ctx: {
		model?: { provider: string; id: string };
		sessionManager: { getSessionId(): string };
	},
	piApi: Pick<ExtensionAPI, "getActiveTools" | "getThinkingLevel">,
): void {
	const sessionId = ctx.sessionManager.getSessionId();
	if (mainSessionBaseline?.sessionId === sessionId) return;
	mainSessionBaseline = {
		sessionId,
		model: getCurrentModelRef(ctx),
		thinkingLevel: piApi.getThinkingLevel(),
		tools: [...piApi.getActiveTools()],
	};
}

function parseAgentModelSpec(
	modelSpec: string,
	currentModel?: { provider: string; id: string },
): { provider: string; modelId: string } | undefined {
	const normalized = normalizeLegacyModelName(modelSpec)?.trim();
	if (!normalized) return undefined;
	const slashIndex = normalized.indexOf("/");
	if (slashIndex !== -1) {
		const provider = normalized.slice(0, slashIndex).trim();
		const modelId = normalized.slice(slashIndex + 1).trim();
		if (provider && modelId) return { provider, modelId };
		return undefined;
	}
	if (!currentModel?.provider) return undefined;
	return { provider: currentModel.provider, modelId: normalized };
}

/** Resolves the worker's own effective project trust: gated by the outer trust plus the worker's context/inherit settings, mirroring the old `--approve`/`--no-approve` CLI logic. */
function resolveWorkerProjectTrust(
	worker: Pick<ResolvedWorkerConfig, "context" | "inheritProjectContext">,
	projectTrusted: boolean,
): boolean {
	return projectTrusted && (worker.context.project || worker.inheritProjectContext);
}

/** Translates a resolved worker config into the tool/skill fields of a WorkerSessionSpec, mirroring the old --tools/--no-tools/--exclude-tools/--no-skills/--skill CLI flag logic. */
function buildWorkerSessionSpec(
	worker: Pick<
		ResolvedWorkerConfig,
		| "displayAgentName"
		| "tools"
		| "excludeTools"
		| "allowDelegation"
		| "skills"
		| "context"
		| "inheritProjectContext"
	>,
	launchCwd: string,
	projectTrusted: boolean,
): {
	tools?: string[];
	excludeTools?: string[];
	noContextFiles: boolean;
	additionalSkillPaths?: string[];
	noSkills: boolean;
	error?: string;
} {
	const noContextFiles = !worker.inheritProjectContext;

	if (worker.skills === undefined) {
		return {
			tools: worker.tools,
			excludeTools: worker.excludeTools,
			noContextFiles,
			noSkills: !worker.context.skills,
		};
	}
	if (worker.skills.length === 0) {
		return { tools: worker.tools, excludeTools: worker.excludeTools, noContextFiles, noSkills: true };
	}
	const { paths, missing } = resolveSkillPaths(worker.skills, launchCwd, projectTrusted, discoveredSkills);
	if (missing.length > 0) {
		return {
			noContextFiles,
			noSkills: true,
			error: `Failed to resolve required skills for worker "${worker.displayAgentName}": ${missing.join(", ")}.`,
		};
	}
	return {
		tools: worker.tools,
		excludeTools: worker.excludeTools,
		noContextFiles,
		additionalSkillPaths: paths,
		noSkills: true,
	};
}

function getPersistedMainAgentState(entries: SessionEntry[]): PersistedMainAgentState {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || (entry as { type?: unknown }).type !== "custom") continue;
		const customEntry = entry as { customType?: unknown; data?: unknown };
		if (customEntry.customType !== MAIN_SESSION_AGENT_CUSTOM_TYPE) continue;
		const data = (customEntry.data ?? {}) as Record<string, unknown>;
		return {
			found: true,
			agent: typeof data.agent === "string" ? data.agent : undefined,
			profile: typeof data.profile === "string" ? data.profile : undefined,
			effort: typeof data.effort === "string" ? data.effort : undefined,
		};
	}
	return { found: false };
}

function persistMainAgentSelection(
	ctx: {
		sessionManager: {
			getBranch(): SessionEntry[];
			appendCustomEntry?: (customType: string, data?: unknown) => string;
		};
	},
	state: { agent?: string; profile?: string; effort?: string },
): void {
	const current = getPersistedMainAgentState(ctx.sessionManager.getBranch());
	if (
		current.found &&
		current.agent === state.agent &&
		current.profile === state.profile &&
		current.effort === state.effort
	)
		return;
	ctx.sessionManager.appendCustomEntry?.(MAIN_SESSION_AGENT_CUSTOM_TYPE, {
		agent: state.agent ?? null,
		profile: state.profile ?? null,
		effort: state.effort ?? null,
	});
}

function syncRuntimeEnv(piApi: Pick<ExtensionAPI, "getFlag">, state: { agent?: string; profile?: string }): void {
	const explicitAgent = piApi.getFlag("agent-name");
	if (!(typeof explicitAgent === "string" && explicitAgent.length > 0)) {
		if (state.agent) process.env.PI_AGENT_NAME = state.agent;
		else delete process.env.PI_AGENT_NAME;
	}
	const explicitProfile = piApi.getFlag("profile-name");
	if (!(typeof explicitProfile === "string" && explicitProfile.length > 0)) {
		if (state.profile) process.env.PI_PROFILE_NAME = state.profile;
		else delete process.env.PI_PROFILE_NAME;
	}
}

async function restoreMainSessionBaseline(
	ctx: {
		cwd: string;
		model?: { provider: string; id: string };
		modelRegistry: { find(provider: string, modelId: string): unknown };
	},
	piApi: Pick<ExtensionAPI, "setModel" | "setActiveTools" | "setThinkingLevel">,
): Promise<string | undefined> {
	if (!mainSessionBaseline) return undefined;
	if (mainSessionBaseline.model) {
		const baselineModel = ctx.modelRegistry.find(
			mainSessionBaseline.model.provider,
			mainSessionBaseline.model.id,
		) as { provider: string; id: string } | undefined;
		if (!baselineModel) {
			return `Baseline model not found: ${mainSessionBaseline.model.provider}/${mainSessionBaseline.model.id}.`;
		}
		const success = await piApi.setModel(baselineModel as never);
		if (!success) {
			return `No API key available for baseline model ${mainSessionBaseline.model.provider}/${mainSessionBaseline.model.id}.`;
		}
	}
	piApi.setThinkingLevel(mainSessionBaseline.thinkingLevel);
	piApi.setActiveTools([...mainSessionBaseline.tools]);
	return undefined;
}

async function applyMainSessionAgentSelection(
	ctx: {
		cwd: string;
		hasUI: boolean;
		ui: {
			confirm(title: string, message: string): Promise<boolean>;
			notify(message: string, level: "info" | "warning" | "error"): void;
		};
		model?: { provider: string; id: string };
		modelRegistry: { find(provider: string, modelId: string): unknown };
		sessionManager: {
			getSessionId(): string;
			getBranch(): SessionEntry[];
			appendCustomEntry?: (customType: string, data?: unknown) => string;
		};
		isProjectTrusted?: () => boolean;
	},
	piApi: Pick<
		ExtensionAPI,
		| "getAllTools"
		| "getActiveTools"
		| "getFlag"
		| "getThinkingLevel"
		| "setActiveTools"
		| "setModel"
		| "setThinkingLevel"
	>,
	selection: { agent?: string; profile?: string; effort?: string },
	options: { persist?: boolean; notify?: boolean } = {},
): Promise<{ ok: true; worker?: ResolvedWorkerConfig } | { ok: false; error: string }> {
	ensureMainSessionBaseline(ctx, piApi);
	const resources = discoverResources(ctx.cwd, "both", isTaskProjectTrusted(ctx));

	if (selection.agent) {
		const role = resources.agents.find((candidate) => candidate.name === selection.agent);
		if (!role) {
			return {
				ok: false,
				error: `Unknown agent: "${selection.agent}". Available main-session agents: ${formatMainSessionAgentList(resources.agents)}.`,
			};
		}
		if (!role.enabled) return { ok: false, error: `Agent "${selection.agent}" is disabled.` };
		if (role.availability === "task")
			return {
				ok: false,
				error: `Agent "${selection.agent}" is not main-session callable (availability: task).`,
			};
	}

	if (!selection.agent && !selection.profile && !selection.effort) {
		const restoreError = await restoreMainSessionBaseline(ctx, piApi);
		if (restoreError) return { ok: false, error: restoreError };
		activeMainWorker = undefined;
		syncRuntimeEnv(piApi, {});
		if (options.persist) persistMainAgentSelection(ctx, {});
		if (options.notify) ctx.ui.notify("Cleared main-session composition; restored session defaults.", "info");
		return { ok: true };
	}

	const resolved = resolveWorkerConfig(
		{
			agent: selection.agent,
			profile: selection.profile,
			effort: selection.effort,
			task: "main-session",
			prompt: undefined,
		},
		resources,
		{ requireBehavior: false, context: "main" },
	);
	if (resolved.error || !resolved.config) {
		return {
			ok: false,
			error: resolved.error ?? "Failed to resolve main-session worker configuration.",
		};
	}
	const worker = resolved.config;

	const allToolNames = new Set(piApi.getAllTools().map((tool) => tool.name));
	const configuredTools = [...(worker.tools ?? []), ...(worker.excludeTools ?? [])];
	const invalidTools = configuredTools.filter((tool) => !allToolNames.has(tool));
	if (invalidTools.length > 0) {
		return {
			ok: false,
			error: `Unknown tools in main-session composition: ${invalidTools.join(", ")}.`,
		};
	}

	if (worker.model) {
		const resolvedModel = parseAgentModelSpec(worker.model, ctx.model);
		if (!resolvedModel) {
			return {
				ok: false,
				error: `Could not resolve model for main session: ${worker.model}.`,
			};
		}
		const model = ctx.modelRegistry.find(resolvedModel.provider, resolvedModel.modelId) as
			| { provider: string; id: string }
			| undefined;
		if (!model)
			return {
				ok: false,
				error: `Model not found for main session: ${resolvedModel.provider}/${resolvedModel.modelId}.`,
			};
		const success = await piApi.setModel(model as never);
		if (!success)
			return {
				ok: false,
				error: `No API key available for model ${resolvedModel.provider}/${resolvedModel.modelId}.`,
			};
	} else {
		const restoreError = await restoreMainSessionBaseline(ctx, piApi);
		if (restoreError) return { ok: false, error: restoreError };
	}

	piApi.setThinkingLevel(worker.effort?.thinkingLevel ?? mainSessionBaseline?.thinkingLevel ?? "off");
	let activeTools: string[] | undefined;
	if (worker.tools !== undefined) activeTools = [...worker.tools];
	else if (worker.excludeTools !== undefined) activeTools = [...allToolNames];
	else if (mainSessionBaseline) activeTools = [...mainSessionBaseline.tools];
	if (activeTools && worker.excludeTools) {
		const excluded = new Set(worker.excludeTools);
		activeTools = activeTools.filter((tool) => !excluded.has(tool));
	}
	if (activeTools) piApi.setActiveTools(activeTools);

	activeMainWorker = worker;
	syncRuntimeEnv(piApi, {
		agent: worker.agent?.name,
		profile: worker.profile?.permissionsProfile ?? worker.profile?.name,
	});
	if (options.persist) persistMainAgentSelection(ctx, selection);
	if (options.notify) {
		ctx.ui.notify(
			`Main session: ${selection.agent ?? "generic"}${selection.profile ? ` + ${selection.profile}` : ""}${selection.effort ? ` + ${selection.effort}` : ""}`,
			"info",
		);
	}
	return { ok: true, worker };
}

interface PreparedTaskStep {
	step: number;
	rawStep: TaskStepConfig;
	worker: ResolvedWorkerConfig;
	launchCwd: string;
	projectTrusted: boolean;
	session: {
		mode: ContextMode;
		persist: boolean;
		sessionFile?: string;
		sessionId?: string;
		sessionName?: string;
		parentSessionFile?: string;
		parentSessionId?: string;
	};
}

interface PreparedTaskRun {
	mode: TaskExecutionMode;
	steps: PreparedTaskStep[];
	sessionRunId?: string;
}

function isTaskExecutionMode(value: unknown): value is TaskExecutionMode {
	return value === "single" || value === "parallel" || value === "chain";
}

function isContextMode(value: unknown): value is ContextMode {
	return value === "fresh" || value === "fork";
}

type TaskStepStringKey = "agent" | "profile" | "effort" | "cwd" | "model" | "prompt";

function copyLegacyStringField(record: Record<string, unknown>, step: TaskStepConfig, key: TaskStepStringKey): void {
	const value = record[key];
	if (typeof value === "string") step[key] = value;
}

function buildLegacySingleStep(record: Record<string, unknown>): TaskStepConfig | undefined {
	if (typeof record.task !== "string") return undefined;
	const step: TaskStepConfig = { task: record.task };
	for (const key of ["agent", "profile", "effort", "cwd", "model", "prompt"] as const) {
		copyLegacyStringField(record, step, key);
	}
	if (Array.isArray(record.skills) && record.skills.every((value) => typeof value === "string")) {
		step.skills = record.skills;
	}
	if (isContextMode(record.context)) step.context = record.context;
	return step;
}

function normalizeTaskToolParams(params: unknown): PreparedTaskToolParams {
	if (!params || typeof params !== "object") return { steps: [] };
	const record = params as Record<string, unknown>;
	const agentScope = record.agentScope as AgentScope | undefined;
	if (Array.isArray(record.steps)) {
		return {
			mode: record.mode as TaskExecutionMode | undefined,
			steps: record.steps as TaskStepConfig[],
			agentScope,
		};
	}
	if (Array.isArray(record.chain)) {
		return {
			mode: "chain",
			steps: record.chain as TaskStepConfig[],
			agentScope,
		};
	}
	if (Array.isArray(record.tasks)) {
		return {
			mode: "parallel",
			steps: record.tasks as TaskStepConfig[],
			agentScope,
		};
	}
	const legacyStep = buildLegacySingleStep(record);
	if (legacyStep) return { mode: "single", steps: [legacyStep], agentScope };
	return {
		mode: record.mode as TaskExecutionMode | undefined,
		steps: [],
		agentScope,
	};
}

function prepareTaskToolArguments(args: unknown): PreparedTaskToolParams {
	return normalizeTaskToolParams(args);
}

function hasRuntimePersistOverride(params: unknown): boolean {
	if (!params || typeof params !== "object") return false;
	const record = params as Record<string, unknown>;
	if (Object.prototype.hasOwnProperty.call(record, "persist")) return true;
	const arrays = [record.steps, record.tasks, record.chain];
	for (const value of arrays) {
		if (!Array.isArray(value)) continue;
		for (const item of value) {
			if (item && typeof item === "object" && Object.prototype.hasOwnProperty.call(item, "persist")) return true;
		}
	}
	return false;
}

function hasPreviousPlaceholder(task: string): boolean {
	return /\{previous\}/.test(task);
}

function createTaskRunId(): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `${timestamp}_${randomUUID().slice(0, 8)}`;
}

function readSessionHeaderStringField(
	entries: readonly SessionEntry[],
	field: "id" | "parentSession",
): string | undefined {
	const header = entries.find((entry) => (entry as { type?: unknown }).type === "session") as
		| (SessionEntry & { id?: unknown; parentSession?: unknown })
		| undefined;
	if (!header) return undefined;
	const value = header[field];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readSessionHeaderId(entries: SessionEntry[]): string | undefined {
	return readSessionHeaderStringField(entries, "id");
}

function readSessionHeaderParentSession(entries: SessionEntry[]): string | undefined {
	return readSessionHeaderStringField(entries, "parentSession");
}

function resolveSessionReferencePath(referencePath: string, baseFilePath: string): string {
	const trimmedReference = referencePath.trim();
	if (path.isAbsolute(trimmedReference)) return path.resolve(trimmedReference);
	return path.resolve(path.dirname(baseFilePath), trimmedReference);
}

interface ResolvedParentSession {
	parentSessionPath: string;
	source: "header";
}

async function resolveParentSessionForCurrentSession(
	currentSessionFile: string,
	entries: SessionEntry[],
): Promise<{
	resolved?: ResolvedParentSession;
	error?: string;
	noParent?: boolean;
}> {
	const headerParentSession = readSessionHeaderParentSession(entries);
	if (headerParentSession) {
		const parentSessionPath = resolveSessionReferencePath(headerParentSession, currentSessionFile);
		const validation = validateTaskSessionReference(parentSessionPath);
		if (validation.error || !validation.reference) {
			return { error: `Invalid parent session reference: ${validation.error ?? "unknown validation error"}` };
		}
		if (validation.reference.path === fs.realpathSync(currentSessionFile)) {
			return { error: "Invalid parent session reference: session references itself." };
		}
		return { resolved: { parentSessionPath: validation.reference.path, source: "header" } };
	}

	let fileReadError: string | undefined;
	try {
		const fileHeaderParentSession = readSessionHeaderParentSession(readSessionEntriesFromFile(currentSessionFile));
		if (fileHeaderParentSession) {
			const parentSessionPath = resolveSessionReferencePath(fileHeaderParentSession, currentSessionFile);
			const validation = validateTaskSessionReference(parentSessionPath);
			if (validation.error || !validation.reference) {
				return { error: `Invalid parent session reference: ${validation.error ?? "unknown validation error"}` };
			}
			if (validation.reference.path === fs.realpathSync(currentSessionFile)) {
				return { error: "Invalid parent session reference: session references itself." };
			}
			return { resolved: { parentSessionPath: validation.reference.path, source: "header" } };
		}
	} catch (error) {
		fileReadError = error instanceof Error ? error.message : String(error);
	}

	return {
		noParent: true,
		error: fileReadError
			? `Current session has no parentSession header in memory, and the session file could not be read: ${fileReadError}`
			: "Current session has no parentSession header, so a parent session cannot be resolved automatically.",
	};
}

function createSessionEntryId(): string {
	return randomUUID().slice(0, 8);
}

function buildTaskChildSessionName(agentLabel: string, task: string): string {
	const preview = createTaskPreview(task, 48);
	return `task: ${agentLabel} · ${preview}`;
}

async function appendRawSessionEntries(filePath: string, entries: Array<Record<string, unknown>>): Promise<void> {
	if (entries.length === 0) return;
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.appendFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
	});
}

async function seedFreshTaskSessionFile(params: {
	filePath: string;
	sessionId: string;
	childCwd: string;
	parentSessionFile?: string;
	sessionName: string;
}): Promise<void> {
	const timestamp = new Date().toISOString();
	const sessionInfoId = createSessionEntryId();
	const lines = [
		{
			type: "session",
			version: TASK_SESSION_VERSION_FALLBACK,
			id: params.sessionId,
			timestamp,
			cwd: params.childCwd,
			parentSession: params.parentSessionFile,
		},
		{
			type: "session_info",
			id: sessionInfoId,
			parentId: null,
			timestamp,
			name: params.sessionName,
		},
	];
	await withFileMutationQueue(params.filePath, async () => {
		await fs.promises.writeFile(params.filePath, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
			encoding: "utf-8",
			mode: 0o600,
			flag: "wx",
		});
	});
}

async function createManagedFreshTaskSession(params: {
	childCwd: string;
	parentSessionFile?: string;
	sessionName: string;
}): Promise<{ sessionId: string; sessionFile: string }> {
	const manager = SessionManager.create(params.childCwd);
	const sessionFile = manager.getSessionFile();
	const sessionId = manager.getSessionId();
	if (!sessionFile) throw new Error("Pi did not allocate a persisted session file for the child task.");
	await seedFreshTaskSessionFile({
		filePath: sessionFile,
		sessionId,
		childCwd: params.childCwd,
		parentSessionFile: params.parentSessionFile,
		sessionName: params.sessionName,
	});
	return { sessionId, sessionFile };
}

async function createManagedForkedTaskSession(params: {
	parentSessionFile: string;
	childCwd: string;
	sessionName: string;
}): Promise<{ sessionId: string; sessionFile: string }> {
	const manager = SessionManager.forkFrom(params.parentSessionFile, params.childCwd);
	const sessionFile = manager.getSessionFile();
	const sessionId = manager.getSessionId();
	if (!sessionFile) throw new Error("Pi did not allocate a persisted fork session file for the child task.");

	const timestamp = new Date().toISOString();
	const leafId = manager.getLeafId();
	const compositionResetId = createSessionEntryId();
	const sessionInfoId = createSessionEntryId();
	await appendRawSessionEntries(sessionFile, [
		{
			type: "custom",
			id: compositionResetId,
			parentId: leafId ?? null,
			timestamp,
			customType: MAIN_SESSION_AGENT_CUSTOM_TYPE,
			data: { agent: null, profile: null, effort: null },
		},
		{
			type: "session_info",
			id: sessionInfoId,
			parentId: compositionResetId,
			timestamp,
			name: params.sessionName,
		},
	]);
	return { sessionId, sessionFile };
}

async function preflightTaskRun(
	mode: TaskExecutionMode,
	steps: TaskStepConfig[],
	resources: ResourceDiscoveryResult,
	defaultCwd: string,
	sessionManager: {
		getSessionFile?: () => string | undefined;
		getSessionId?: () => string;
		getBranch(): SessionEntry[];
	},
	projectTrusted = false,
): Promise<{ prepared?: PreparedTaskRun; error?: string }> {
	const preparedSteps: PreparedTaskStep[] = [];
	if (!projectTrusted && resources.projectTasksConfig) {
		return { error: "Project task resources require a trusted project." };
	}
	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		if (!step) return { error: `Invalid missing step at position ${i + 1}.` };
		if (step.context !== undefined && step.context !== "fresh" && step.context !== "fork") {
			return {
				error: `Invalid context.mode at step ${i + 1}: "${String(step.context)}". Expected "fresh" or "fork".`,
			};
		}
		const resolved = resolveWorkerConfig(step, resources);
		if (resolved.error || !resolved.config) {
			return {
				error: `Step ${i + 1}: ${resolved.error ?? "Failed to resolve task worker."}`,
			};
		}
		const worker = resolved.config;
		if (
			!projectTrusted &&
			(worker.agent?.source === "project" ||
				worker.profile?.source === "project" ||
				worker.effort?.source === "project")
		) {
			return {
				error: `Step ${i + 1}: Project task resources require a trusted project.`,
			};
		}
		if (worker.context.mode !== "fresh" && worker.context.mode !== "fork") {
			return {
				error: `Invalid effective context.mode at step ${i + 1}: "${String(worker.context.mode)}". Expected "fresh" or "fork".`,
			};
		}
		if (worker.context.mode === "fork" && !worker.persist) {
			return {
				error: `Step ${i + 1} requests context.mode="fork" with effective persist=false. Fork requires persisted sessions.`,
			};
		}
		preparedSteps.push({
			step: i + 1,
			rawStep: step,
			worker,
			launchCwd: step.cwd ?? defaultCwd,
			projectTrusted: projectTrusted && step.cwd === undefined,
			session: {
				mode: worker.context.mode,
				persist: worker.persist,
			},
		});
	}

	const needsPersistedSessions = preparedSteps.some((step) => step.session.persist);
	const needsFork = preparedSteps.some((step) => step.session.mode === "fork");

	let parentSessionFile: string | undefined;
	let parentSessionId: string | undefined;
	let parentBranch: SessionEntry[] | undefined;
	if (needsPersistedSessions || needsFork) {
		parentSessionFile = sessionManager.getSessionFile?.();
		parentBranch = sessionManager.getBranch();
		parentSessionId = sessionManager.getSessionId?.() ?? readSessionHeaderId(parentBranch);
		if (!parentSessionId && parentSessionFile) {
			try {
				parentSessionId = readSessionHeaderId(readSessionEntriesFromFile(parentSessionFile));
			} catch {
				// Session creation can continue without optional parent identity metadata.
			}
		}
	}
	if (needsFork) {
		if (!parentSessionFile) {
			return {
				error: 'context.mode="fork" requires a parent session file, but the current session is unavailable.',
			};
		}
	}

	const sessionRunId = needsPersistedSessions ? createTaskRunId() : undefined;
	for (const preparedStep of preparedSteps) {
		if (!preparedStep.session.persist) continue;
		preparedStep.session.sessionName = buildTaskChildSessionName(
			preparedStep.worker.displayAgentName,
			preparedStep.rawStep.task,
		);
		preparedStep.session.parentSessionFile = parentSessionFile;
		preparedStep.session.parentSessionId = parentSessionId;
	}

	return {
		prepared: {
			mode,
			steps: preparedSteps,
			sessionRunId,
		},
	};
}

/** Shared by all three transports: folds one assistant message's usage/model/stop info into a SingleResult. */
function accumulateAssistantMessageIntoResult(result: SingleResult, message: Message): void {
	if (message.role !== "assistant") return;
	result.usage.turns++;
	const usage = message.usage;
	if (usage) {
		result.usage.input += usage.input || 0;
		result.usage.output += usage.output || 0;
		result.usage.cacheRead += usage.cacheRead || 0;
		result.usage.cacheWrite += usage.cacheWrite || 0;
		result.usage.cost += usage.cost?.total || 0;
		result.usage.contextTokens = usage.totalTokens || 0;
	}
	if (!result.model && message.model) result.model = message.model;
	if (message.stopReason) result.stopReason = message.stopReason;
	if (message.errorMessage) result.errorMessage = message.errorMessage;
}

/**
 * Runs a delegated task step as a real, in-process AgentSession (see task-agent-session.ts) --
 * the same session type, the same prompt()/steer()/subscribe() primitives, that a normal
 * interactive pi session uses. No subprocess, no pty, no RPC-over-pipes protocol: this is the
 * single execution path for every task step (single/parallel/chain, persisted or ephemeral).
 * While the step runs, a LiveTaskController is registered (task-live.ts) so /tasks steer and
 * resumeSessionId can reach the same session directly -- and because it's the same session, the
 * result that flows back to the parent when this function returns is the real, final
 * transcript, not a side channel.
 */
async function runSingleAgentViaAgentSession(
	preparedStep: PreparedTaskStep,
	task: string,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => TaskDetails,
	initialChildSession: ChildSessionSnapshot | undefined,
	toolCallId: string,
	runId: string,
	parentCtx: Pick<ExtensionContext, "ui" | "hasUI" | "modelRegistry">,
): Promise<SingleResult> {
	const worker = preparedStep.worker;
	const agent = worker.agent;
	const agentModel = worker.model;

	const baseResult = (overrides: Partial<SingleResult> = {}): SingleResult => ({
		agent: worker.displayAgentName,
		agentSource: agent?.source ?? "unknown",
		profile: worker.profile?.name,
		effort: worker.effort?.name,
		skills: worker.skills,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agentModel,
		step,
		sessionMode: preparedStep.session.mode,
		sessionPersist: preparedStep.session.persist,
		sessionFile: preparedStep.session.sessionFile,
		childSession: initialChildSession ? { ...initialChildSession } : undefined,
		uiNotices: [],
		...overrides,
	});

	if (preparedStep.session.persist && !preparedStep.session.sessionFile) {
		return baseResult({ exitCode: 1, stderr: "Missing child session file for persisted task step." });
	}

	const toolAndSkillSpec = buildWorkerSessionSpec(worker, preparedStep.launchCwd, preparedStep.projectTrusted);
	if (toolAndSkillSpec.error) return baseResult({ exitCode: 1, stderr: toolAndSkillSpec.error });

	let composedSystemPrompt: string;
	try {
		composedSystemPrompt = await prepareWorkerSystemPrompt(
			worker,
			preparedStep.launchCwd,
			preparedStep.projectTrusted,
		);
	} catch (error) {
		return baseResult({ exitCode: 1, stderr: error instanceof Error ? error.message : String(error) });
	}

	// Tracks the worker's own task_complete/ask_caller tool calls -- "completed" is sticky (a
	// later ask_caller in the same turn can't un-finish an already-finished worker), and a
	// natural turn-end with neither call is treated the same as an explicit ask_caller for
	// interactive workers (see the keepAlive check below), so it stays undefined here.
	let controlOutcome: { type: "completed"; summary: string } | { type: "ping"; message: string } | undefined;
	const controlSignal: WorkerControlSignal = {
		onComplete: (summary) => {
			controlOutcome = { type: "completed", summary };
		},
		onPing: (message) => {
			if (controlOutcome?.type !== "completed") controlOutcome = { type: "ping", message };
		},
	};

	const controllerKey = makeTaskRunStepKey(runId, step ?? 0);
	const controllerIdentity = { key: controllerKey, agent: worker.displayAgentName, step: step ?? 0 };
	const relayedKeys = { status: new Set<string>(), widget: new Set<string>() };

	const { session, error: sessionError } = await createWorkerAgentSession({
		cwd: preparedStep.launchCwd,
		modelRegistry: parentCtx.modelRegistry,
		systemPrompt: composedSystemPrompt,
		systemPromptMode: worker.systemPromptMode,
		model: agentModel,
		thinkingLevel: worker.effort?.thinkingLevel,
		tools: toolAndSkillSpec.tools,
		excludeTools: toolAndSkillSpec.excludeTools,
		allowDelegation: worker.allowDelegation,
		projectTrusted: resolveWorkerProjectTrust(worker, preparedStep.projectTrusted),
		noContextFiles: toolAndSkillSpec.noContextFiles,
		noSkills: toolAndSkillSpec.noSkills,
		additionalSkillPaths: toolAndSkillSpec.additionalSkillPaths,
		sessionFile: preparedStep.session.sessionFile,
		agentName: worker.agent?.name,
		profileName: worker.profile?.permissionsProfile ?? worker.profile?.name,
		controlSignal,
		onUiRequest: parentCtx.hasUI
			? (event, respond) =>
					relayTaskExtensionUiRequest({
						event,
						controller: controllerIdentity,
						parentUi: parentCtx.ui,
						relayedKeys,
						respond,
					})
			: undefined,
	});
	if (sessionError || !session) {
		return baseResult({ exitCode: 1, stderr: sessionError ?? "Failed to create worker session." });
	}

	const currentResult = baseResult({ sessionId: session.sessionManager.getSessionId() });
	const emitUpdate = () => {
		if (!onUpdate) return;
		onUpdate({
			content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
			details: makeDetails([currentResult]),
		});
	};

	const unsubscribeMessages = session.subscribe((event) => {
		if (event.type === "extension_error") {
			addTaskInlineNotice(currentResult, `Extension error (${event.extensionPath}): ${event.error}`, "warning");
			return;
		}
		if (event.type !== "message_end") return;
		const message = event.message as Message;
		if (message.role !== "assistant" && message.role !== "toolResult") return;
		if (!pushBoundedMessage(currentResult.messages, message)) {
			currentResult.errorMessage ??= "Child message output exceeded the parent memory limit.";
		}
		accumulateAssistantMessageIntoResult(currentResult, message);
		emitUpdate();
	});

	const controller = registerAgentSessionController({
		key: controllerKey,
		toolCallId,
		runId,
		step: step ?? 0,
		childSessionId: initialChildSession?.childSessionId ?? session.sessionManager.getSessionId(),
		childSessionPath: initialChildSession?.childSessionPath ?? session.sessionManager.getSessionFile() ?? "",
		parentSessionPath: initialChildSession?.parentSessionPath,
		task,
		agent: worker.displayAgentName,
		session,
		controlSignal,
		interactive: worker.interactive,
		close: async () => {
			session.dispose();
		},
	});

	let aborted = false;
	const onAbort = () => {
		aborted = true;
		controller.status = "aborted";
		void session.abort();
	};
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		await session.prompt(`Task: ${task}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		currentResult.exitCode = aborted ? 130 : 1;
		currentResult.stderr = currentResult.stderr ? `${currentResult.stderr}\n${message}` : message;
		currentResult.errorMessage ??= aborted ? "Task was aborted" : message;
		if (aborted) currentResult.stopReason = "aborted";
	} finally {
		if (signal) signal.removeEventListener("abort", onAbort);
		unsubscribeMessages();
	}

	await finalizeWorkerRun({
		controller,
		currentResult,
		aborted,
		interactive: worker.interactive,
		controlOutcome,
		parentCtx,
		relayedKeys,
	});
	return currentResult;
}

type ControlOutcome = { type: "completed"; summary: string } | { type: "ping"; message: string } | undefined;

/**
 * Shared tail for both a fresh worker run and a resumeSessionId continuation: folds the
 * task_complete/ask_caller outcome into the result, then either disposes the controller
 * (finished, or aborted) or leaves it registered and the session alive (interactive worker that
 * paused without calling task_complete) -- so a later resumeSessionId can find and continue it.
 */
async function finalizeWorkerRun(params: {
	controller: LiveTaskController;
	currentResult: SingleResult;
	aborted: boolean;
	interactive: boolean;
	controlOutcome: ControlOutcome;
	parentCtx: Pick<ExtensionContext, "ui" | "hasUI">;
	relayedKeys: { status: Set<string>; widget: Set<string> };
}): Promise<void> {
	const { controller, currentResult, aborted, interactive, controlOutcome, parentCtx, relayedKeys } = params;

	if (controlOutcome?.type === "completed") {
		currentResult.completionSummary = controlOutcome.summary;
		currentResult.stopReason ??= "completed";
	} else if (controlOutcome?.type === "ping") {
		currentResult.pendingQuestion = controlOutcome.message;
	}

	// An interactive worker only truly finishes via task_complete -- a natural turn-end or an
	// ask_caller ping just pauses it, so its session stays alive and its controller stays
	// registered (resumable via resumeSessionId or /tasks open) instead of being disposed.
	const keepAlive = !aborted && interactive && currentResult.exitCode === 0 && controlOutcome?.type !== "completed";
	if (keepAlive) {
		currentResult.awaitingReply = true;
		currentResult.stopReason ??= "waiting";
	} else {
		controller.status = aborted ? "aborted" : currentResult.exitCode === 0 ? "completed" : "failed";
		controller.finishedAt = new Date().toISOString();
		clearRelayedTaskUi(parentCtx.hasUI ? parentCtx.ui : undefined, relayedKeys);
		await controller.close();
		deleteLiveTaskController(controller.key);
	}

	if (aborted) {
		currentResult.stopReason = "aborted";
		if (!currentResult.errorMessage) currentResult.errorMessage = "Task was aborted";
		if (currentResult.exitCode === 0) currentResult.exitCode = 130;
	}
}

/**
 * Continues a worker that's still live -- either idle (kept alive after ask_caller or a natural
 * pause) or mid-turn (someone else is already awaiting it). Idle: rebinds the controller's
 * control signal to a fresh tracker, prompts it with the new task text, and finalizes exactly
 * like a fresh run once that turn settles. Mid-turn: just steers the text in and returns --
 * whoever is already awaiting that turn will deliver its own pingback, so starting a second
 * wait here would just race it.
 */
async function resumeWorkerRun(params: {
	controller: LiveTaskController;
	task: string;
	signal: AbortSignal | undefined;
	parentCtx: Pick<ExtensionContext, "ui" | "hasUI">;
}): Promise<SingleResult> {
	const { controller, task, signal, parentCtx } = params;
	const session = controller.session;

	const currentResult: SingleResult = {
		agent: controller.agent,
		agentSource: "unknown",
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		sessionId: controller.childSessionId,
		uiNotices: [],
	};

	if (session.isStreaming) {
		await session.steer(task);
		currentResult.awaitingReply = true;
		currentResult.pendingQuestion = "Delivered while the worker's current turn was still running.";
		return currentResult;
	}

	let controlOutcome: ControlOutcome;
	controller.controlSignal.onComplete = (summary) => {
		controlOutcome = { type: "completed", summary };
	};
	controller.controlSignal.onPing = (message) => {
		if (controlOutcome?.type !== "completed") controlOutcome = { type: "ping", message };
	};

	const unsubscribeMessages = session.subscribe((event) => {
		if (event.type !== "message_end") return;
		const message = event.message as Message;
		if (message.role !== "assistant" && message.role !== "toolResult") return;
		if (!pushBoundedMessage(currentResult.messages, message)) {
			currentResult.errorMessage ??= "Child message output exceeded the parent memory limit.";
		}
		accumulateAssistantMessageIntoResult(currentResult, message);
	});

	let aborted = false;
	const onAbort = () => {
		aborted = true;
		controller.status = "aborted";
		void session.abort();
	};
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		await session.prompt(task);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		currentResult.exitCode = aborted ? 130 : 1;
		currentResult.stderr = message;
		currentResult.errorMessage ??= aborted ? "Task was aborted" : message;
		if (aborted) currentResult.stopReason = "aborted";
	} finally {
		if (signal) signal.removeEventListener("abort", onAbort);
		unsubscribeMessages();
	}

	await finalizeWorkerRun({
		controller,
		currentResult,
		aborted,
		interactive: controller.interactive,
		controlOutcome,
		parentCtx,
		relayedKeys: { status: new Set(), widget: new Set() },
	});
	return currentResult;
}

/** Finds a still-live worker to continue via resumeSessionId -- childSessionId is the session id
 * surfaced on any earlier SingleResult/pingback, regardless of whether that step was persisted. */
function findLiveWorkerBySessionId(sessionId: string): LiveTaskController | undefined {
	return listLiveTaskControllers().find(
		(controller) => controller.childSessionId === sessionId && isLiveController(controller),
	);
}

function appendTaskChildSessionMetadata(
	sessionManager: {
		getBranch?: () => readonly SessionEntry[];
		appendCustomEntry?: (customType: string, data?: unknown) => string;
	},
	snapshot: ChildSessionSnapshot,
): string | undefined {
	try {
		if (!sessionManager.appendCustomEntry)
			return `Session manager does not support ${TASK_CHILD_SESSION_CUSTOM_TYPE} metadata.`;
		sessionManager.appendCustomEntry(TASK_CHILD_SESSION_CUSTOM_TYPE, snapshot);
		return undefined;
	} catch (error) {
		return `Failed to append ${TASK_CHILD_SESSION_CUSTOM_TYPE} metadata: ${error instanceof Error ? error.message : String(error)}`;
	}
}

async function runTaskStepWithMetadata(options: {
	preparedStep: PreparedTaskStep;
	task: string;
	mode: TaskExecutionMode;
	step: number;
	toolCallId: string;
	runId?: string;
	signal: AbortSignal | undefined;
	onUpdate: OnUpdateCallback | undefined;
	makeDetails: (results: SingleResult[]) => TaskDetails;
	sessionManager: {
		getBranch?: () => readonly SessionEntry[];
		appendCustomEntry?: (customType: string, data?: unknown) => string;
	};
	origin?: TaskOriginSnapshot;
	refreshUi?: () => Promise<void> | void;
	parentCtx: Pick<ExtensionContext, "ui" | "hasUI" | "modelRegistry">;
	runAgent?: typeof runSingleAgentViaAgentSession;
}): Promise<SingleResult> {
	const {
		preparedStep,
		task,
		mode,
		step,
		toolCallId,
		runId,
		signal,
		onUpdate,
		makeDetails,
		sessionManager,
		origin,
		refreshUi,
		parentCtx,
		runAgent = runSingleAgentViaAgentSession,
	} = options;
	const metadataRunId = runId ?? `${toolCallId}-run`;

	let createdSnapshot: ChildSessionSnapshot | undefined;
	if (preparedStep.session.persist && !preparedStep.session.sessionFile) {
		try {
			const createdSession =
				preparedStep.session.mode === "fresh"
					? await createManagedFreshTaskSession({
							childCwd: preparedStep.launchCwd,
							parentSessionFile: preparedStep.session.parentSessionFile,
							sessionName:
								preparedStep.session.sessionName ??
								buildTaskChildSessionName(preparedStep.worker.displayAgentName, task),
						})
					: preparedStep.session.parentSessionFile
						? await createManagedForkedTaskSession({
								parentSessionFile: preparedStep.session.parentSessionFile,
								childCwd: preparedStep.launchCwd,
								sessionName:
									preparedStep.session.sessionName ??
									buildTaskChildSessionName(preparedStep.worker.displayAgentName, task),
							})
						: (() => {
								throw new Error("Parent session is unavailable for forked task.");
							})();
			preparedStep.session.sessionFile = createdSession.sessionFile;
			preparedStep.session.sessionId = createdSession.sessionId;
		} catch (error) {
			return {
				agent: preparedStep.worker.displayAgentName,
				agentSource: preparedStep.worker.agent?.source ?? "unknown",
				task,
				exitCode: 1,
				messages: [],
				stderr: `Failed to create child session: ${error instanceof Error ? error.message : String(error)}`,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				model: preparedStep.worker.model,
				step,
				sessionMode: preparedStep.session.mode,
				sessionPersist: true,
				stopReason: "error",
			};
		}
	}
	if (preparedStep.session.persist && preparedStep.session.sessionFile && preparedStep.session.sessionId) {
		createdSnapshot = {
			v: TASK_CHILD_SESSION_METADATA_VERSION,
			runId: metadataRunId,
			toolCallId,
			mode,
			step,
			childSessionId: preparedStep.session.sessionId,
			childSessionPath: preparedStep.session.sessionFile,
			childSessionName: preparedStep.session.sessionName,
			parentSessionId: preparedStep.session.parentSessionId,
			parentSessionPath: preparedStep.session.parentSessionFile,
			originEntryId: origin?.originEntryId,
			originUserEntryId: origin?.originUserEntryId,
			originPreview: origin?.originPreview,
			effectiveContext: preparedStep.session.mode,
			persist: true,
			agent: preparedStep.worker.agent?.name,
			profile: preparedStep.worker.profile?.name,
			taskPreview: createTaskPreview(task),
			createdAt: new Date().toISOString(),
			status: "created",
		};
		const appendError = appendTaskChildSessionMetadata(sessionManager, createdSnapshot);
		if (!appendError) await Promise.resolve(refreshUi?.());
		if (appendError) {
			const metadataError =
				`Failed to append initial ${TASK_CHILD_SESSION_CUSTOM_TYPE} metadata (status="created"). ` +
				"Persisted child step was not started because parent metadata is authoritative.";
			const fullError = `${metadataError}\n${appendError}`;
			try {
				if (createdSnapshot.childSessionPath && fs.existsSync(createdSnapshot.childSessionPath))
					await fs.promises.unlink(createdSnapshot.childSessionPath);
			} catch {
				// Best-effort cleanup of the unused child session.
			}
			preparedStep.session.sessionFile = undefined;
			preparedStep.session.sessionId = undefined;
			return {
				agent: preparedStep.worker.displayAgentName,
				agentSource: preparedStep.worker.agent?.source ?? "unknown",
				profile: preparedStep.worker.profile?.name,
				effort: preparedStep.worker.effort?.name,
				skills: preparedStep.worker.skills,
				task,
				exitCode: 1,
				messages: [],
				stderr: fullError,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					contextTokens: 0,
					turns: 0,
				},
				model: preparedStep.worker.model,
				step,
				sessionMode: preparedStep.session.mode,
				sessionPersist: preparedStep.session.persist,
				sessionFile: preparedStep.session.sessionFile,
				stopReason: "error",
				errorMessage: metadataError,
				childSession: {
					...createdSnapshot,
					status: "failed",
					finishedAt: new Date().toISOString(),
					exitCode: 1,
					stopReason: "error",
					errorMessage: createTaskPreview(metadataError, 240),
				},
			};
		}
	}

	let result: SingleResult;
	try {
		result = await runAgent(
			preparedStep,
			task,
			step,
			signal,
			onUpdate,
			makeDetails,
			createdSnapshot,
			toolCallId,
			metadataRunId,
			parentCtx,
		);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const aborted = /aborted/i.test(errorMessage);
		result = {
			agent: preparedStep.worker.displayAgentName,
			agentSource: preparedStep.worker.agent?.source ?? "unknown",
			profile: preparedStep.worker.profile?.name,
			effort: preparedStep.worker.effort?.name,
			skills: preparedStep.worker.skills,
			task,
			exitCode: aborted ? 130 : 1,
			messages: [],
			stderr: errorMessage,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			model: preparedStep.worker.model,
			step,
			sessionMode: preparedStep.session.mode,
			sessionPersist: preparedStep.session.persist,
			sessionFile: preparedStep.session.sessionFile,
			stopReason: aborted ? "aborted" : "error",
			errorMessage,
			childSession: createdSnapshot ? { ...createdSnapshot } : undefined,
		};
	}

	if (createdSnapshot) {
		let terminalSnapshot: ChildSessionSnapshot = {
			...createdSnapshot,
			status: resolveChildSessionTerminalStatus(result),
			finishedAt: new Date().toISOString(),
			exitCode: result.exitCode,
			stopReason: result.stopReason,
			errorMessage:
				result.errorMessage ??
				(result.stderr.trim().length > 0 ? createTaskPreview(result.stderr.trim(), 240) : undefined),
		};
		const appendError = appendTaskChildSessionMetadata(sessionManager, terminalSnapshot);
		if (!appendError) await Promise.resolve(refreshUi?.());
		if (appendError) {
			const metadataError =
				`Failed to append terminal ${TASK_CHILD_SESSION_CUSTOM_TYPE} metadata (status="${terminalSnapshot.status}"). ` +
				"Persisted run metadata is incomplete.";
			const fullError = `${metadataError}\n${appendError}`;
			result.stderr = result.stderr ? `${result.stderr}\n${fullError}` : fullError;
			result.errorMessage = result.errorMessage ? `${result.errorMessage} ${metadataError}` : metadataError;
			if (result.exitCode === 0) result.exitCode = 1;
			if (result.stopReason !== "aborted") result.stopReason = "error";
			terminalSnapshot = {
				...terminalSnapshot,
				status: terminalSnapshot.status === "succeeded" ? "failed" : terminalSnapshot.status,
				exitCode: result.exitCode,
				stopReason: result.stopReason,
				errorMessage: createTaskPreview(result.errorMessage, 240),
			};
		}
		result.childSession = terminalSnapshot;
	}

	return boundParentResult(result);
}

const TASK_PINGBACK_CUSTOM_TYPE = "task-pingback";

/** Whether a step result should be reported as a failure rather than a normal outcome. */
function isTaskStepError(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

/**
 * Composes the outcome text for a single worker's result, in priority order: aborted/failed,
 * paused-and-resumable (interactive, kept alive), explicit task_complete summary, then whatever
 * the worker's last message said. Shared by every pingback -- single, per-parallel-step, and
 * chain -- so a worker's result reads the same regardless of which mode delegated it.
 */
function composeTaskResultBody(result: SingleResult): string {
	if (isTaskStepError(result)) {
		const errorMsg = truncateOutput(
			result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)",
		);
		return `Failed (${result.stopReason || "error"}): ${errorMsg}`;
	}
	if (result.awaitingReply) {
		const resumeHint = `Respond by calling \`task\` again with resumeSessionId: "${result.sessionId}" and your reply as \`task\`.`;
		return result.pendingQuestion
			? `Needs input: ${result.pendingQuestion}\n\n${resumeHint}`
			: `Paused without calling task_complete.\n\n${resumeHint}`;
	}
	if (result.completionSummary) return result.completionSummary;
	return truncateOutput(getFinalOutput(result.messages)) || "(no output)";
}

/**
 * An interactive worker that paused naturally -- no task_complete, no ask_caller -- hasn't
 * actually asked for anything. Pinging back here just invites the delegator to nudge it forward
 * with a fresh resumeSessionId call; if the worker doesn't reliably comply, that nudge-pause
 * cycle repeats with no real progress. Stay silent for this case -- task_complete and ask_caller
 * are the only signals that warrant telling the delegator something happened.
 */
function shouldSuppressTaskPingback(result: SingleResult): boolean {
	return Boolean(result.awaitingReply) && !result.pendingQuestion;
}

/**
 * Delivers a background task result to the delegating session -- steers it in if a turn is
 * already running, otherwise starts a new turn, so the result surfaces whether or not the
 * caller is busy with something else when the worker finishes.
 *
 * `piApi.sendMessage` throws if the delegating session has since been replaced or disposed
 * (ExtensionRuntime.assertActive() -- see agent-session.js's dispose()): switching that session
 * away for *any* reason, including using `/tasks open` to inspect the very worker this pingback
 * is about, tears it down as the first step. There is no way to "wake up" a session that no
 * longer exists, so on failure this falls back to writing the result straight into the
 * delegating session's own file via its SessionManager (a plain file writer, unaffected by
 * extension-runtime staleness) -- lost-forever is worse than "only visible next time that
 * session is reopened."
 */
async function deliverTaskPingback(
	piApi: Pick<ExtensionAPI, "sendMessage">,
	text: string,
	details: Record<string, unknown>,
	// `unknown` rather than a narrow structural type: the real caller-side type
	// (ReadonlySessionManager) doesn't declare appendCustomMessageEntry at all, so a narrow
	// optional-only type here would trip TypeScript's "no overlapping properties" weak-type
	// check at every call site. The cast below is the same escape hatch this file already uses
	// for appendCustomEntry (see appendTaskChildSessionMetadata) -- the SDK's real SessionManager
	// has always had this method, just not exposed on ExtensionContext's narrower type.
	fallbackSessionManager?: unknown,
): Promise<void> {
	const message = {
		customType: TASK_PINGBACK_CUSTOM_TYPE,
		content: [{ type: "text" as const, text }],
		display: true,
		details,
	};
	try {
		await piApi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
	} catch {
		(
			fallbackSessionManager as
				| {
						appendCustomMessageEntry?: (
							customType: string,
							content: string,
							display: boolean,
							details?: unknown,
						) => string;
				  }
				| undefined
		)?.appendCustomMessageEntry?.(message.customType, text, message.display, message.details);
	}
}

function buildSingleStepPingbackText(result: SingleResult, context?: { index: number; total: number }): string {
	const header = context
		? `Task step ${context.index + 1}/${context.total} (delegated to ${result.agent})`
		: `Task delegated to ${result.agent}`;
	return `${header}:\n\n${composeTaskResultBody(result)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function collectLiveTaskControllerStepKeys(currentSessionFile?: string): Set<string> {
	const keys = new Set<string>();
	for (const controller of listLiveTaskControllers()) {
		if (controller.status !== "running") continue;
		if (currentSessionFile && controller.parentSessionPath && controller.parentSessionPath !== currentSessionFile)
			continue;
		keys.add(controller.key);
	}
	return keys;
}

// Finds the running AgentSession-backed controller for a run/step, used by /tasks steer to send
// one message directly to it.
function resolveLiveTaskControllerForRun(
	run: TaskRunView,
	step?: TaskRunStepView,
): { controller?: LiveTaskController; error?: string } {
	if (step) {
		const controller = getLiveTaskController(makeTaskRunStepKey(run.runId, step.step));
		if (!isLiveController(controller)) {
			return {
				error: `Run ${run.runId} step ${step.step} is not attached to a running task controller.`,
			};
		}
		return { controller };
	}

	const controllers = run.steps
		.map((candidate) => getLiveTaskController(makeTaskRunStepKey(run.runId, candidate.step)))
		.filter(isLiveController);
	if (controllers.length === 0) {
		return { error: `Run ${run.runId} has no running task controller.` };
	}
	if (controllers.length > 1) {
		return {
			error: `Run ${run.runId} has multiple running steps. Select a specific child session id prefix first.`,
		};
	}
	return { controller: controllers[0]! };
}

function describeTaskRunAccess(run: TaskRunView, selectedStep?: TaskRunStepView): string[] {
	const labels: string[] = [];
	const targetStep = selectTaskRunStepForOpen(run, selectedStep);
	const liveControllerResolution = resolveLiveTaskControllerForRun(run, selectedStep);
	// "open" always does something valid: attaches live (in the TUI) while the step is still
	// running, or opens the finished session file once it's done -- see openTaskRunSession.
	if (targetStep?.snapshot.persist) labels.push("open");
	if (liveControllerResolution.controller) labels.push("steer");
	if (resolveTaskRunOriginSnapshot(run, selectedStep)) labels.push("origin");
	return labels;
}

interface TaskRunSummaryData {
	index: number;
	status: string;
	hasLiveController: boolean;
	runId: string;
	mode: TaskExecutionMode;
	stepCount: number;
	stepLabel: string;
	updatedAt: string;
	access: string[];
	sourceFileName?: string;
	originPreview?: string;
	warningCount: number;
}

function getTaskRunSummaryData(run: TaskRunView, index: number, includeSource: boolean): TaskRunSummaryData {
	const stepLabel = run.stepCount === 1 ? "step" : "steps";
	const hasLiveController = run.steps.some((step) =>
		Boolean(getLiveTaskController(makeTaskRunStepKey(run.runId, step.step))),
	);
	const access = describeTaskRunAccess(run);
	return {
		index,
		status: run.status,
		hasLiveController,
		runId: run.runId,
		mode: run.mode,
		stepCount: run.stepCount,
		stepLabel,
		updatedAt: formatTimestampCompact(run.updatedAt),
		access,
		sourceFileName: includeSource && run.sourceSessionFile ? path.basename(run.sourceSessionFile) : undefined,
		originPreview: resolveTaskRunOriginSnapshot(run)?.originPreview,
		warningCount: run.warnings.length,
	};
}

function formatTaskRunSummary(run: TaskRunView, index: number, includeSource: boolean): string {
	const data = getTaskRunSummaryData(run, index, includeSource);
	let text = `${data.index}. ${data.status}${data.hasLiveController ? "/live" : ""} ${data.runId} · ${data.mode} · ${data.stepCount} ${data.stepLabel} · ${data.updatedAt}`;
	if (data.access.length > 0) text += ` · ${data.access.join(",")}`;
	if (data.sourceFileName) text += ` · ${data.sourceFileName}`;
	if (data.originPreview) text += ` · ${data.originPreview}`;
	if (data.warningCount > 0) text += ` · warnings:${data.warningCount}`;
	return text;
}

function themeIndependentTaskBrowserHeading(runCount: number): string {
	return `Task runs in current session (${runCount}):`;
}

function formatTaskRunList(scope: TasksScope, runs: TaskRunView[]): string {
	if (runs.length === 0) {
		return TASKS_NO_CURRENT_RUNS_MESSAGE;
	}
	const header = themeIndependentTaskBrowserHeading(runs.length);
	const guidance =
		"Open a task's session with /tasks open <selector>, or steer it with /tasks steer <selector> <message>.";
	return [header, guidance, ...runs.map((run, index) => formatTaskRunSummary(run, index + 1, false))].join("\n");
}

async function formatTaskRunDetails(
	scope: TasksScope,
	run: TaskRunView,
	selectedStep?: TaskRunStepView,
): Promise<string> {
	const lines: string[] = [];
	lines.push(`Run: ${run.runId}`);
	lines.push(`Status: ${run.status} · mode: ${run.mode} · steps: ${run.stepCount}`);
	lines.push(`Scope: ${scope}`);
	lines.push(`Created: ${formatTimestampCompact(run.createdAt)} · Updated: ${formatTimestampCompact(run.updatedAt)}`);
	if (run.sourceSessionFile) {
		lines.push(
			`Source session: ${shortenHomePath(run.sourceSessionFile)}${run.sourceSessionId ? ` (${run.sourceSessionId.slice(0, 8)})` : ""}`,
		);
	}
	if (selectedStep) {
		lines.push(`Selector matched step ${selectedStep.step} (${selectedStep.status}).`);
	}
	const origin = resolveTaskRunOriginSnapshot(run, selectedStep);
	const originTarget = getTaskOriginNavigationTarget(run, selectedStep);
	const access = describeTaskRunAccess(run, selectedStep);
	if (origin?.originPreview) lines.push(`Origin: ${origin.originPreview}`);
	if (originTarget) lines.push(`Origin entry: ${originTarget.slice(0, 8)}`);
	if (access.length > 0) lines.push(`Actions: ${access.join(", ")}`);
	const stepForLiveLookup = selectTaskRunStepForInspect(run, selectedStep);
	const liveController = stepForLiveLookup
		? getLiveTaskController(makeTaskRunStepKey(run.runId, stepForLiveLookup.step))
		: undefined;
	if (isLiveController(liveController)) {
		const liveInfo = readLiveTaskRuntimeInfo(liveController);
		lines.push(
			`Live controller: ${liveInfo.status} · streaming:${liveInfo.isStreaming ? "yes" : "no"} · queued:${liveInfo.pendingSteeringCount}/${liveInfo.pendingFollowUpCount}`,
		);
		if (typeof liveInfo.messageCount === "number") lines.push(`Live messages: ${liveInfo.messageCount}`);
		if (liveInfo.lastAssistantText)
			lines.push(`Live assistant: ${createTaskPreview(liveInfo.lastAssistantText, 160)}`);
		lines.push(`Steer: /tasks steer ${selectedStep ? selectedStep.snapshot.childSessionId : run.runId} <message>`);
		lines.push("");
		lines.push("Steps:");
	} else if (selectedStep?.status === "running") {
		lines.push("Live controller: unavailable");
		lines.push("Steps:");
	} else {
		lines.push("Steps:");
	}
	if (selectedStep?.snapshot.persist) {
		lines.push(`Open: /tasks open ${selectedStep.snapshot.childSessionId}`);
		lines.push(`View: /tasks view ${selectedStep.snapshot.childSessionId}`);
	} else if (!selectedStep && run.persistedStepCount > 0) {
		lines.push(`Open: /tasks open ${run.runId}`);
		lines.push(`View: /tasks view ${run.runId}`);
	}
	if (originTarget) {
		lines.push(`Origin: /tasks origin ${selectedStep ? selectedStep.snapshot.childSessionId : run.runId}`);
	}
	for (const step of run.steps) {
		const marker = selectedStep?.step === step.step ? "*" : "-";
		const childShort = step.snapshot.childSessionId.slice(0, 8);
		const persistLabel = step.snapshot.persist ? "persisted" : "not-persisted";
		lines.push(
			`${marker} ${step.step}. ${step.status} · ${persistLabel} · session ${childShort} · ${step.snapshot.effectiveContext}`,
		);
		lines.push(
			`   path: ${step.snapshot.childSessionPath ? shortenHomePath(step.snapshot.childSessionPath) : "(missing)"}`,
		);
		if (step.snapshot.childSessionName) lines.push(`   name: ${step.snapshot.childSessionName}`);
		if (step.snapshot.parentSessionPath)
			lines.push(`   parent: ${shortenHomePath(step.snapshot.parentSessionPath)}`);
		const stepController = getLiveTaskController(makeTaskRunStepKey(run.runId, step.step));
		if (isLiveController(stepController)) {
			lines.push(`   live · ${stepController.status}`);
		}
		if (step.snapshot.taskPreview) lines.push(`   task: ${step.snapshot.taskPreview}`);
		for (const warning of step.warnings) lines.push(`   warning: ${warning}`);
	}
	if (run.warnings.length > 0) {
		lines.push("Warnings:");
		for (const warning of run.warnings) lines.push(`- ${warning}`);
	}
	return lines.join("\n");
}

function extractToolCallNames(message: Message): string[] {
	const content: unknown[] = Array.isArray(message.content) ? message.content : [];
	return content
		.filter(
			(part): part is { type: string; name: string } =>
				isRecord(part) && part.type === "toolCall" && typeof part.name === "string",
		)
		.map((part) => part.name);
}

function formatTranscriptPreviewLine(message: Message): string {
	const preview =
		extractMessagePreviewText(message) ??
		(() => {
			const toolCallNames = extractToolCallNames(message);
			if (toolCallNames.length > 0) return `tool calls: ${toolCallNames.join(", ")}`;
			return "(no text)";
		})();
	return `${message.role}: ${createTaskPreview(preview, 180)}`;
}

function extractMessagesFromSessionEntries(entries: readonly SessionEntry[]): Message[] {
	const messages: Message[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !isRecord(entry.message) || typeof entry.message.role !== "string") continue;
		messages.push(entry.message as Message);
	}
	return messages;
}

function readSessionEntriesFromFile(sessionPath: string): SessionEntry[] {
	const raw = fs.readFileSync(sessionPath, "utf-8");
	return raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as SessionEntry);
}

interface TaskTranscriptPreview {
	lines: string[];
	sourceLabel: string;
	truncated: boolean;
	error?: string;
}

async function readTaskTranscriptPreview(
	run: TaskRunView,
	selectedStep?: TaskRunStepView,
): Promise<TaskTranscriptPreview> {
	const inspectStep = selectTaskRunStepForInspect(run, selectedStep);
	if (!inspectStep) {
		return {
			lines: ["No task steps available."],
			sourceLabel: "none",
			truncated: false,
		};
	}
	const controller = getLiveTaskController(makeTaskRunStepKey(run.runId, inspectStep.step));
	if (isLiveController(controller)) {
		const messages = controller.session.messages.filter(
			(message): message is Message =>
				message.role === "assistant" || message.role === "user" || message.role === "toolResult",
		);
		const truncated = messages.length > 12;
		return {
			lines: messages.slice(-12).map(formatTranscriptPreviewLine),
			sourceLabel: "live",
			truncated,
		};
	}
	const sessionValidation = validateTaskSessionReference(
		inspectStep.snapshot.childSessionPath,
		inspectStep.snapshot.childSessionId,
	);
	if (!sessionValidation.reference) {
		return {
			lines: [`Persisted transcript is unavailable: ${sessionValidation.error}`],
			sourceLabel: "persisted session",
			truncated: false,
		};
	}
	if (!fs.existsSync(sessionValidation.reference.path)) {
		return {
			lines: ["Persisted transcript file is unavailable."],
			sourceLabel: "persisted session",
			truncated: false,
		};
	}
	try {
		const entries = readSessionEntriesFromFile(sessionValidation.reference.path);
		const messages = extractMessagesFromSessionEntries(entries);
		const truncated = messages.length > 12;
		return {
			lines: messages.slice(-12).map(formatTranscriptPreviewLine),
			sourceLabel: "persisted session",
			truncated,
		};
	} catch (error) {
		return {
			lines: ["Failed to read persisted transcript."],
			sourceLabel: "persisted session",
			truncated: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

interface TaskUiChromeSink {
	hasUI?: boolean;
	ui?: {
		setWidget?: (key: string, content: any, options?: any) => void;
		setStatus?: (key: string, text?: string) => void;
		theme?: {
			fg?: (color: any, text: string) => string;
			bold?: (text: string) => string;
		};
	};
}

interface TaskUiChromeContext extends TaskUiChromeSink {
	sessionManager: {
		getBranch(): readonly SessionEntry[];
		getSessionFile?: () => string | undefined;
		getSessionId?: () => string | undefined;
	};
}

interface TaskWidgetSummary {
	totalRuns: number;
	runningRuns: number;
	runs: TaskRunView[];
}

function getTaskWidgetSessionKey(ctx: {
	sessionManager?: {
		getSessionFile?: () => string | undefined;
		getSessionId?: () => string | undefined;
	};
}): string | undefined {
	const sessionFile = ctx.sessionManager?.getSessionFile?.();
	if (typeof sessionFile === "string" && sessionFile.trim()) {
		return `file:${normalizeSessionPathForComparison(sessionFile)}`;
	}
	const sessionId = ctx.sessionManager?.getSessionId?.();
	if (typeof sessionId === "string" && sessionId.trim()) {
		return `id:${sessionId.trim()}`;
	}
	return undefined;
}

function isTaskWidgetEnabled(ctx: {
	sessionManager?: {
		getSessionFile?: () => string | undefined;
		getSessionId?: () => string | undefined;
	};
}): boolean {
	const sessionKey = getTaskWidgetSessionKey(ctx);
	return sessionKey ? taskWidgetEnabledSessions.has(sessionKey) : false;
}

function setTaskWidgetEnabled(
	ctx: {
		sessionManager?: {
			getSessionFile?: () => string | undefined;
			getSessionId?: () => string | undefined;
		};
	},
	enabled: boolean,
): boolean {
	const sessionKey = getTaskWidgetSessionKey(ctx);
	if (!sessionKey) return false;
	if (enabled) taskWidgetEnabledSessions.add(sessionKey);
	else taskWidgetEnabledSessions.delete(sessionKey);
	return true;
}

function buildTaskWidgetSummary(runs: TaskRunView[]): TaskWidgetSummary {
	const activeRuns = runs.filter((run) => run.status === "running");
	return {
		totalRuns: runs.length,
		runningRuns: activeRuns.length,
		runs: [...activeRuns].sort((left, right) => toMillis(right.updatedAt) - toMillis(left.updatedAt)),
	};
}

function buildTaskWidgetLines(
	summary: TaskWidgetSummary,
	style?: {
		fg?: (color: any, text: string) => string;
		bold?: (text: string) => string;
	},
): string[] {
	const fg = typeof style?.fg === "function" ? style.fg.bind(style) : (_color: any, text: string) => text;
	const bold = typeof style?.bold === "function" ? style.bold.bind(style) : (text: string) => text;
	const lines = [fg("toolTitle", bold(themeIndependentTaskBrowserHeading(summary.runningRuns)))];
	if (summary.totalRuns === 0) {
		lines.push(fg("muted", TASKS_NO_CURRENT_RUNS_MESSAGE));
		lines.push(fg("dim", `Use /tasks or ${TASKS_BROWSER_SHORTCUT_LABEL} to browse · /tasks toggle hide`));
		return lines;
	}
	if (summary.runningRuns === 0) {
		lines.push(fg("muted", "No active task runs in current session."));
		lines.push(fg("dim", `Hidden non-active runs: ${summary.totalRuns}`));
		lines.push(fg("dim", `Use /tasks or ${TASKS_BROWSER_SHORTCUT_LABEL} to browse · /tasks toggle hide`));
		return lines;
	}
	for (const [index, run] of summary.runs.entries()) {
		const data = getTaskRunSummaryData(run, index + 1, false);
		const statusColor = data.status === "running" ? "warning" : data.status === "succeeded" ? "success" : "error";
		const parts = [
			fg("muted", `${data.index}.`),
			fg(statusColor, `${data.status}${data.hasLiveController ? "/live" : ""}`),
			fg("accent", data.runId),
			fg("muted", "·"),
			fg("dim", data.mode),
			fg("muted", "·"),
			fg("dim", `${data.stepCount} ${data.stepLabel}`),
			fg("muted", "·"),
			fg("dim", data.updatedAt),
		];
		if (data.access.length > 0) parts.push(fg("muted", `· ${data.access.join(",")}`));
		if (data.originPreview) parts.push(fg("dim", `· ${createTaskPreview(data.originPreview, 80)}`));
		if (data.warningCount > 0) parts.push(fg("warning", `· warnings:${data.warningCount}`));
		lines.push(parts.join(" "));
	}
	if (summary.totalRuns > summary.runningRuns) {
		lines.push(fg("dim", `Hidden non-active runs: ${summary.totalRuns - summary.runningRuns}`));
	}
	lines.push(fg("dim", `Use /tasks or ${TASKS_BROWSER_SHORTCUT_LABEL} to interact · /tasks toggle hide`));
	return lines;
}

function clearTaskUiChrome(ctx: TaskUiChromeSink): void {
	if (!ctx.hasUI || !ctx.ui) return;
	if (typeof ctx.ui.setWidget === "function") {
		ctx.ui.setWidget("tasks.runs", undefined);
	}
	if (typeof ctx.ui.setStatus === "function") {
		ctx.ui.setStatus("tasks.runs", undefined);
	}
}

function syncTaskUiChrome(ctx: TaskUiChromeContext): void {
	if (!ctx.hasUI || !ctx.ui) return;
	if (!isTaskWidgetEnabled(ctx)) {
		clearTaskUiChrome(ctx);
		return;
	}
	const runs = reconstructCurrentTaskRuns({
		entries: ctx.sessionManager.getBranch(),
		sourceSessionFile: ctx.sessionManager.getSessionFile?.(),
		customType: TASK_CHILD_SESSION_CUSTOM_TYPE,
		metadataVersion: TASK_CHILD_SESSION_METADATA_VERSION,
		extraLiveStepKeys: collectLiveTaskControllerStepKeys(ctx.sessionManager.getSessionFile?.()),
	});
	if (typeof ctx.ui.setWidget === "function") {
		ctx.ui.setWidget("tasks.runs", buildTaskWidgetLines(buildTaskWidgetSummary(runs), ctx.ui.theme), {
			placement: "belowEditor",
		});
	}
	if (typeof ctx.ui.setStatus === "function") {
		ctx.ui.setStatus("tasks.runs", undefined);
	}
}

async function withTaskWidgetTemporarilyHidden<T>(
	ctx: TaskUiChromeContext,
	action: (onReplacement: () => void) => Promise<T>,
): Promise<T> {
	const wasEnabled = isTaskWidgetEnabled(ctx);
	let replaced = false;
	if (wasEnabled) {
		setTaskWidgetEnabled(ctx, false);
		clearTaskUiChrome(ctx);
	}
	try {
		return await action(() => {
			replaced = true;
		});
	} finally {
		if (wasEnabled && !replaced) {
			setTaskWidgetEnabled(ctx, true);
			syncTaskUiChrome(ctx);
		}
	}
}

function selectTaskRunStepForOpen(run: TaskRunView, preferredStep?: TaskRunStepView): TaskRunStepView | undefined {
	if (preferredStep) return preferredStep;
	const persistedSteps = run.steps.filter((step) => step.snapshot.persist);
	if (persistedSteps.length === 0) return undefined;
	return persistedSteps.sort((left, right) => {
		if (right.step !== left.step) return right.step - left.step;
		return toMillis(getSnapshotEventTimestamp(right.snapshot)) - toMillis(getSnapshotEventTimestamp(left.snapshot));
	})[0];
}

function selectTaskRunStepForInspect(run: TaskRunView, preferredStep?: TaskRunStepView): TaskRunStepView | undefined {
	if (preferredStep) return preferredStep;
	const running = run.steps.filter((step) => step.status === "running");
	if (running.length > 0) {
		return running.sort((left, right) => {
			if (right.step !== left.step) return right.step - left.step;
			return (
				toMillis(getSnapshotEventTimestamp(right.snapshot)) - toMillis(getSnapshotEventTimestamp(left.snapshot))
			);
		})[0];
	}
	return [...run.steps].sort((left, right) => {
		if (right.step !== left.step) return right.step - left.step;
		return toMillis(getSnapshotEventTimestamp(right.snapshot)) - toMillis(getSnapshotEventTimestamp(left.snapshot));
	})[0];
}

function manualTaskSessionOpenInstruction(sessionPath: string): string {
	return [
		`Child session path: ${shortenHomePath(sessionPath)}`,
		`Open manually via /resume, or run: pi --session "${sessionPath}"`,
	].join("\n");
}

function manualParentSessionOpenInstruction(sessionPath: string): string {
	return [
		`Parent session path: ${shortenHomePath(sessionPath)}`,
		`Open manually via /resume, or run: pi --session "${sessionPath}"`,
	].join("\n");
}

/**
 * Attaches the current terminal to a still-running worker instead of opening a second session
 * object pointed at its session file (which the worker's own RPC child is still writing to --
 * two independent writers on one file is a real corruption risk, not just a UX gap). "Open" and
 * "attach" are the same command; which one happens is decided by whether the target step is
 * still live, not by a separate verb. Mirrors the multi-subscriber model used by pi's own
 * `packages/server` (multiple in-process listeners on one worker's event stream) -- this view's
 * subscription coexists with the driver's own subscription that accumulates the eventual
 * SingleResult, and never touches the worker process or its session file itself; sending a
 * message goes through the exact same steer()/prompt() path `/tasks steer` already uses.
 */
/** Delivers one attach-view message into the same running worker -- steer() while it's mid-turn,
 * prompt() while idle. Exactly the routing `/tasks steer` already uses (deliverToLiveSession),
 * just with the rejection surfaced back to the caller instead of floated. */
function sendAttachMessage(controller: LiveTaskController, message: string): Promise<void> {
	return controller.session.isStreaming ? controller.session.steer(message) : controller.session.prompt(message);
}

async function attachToLiveTaskRun(
	ctx: { ui: ExtensionUIContext },
	run: TaskRunView,
	step: TaskRunStepView,
	controller: LiveTaskController,
): Promise<{ ok: true; opened: true; level: "info"; message: string }> {
	const initialMessages = controller.session.messages
		.filter((message): message is Message => message.role === "assistant" || message.role === "toolResult")
		.slice(-20);
	const overlayState: TaskAttachOverlayState = {
		runId: run.runId,
		agent: controller.agent,
		step: step.step,
		initialMessages,
		initialStreaming: controller.session.isStreaming,
	};

	await ctx.ui.custom<undefined>(
		(
			tui: { requestRender: () => void },
			theme: unknown,
			keybindings: unknown,
			done: (value: undefined) => void,
		) => {
			let unsubscribe = () => {};
			const overlay = new TaskAttachOverlay(
				theme,
				overlayState,
				keybindings as any,
				() => tui.requestRender(),
				(message) => {
					sendAttachMessage(controller, message).catch((error) =>
						overlay.setError(error instanceof Error ? error.message : String(error)),
					);
				},
				() => {
					unsubscribe();
					done(undefined);
				},
			);
			unsubscribe = controller.session.subscribe((event) => {
				if (event.type === "agent_start") overlay.setStreaming(true);
				else if (event.type === "agent_settled") overlay.setStreaming(false);
				else if (event.type === "tool_execution_start" && event.toolName === TASK_COMPLETE_TOOL_NAME) {
					overlay.appendNotice("(task_complete called -- worker is finishing)");
				} else if (event.type === "message_end") {
					const message = event.message as Message;
					if (message.role === "assistant" || message.role === "toolResult")
						overlay.appendMessages([message]);
				}
			});
			return overlay;
		},
		{ overlay: true, overlayOptions: { anchor: "right-center", width: "55%", maxHeight: "85%", margin: 1 } },
	);

	return { ok: true, opened: true, level: "info", message: `Detached from run ${run.runId} step ${step.step}.` };
}

function supportsInteractiveAttach(ctx: unknown): ctx is { mode?: string; ui: ExtensionUIContext } {
	return (
		isRecord(ctx) &&
		ctx.mode === "tui" &&
		isRecord(ctx.ui) &&
		typeof ctx.ui.custom === "function" &&
		typeof ctx.ui.notify === "function"
	);
}

async function openTaskRunSession(
	ctx: unknown,
	run: TaskRunView,
	preferredStep?: TaskRunStepView,
	onReplacement?: () => void,
): Promise<{
	ok: boolean;
	opened?: boolean;
	level: "info" | "warning" | "error";
	message?: string;
}> {
	const targetStep = selectTaskRunStepForOpen(run, preferredStep);
	if (!targetStep) {
		return {
			ok: false,
			level: "error",
			message: `Run ${run.runId} has no persisted child session to open.`,
		};
	}
	if (!targetStep.snapshot.persist) {
		return {
			ok: false,
			level: "error",
			message: `Run ${run.runId} step ${targetStep.step} is not persisted and cannot be opened.`,
		};
	}
	const childSessionPath = targetStep.snapshot.childSessionPath;
	if (!childSessionPath.trim()) {
		return {
			ok: false,
			level: "error",
			message: `Run ${run.runId} step ${targetStep.step} has missing child session path metadata (stale metadata).`,
		};
	}
	// A running step's own RPC child process is still writing to this session file -- opening a
	// second session object against it would give the file two independent writers. Attach to the
	// same running process instead (below); this requires a real TUI, since it's an interactive
	// overlay, not a one-shot notification.
	const liveController = getLiveTaskController(makeTaskRunStepKey(run.runId, targetStep.step));
	if (isLiveController(liveController)) {
		if (supportsInteractiveAttach(ctx)) return attachToLiveTaskRun(ctx, run, targetStep, liveController);
		return {
			ok: false,
			level: "warning",
			message: `Run ${run.runId} step ${targetStep.step} is still running. Open in the TUI to attach to it live, or use "/tasks steer"/resumeSessionId to send it input -- it can be opened once it finishes.`,
		};
	}
	const sessionValidation = validateTaskSessionReference(childSessionPath, targetStep.snapshot.childSessionId);
	if (!sessionValidation.reference) {
		return { ok: false, level: "error", message: `Cannot open child session: ${sessionValidation.error}` };
	}
	const canonicalChildSessionPath = sessionValidation.reference.path;

	let openedMessage = `Opened run ${run.runId} step ${targetStep.step} (${targetStep.snapshot.childSessionId.slice(0, 8)}).`;
	if (!preferredStep && run.persistedStepCount > 1) {
		openedMessage += " Use a child session id prefix selector to open a different step.";
	}

	const openResult = await tryOpenTaskSession(ctx, canonicalChildSessionPath, {
		targetSessionId: targetStep.snapshot.childSessionId,
		withSession: async (replacementCtx) => {
			await notifyTaskSessionOpened(replacementCtx, openedMessage);
		},
		onReplacement,
	});
	if (openResult.opened) {
		return { ok: true, opened: true, level: "info" };
	}
	return {
		ok: false,
		level: "warning",
		message: `${openResult.message}\n${manualTaskSessionOpenInstruction(childSessionPath)}`,
	};
}

async function sendTaskSteeringMessage(
	run: TaskRunView,
	preferredStep: TaskRunStepView | undefined,
	message: string,
): Promise<{
	ok: boolean;
	level: "info" | "warning" | "error";
	message: string;
}> {
	const controllerResolution = resolveLiveTaskControllerForRun(run, preferredStep);
	if (!controllerResolution.controller) {
		return {
			ok: false,
			level: "error",
			message: controllerResolution.error ?? `Run ${run.runId} is not steerable right now.`,
		};
	}
	try {
		deliverToLiveSession(controllerResolution.controller.session, message);
		return {
			ok: true,
			level: "info",
			message: `Steering sent to run ${run.runId}${preferredStep ? ` step ${preferredStep.step}` : ""}.`,
		};
	} catch (error) {
		return {
			ok: false,
			level: "error",
			message: `Failed to steer run ${run.runId}${preferredStep ? ` step ${preferredStep.step}` : ""}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * `/tasks view` -- always a plain notification (no interactive overlay): metadata, origin
 * preview, available actions, warnings, and (when a controller is running) a recent transcript
 * preview read straight from the live worker process's message history. `open`/`origin`/`steer`
 * remain separate commands for actually acting on a run; view is read-only.
 */
async function showTaskRunView(
	ctx: {
		hasUI?: boolean;
		ui: { notify(text: string, level?: "info" | "warning" | "error"): void };
	},
	scope: TasksScope,
	run: TaskRunView,
	preferredStep?: TaskRunStepView,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Task view is only available with UI.", "warning");
		return;
	}
	const inspectStep = selectTaskRunStepForInspect(run, preferredStep);
	const detailText = await formatTaskRunDetails(scope, run, inspectStep);
	const transcript = await readTaskTranscriptPreview(run, inspectStep);
	ctx.ui.notify(
		`${detailText}${transcript.lines.length > 0 ? `\n\nTranscript:\n${transcript.lines.join("\n")}` : ""}`,
		"info",
	);
}

async function revealTaskRunOrigin(
	ctx: {
		waitForIdle?: () => Promise<void>;
		sessionManager: {
			getSessionFile?: () => string | undefined;
			getSessionId?: () => string | undefined;
		};
		navigateTree?: (
			targetId: string,
			options?: {
				summarize?: boolean;
				customInstructions?: string;
				replaceInstructions?: boolean;
				label?: string;
			},
		) => Promise<{ editorText?: string; cancelled: boolean }>;
	},
	run: TaskRunView,
	preferredStep?: TaskRunStepView,
): Promise<{
	ok: boolean;
	level: "info" | "warning" | "error";
	message: string;
}> {
	const origin = resolveTaskRunOriginSnapshot(run, preferredStep);
	if (!origin) {
		return {
			ok: false,
			level: "error",
			message: `Run ${run.runId} has no recorded origin metadata.`,
		};
	}
	const targetId = origin.originUserEntryId ?? origin.originEntryId;
	const preview = origin.originPreview ?? "(origin preview unavailable)";
	const currentSessionFile = ctx.sessionManager.getSessionFile?.();
	const currentSessionId = ctx.sessionManager.getSessionId?.();
	const sourceSessionFile = run.sourceSessionFile;
	if (
		targetId &&
		typeof ctx.navigateTree === "function" &&
		currentSessionFile &&
		sourceSessionFile &&
		sessionIdentityMatchesTarget(
			{ sessionPath: currentSessionFile, sessionId: currentSessionId },
			normalizeSessionPathForComparison(sourceSessionFile),
			run.sourceSessionId,
		)
	) {
		try {
			await ctx.waitForIdle?.();
			const result = await ctx.navigateTree(targetId, {
				summarize: false,
				label: "task-origin",
			});
			if (result.cancelled) {
				return {
					ok: false,
					level: "warning",
					message: `Origin navigation for run ${run.runId} was cancelled.`,
				};
			}
			return {
				ok: true,
				level: "info",
				message: `Moved to origin for run ${run.runId}: ${preview}`,
			};
		} catch (error) {
			return {
				ok: false,
				level: "error",
				message: `Failed to reveal origin for run ${run.runId}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	const lines = [`Origin for run ${run.runId}: ${preview}`];
	if (targetId) lines.push(`Origin entry id: ${targetId}`);
	if (sourceSessionFile) {
		lines.push(`Source session: ${shortenHomePath(sourceSessionFile)}`);
		if (
			!currentSessionFile ||
			normalizeSessionPathForComparison(currentSessionFile) !==
				normalizeSessionPathForComparison(sourceSessionFile)
		) {
			lines.push(`Open manually via /resume, or run: pi --session "${sourceSessionFile}"`);
		}
	}
	return { ok: true, level: "info", message: lines.join("\n") };
}

async function browseTaskRuns(
	ctx: any,
	scope: TasksScope,
	runs: TaskRunView[],
	onReplacement?: () => void,
): Promise<boolean> {
	if (!ctx.hasUI) return false;
	const runOptions = runs.map((run, index) => formatTaskRunSummary(run, index + 1, false));
	const selectedRunLabel = await ctx.ui.select("Task runs", runOptions);
	if (!selectedRunLabel) return true;
	const selectedRunIndex = runOptions.indexOf(selectedRunLabel);
	if (selectedRunIndex < 0) {
		ctx.ui.notify("Selected task run could not be resolved.", "error");
		return true;
	}
	const selectedRun = runs[selectedRunIndex]!;
	const hasLiveController = selectedRun.steps.some((candidate) =>
		isLiveController(getLiveTaskController(makeTaskRunStepKey(selectedRun.runId, candidate.step))),
	);
	const hasPersistedSteps = selectedRun.steps.some((candidate) => candidate.snapshot.persist);
	const hasOrigin = Boolean(
		getTaskOriginNavigationTarget(selectedRun) || resolveTaskRunOriginSnapshot(selectedRun)?.originPreview,
	);
	const actionOptions = [
		"View details",
		...(hasPersistedSteps ? ["Open session"] : []),
		...(hasLiveController ? ["Steer running task"] : []),
		...(hasOrigin ? ["Reveal origin"] : []),
		"Cancel",
	];
	const action = await ctx.ui.select(`Run ${selectedRun.runId}`, actionOptions);
	if (!action || action === "Cancel") return true;
	if (action === "View details") {
		await showTaskRunView(ctx, scope, selectedRun);
		return true;
	}
	if (action === "Reveal origin") {
		await ctx.waitForIdle();
		const originResult = await revealTaskRunOrigin(ctx, selectedRun);
		ctx.ui.notify(originResult.message, originResult.level);
		syncTaskUiChrome(ctx);
		return true;
	}
	if (action === "Steer running task") {
		const liveSteps = selectedRun.steps.filter((candidate) =>
			isLiveController(getLiveTaskController(makeTaskRunStepKey(selectedRun.runId, candidate.step))),
		);
		let selectedStep = liveSteps[0];
		if (liveSteps.length > 1) {
			const stepOptions = liveSteps.map(
				(candidate) =>
					`step ${candidate.step} · ${candidate.snapshot.childSessionId.slice(0, 8)} · ${candidate.snapshot.taskPreview || candidate.snapshot.childSessionName || "running"}`,
			);
			const selectedStepLabel = await ctx.ui.select(`Steer run ${selectedRun.runId}`, stepOptions);
			if (!selectedStepLabel) return true;
			const stepIndex = stepOptions.indexOf(selectedStepLabel);
			if (stepIndex < 0) {
				ctx.ui.notify("Selected task step could not be resolved.", "error");
				return true;
			}
			selectedStep = liveSteps[stepIndex];
		}
		if (!selectedStep) {
			ctx.ui.notify(`Run ${selectedRun.runId} has no running live step to steer.`, "error");
			return true;
		}
		const message = await ctx.ui.input(`Steer run ${selectedRun.runId} step ${selectedStep.step}`, "");
		if (!message?.trim()) return true;
		const steerResult = await sendTaskSteeringMessage(selectedRun, selectedStep, message);
		ctx.ui.notify(steerResult.message, steerResult.level);
		syncTaskUiChrome(ctx);
		return true;
	}
	const persistedSteps = selectedRun.steps.filter((candidate) => candidate.snapshot.persist);
	let targetStep = selectTaskRunStepForOpen(selectedRun);
	if (persistedSteps.length > 1) {
		const stepOptions = persistedSteps.map(
			(candidate) =>
				`step ${candidate.step} · ${candidate.status} · ${candidate.snapshot.childSessionId.slice(0, 8)} · ${candidate.snapshot.taskPreview || candidate.snapshot.childSessionName || "persisted"}`,
		);
		const selectedStepLabel = await ctx.ui.select(`Open run ${selectedRun.runId}`, stepOptions);
		if (!selectedStepLabel) return true;
		const stepIndex = stepOptions.indexOf(selectedStepLabel);
		if (stepIndex < 0) {
			ctx.ui.notify("Selected task step could not be resolved.", "error");
			return true;
		}
		targetStep = persistedSteps[stepIndex];
	}
	const openResult = await openTaskRunSession(ctx, selectedRun, targetStep, onReplacement);
	if (!openResult.opened) {
		if (openResult.message) ctx.ui.notify(openResult.message, openResult.level);
		syncTaskUiChrome(ctx);
	}
	return true;
}

type TaskSessionWithSessionCallback = (ctx: unknown) => Promise<void> | void;

interface TryOpenTaskSessionOptions {
	withSession?: TaskSessionWithSessionCallback;
	targetSessionId?: string;
	onReplacement?: () => void;
}

interface SessionIdentity {
	sessionPath?: string;
	sessionId?: string;
}

async function notifyTaskSessionOpened(ctx: unknown, message: string): Promise<void> {
	if (!isRecord(ctx)) return;
	const ui = isRecord(ctx.ui) ? ctx.ui : undefined;
	const notify = ui?.notify;
	if (typeof notify !== "function") return;
	await Promise.resolve(
		(notify as (text: string, level?: "info" | "warning" | "error") => unknown).call(ui, message, "info"),
	);
}

function normalizeSessionPathForComparison(filePath: string): string {
	const resolved = path.resolve(filePath);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		try {
			return fs.realpathSync(resolved);
		} catch {
			return resolved;
		}
	}
}

function readSessionIdentity(ctx: unknown): SessionIdentity {
	if (!isRecord(ctx)) return {};

	const pickString = (value: unknown): string | undefined => {
		if (typeof value !== "string") return undefined;
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	};

	const identity: SessionIdentity = {
		sessionPath: pickString(ctx.sessionFile) ?? pickString(ctx.sessionPath) ?? pickString(ctx.path),
		sessionId: pickString(ctx.sessionId) ?? pickString(ctx.id),
	};

	const session = isRecord(ctx.session) ? ctx.session : undefined;
	if (session) {
		identity.sessionPath = identity.sessionPath ?? pickString(session.file) ?? pickString(session.path);
		identity.sessionId = identity.sessionId ?? pickString(session.id);
	}

	const sessionManager = isRecord(ctx.sessionManager) ? ctx.sessionManager : undefined;
	if (sessionManager) {
		if (!identity.sessionPath) {
			const getSessionFile = sessionManager.getSessionFile;
			if (typeof getSessionFile === "function") {
				try {
					identity.sessionPath = pickString((getSessionFile as () => unknown).call(sessionManager));
				} catch {
					// Ignore reflective accessor failures.
				}
			}
			identity.sessionPath =
				identity.sessionPath ?? pickString(sessionManager.sessionFile) ?? pickString(sessionManager.path);
		}
		if (!identity.sessionId) {
			const getSessionId = sessionManager.getSessionId;
			if (typeof getSessionId === "function") {
				try {
					identity.sessionId = pickString((getSessionId as () => unknown).call(sessionManager));
				} catch {
					// Ignore reflective accessor failures.
				}
			}
			identity.sessionId =
				identity.sessionId ?? pickString(sessionManager.sessionId) ?? pickString(sessionManager.id);
		}
	}

	return identity;
}

function sessionIdentityMatchesTarget(
	identity: SessionIdentity,
	targetPath: string,
	targetSessionId?: string,
): boolean {
	const hasPath = Boolean(identity.sessionPath);
	const hasId = Boolean(identity.sessionId && targetSessionId);
	if (!hasPath && !hasId) return false;

	const pathMatches = hasPath && normalizeSessionPathForComparison(identity.sessionPath!) === targetPath;
	const idMatches =
		hasId &&
		(() => {
			const candidateId = identity.sessionId!.trim();
			const expectedId = targetSessionId!.trim();
			return (
				candidateId.length > 0 &&
				expectedId.length > 0 &&
				(candidateId === expectedId || candidateId.startsWith(expectedId) || expectedId.startsWith(candidateId))
			);
		})();

	// When both pieces of identity are available, accepting either one could
	// mistake an unrelated session for the requested replacement.
	return hasPath && hasId ? pathMatches && idMatches : Boolean(pathMatches || idMatches);
}

async function tryOpenTaskSession(
	ctx: unknown,
	sessionPath: string,
	options: TryOpenTaskSessionOptions = {},
): Promise<{ opened: boolean; message: string }> {
	if (!isRecord(ctx)) {
		return {
			opened: false,
			message: "Session switching is unavailable in this extension context.",
		};
	}

	const descriptors: Array<{
		owner: Record<string, unknown>;
		key: string;
		supportsOptionsArg: boolean;
	}> = [
		{ owner: ctx, key: "openSession", supportsOptionsArg: true },
		{ owner: ctx, key: "resumeSession", supportsOptionsArg: true },
		{ owner: ctx, key: "switchSession", supportsOptionsArg: true },
	];
	const sessionManager = isRecord(ctx.sessionManager) ? ctx.sessionManager : undefined;
	if (sessionManager) {
		descriptors.push({
			owner: sessionManager,
			key: "openSession",
			supportsOptionsArg: true,
		});
		descriptors.push({
			owner: sessionManager,
			key: "resumeSession",
			supportsOptionsArg: true,
		});
		descriptors.push({
			owner: sessionManager,
			key: "switchSession",
			supportsOptionsArg: true,
		});
		descriptors.push({
			owner: sessionManager,
			key: "open",
			supportsOptionsArg: false,
		});
	}
	let attempted = false;
	let lastError: string | undefined;
	const targetPath = normalizeSessionPathForComparison(sessionPath);

	for (const descriptor of descriptors) {
		const fn = descriptor.owner[descriptor.key];
		if (typeof fn !== "function") continue;
		attempted = true;

		let openedWithVerifiedReplacementCtx = false;
		const withSessionCallback: TaskSessionWithSessionCallback = async (replacementCtx) => {
			const replacementIdentity = readSessionIdentity(replacementCtx);
			if (!sessionIdentityMatchesTarget(replacementIdentity, targetPath, options.targetSessionId)) return;
			openedWithVerifiedReplacementCtx = true;
			options.onReplacement?.();
			await options.withSession?.(replacementCtx);
		};

		const argsToTry: unknown[][] = [];
		if (descriptor.supportsOptionsArg) {
			argsToTry.push([sessionPath, { withSession: withSessionCallback }]);
		}
		argsToTry.push([sessionPath]);

		for (const args of argsToTry) {
			try {
				if (typeof (ctx as { waitForIdle?: () => Promise<void> }).waitForIdle === "function") {
					await (ctx as { waitForIdle: () => Promise<void> }).waitForIdle();
				}
				const result = await Promise.resolve(
					(fn as (...fnArgs: unknown[]) => unknown).call(descriptor.owner, ...args),
				);
				if (openedWithVerifiedReplacementCtx) {
					return {
						opened: true,
						message: `Opened target session via ${descriptor.key}.`,
					};
				}
				if (isRecord(result) && (result.cancelled === true || result.canceled === true)) {
					return { opened: false, message: "Session open canceled." };
				}
				if (result === false) continue;
			} catch (error) {
				// Once replacement was verified, the old context is stale. Do not
				// retry or report success after replacement-context callback failure.
				if (openedWithVerifiedReplacementCtx) throw error;
				lastError = error instanceof Error ? error.message : String(error);
			}
		}
	}

	if (!attempted) {
		return {
			opened: false,
			message: "Session switching is unavailable in this extension context.",
		};
	}
	return {
		opened: false,
		message: lastError
			? `Failed to open target session automatically: ${lastError}`
			: "Failed to open target session automatically.",
	};
}

const ContextModeSchema = StringEnum(["fresh", "fork"] as const, {
	description: "Child context mode.",
});

const TaskModeSchema = StringEnum(["single", "parallel", "chain"] as const, {
	description: "Execution mode. Default: single.",
	default: "single",
});

const TaskStep = Type.Object({
	task: Type.String({
		description: "Work request; chain steps may use {previous}.",
	}),
	agent: Type.Optional(
		Type.String({
			description: "Agent name. Required unless `prompt` or a behavior-bearing `profile` is provided.",
		}),
	),
	profile: Type.Optional(
		Type.String({
			description: "Profile name. Can provide worker behavior when the profile has instructions.",
		}),
	),
	effort: Type.Optional(Type.String({ description: "Effort preset." })),
	cwd: Type.Optional(Type.String({ description: "Working dir." })),
	model: Type.Optional(Type.String({ description: "Model override." })),
	skills: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Required skills preloaded into the worker system prompt. Overrides the agent's defaultSkills; an empty array disables defaults.",
		}),
	),
	prompt: Type.Optional(
		Type.String({
			description: "Behavioral system prompt. Required for generic workers with no `agent`.",
		}),
	),
	context: Type.Optional(ContextModeSchema),
	interactive: Type.Optional(
		Type.Boolean({
			description:
				"Keep the worker alive after its first turn instead of auto-finishing; it only ends when it calls `task_complete`. Overrides the agent's own `interactive` default.",
		}),
	),
	resumeSessionId: Type.Optional(
		Type.String({
			description:
				"Continue a specific previously-delegated worker instead of starting a new one -- use the child session id from an earlier result or ping. `task` is delivered to that same running/idle worker; all other fields are ignored.",
		}),
	),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: "Agent scope.",
	default: "user",
});

const SubagentParams = Type.Object({
	mode: Type.Optional(TaskModeSchema),
	steps: Type.Array(TaskStep, {
		description: "Task step(s). Single mode uses one step.",
	}),
	agentScope: Type.Optional(AgentScopeSchema),
});

export const AGENT_COMPLETIONS = [{ value: "clear", label: "clear: clear current agent selection" }] as const;

export const PROFILE_COMPLETIONS = [{ value: "clear", label: "clear: clear current profile selection" }] as const;

export const EFFORT_COMPLETIONS = [{ value: "clear", label: "clear: clear current effort selection" }] as const;

export const TASKS_COMPLETIONS = [
	{ value: "list", label: "list: list current task runs" },
	{ value: "view", label: "view: view details, transcript, and actions for a task run" },
	{ value: "open", label: "open: open a task run session" },
	{ value: "origin", label: "origin: reveal the origin of a task run" },
	{ value: "steer", label: "steer: send a steering message to a task run" },
	{ value: "parent", label: "parent: open the parent session" },
	{ value: "toggle", label: "toggle: toggle the task widget" },
] as const;

export default function (pi: ExtensionAPI) {
	pi.on("project_trust", async (event, ctx) => {
		if (!hasProjectTaskResources(event.cwd) || hasTrustRequiringProjectResources(event.cwd)) {
			return { trusted: "undecided" as const };
		}
		if (!ctx.hasUI) return { trusted: "no" as const };
		const trusted = await ctx.ui.confirm(
			"Trust project configuration?",
			[
				`Task agents, profiles, or defaults were found for ${event.cwd}.`,
				"Project configuration is repository-controlled and can change worker prompts, tools, models, and context access.",
				"Trust all project-local configuration in this directory?",
			].join("\n\n"),
		);
		return {
			trusted: trusted ? ("yes" as const) : ("no" as const),
			remember: true,
		};
	});

	const normalizeMainAgentSelection = (value: unknown): string | undefined => {
		if (typeof value !== "string") return undefined;
		const trimmed = value.trim();
		if (!trimmed) return undefined;
		if (/^(default|none|clear|off)$/i.test(trimmed)) return undefined;
		return trimmed;
	};

	pi.registerFlag("agent", {
		description: "Main-session role agent to use (must have availability: main or both)",
		type: "string",
		default: "",
	});
	pi.registerFlag("profile", {
		description: "Main-session capability profile to use",
		type: "string",
		default: "",
	});
	pi.registerFlag("effort", {
		description: "Main-session effort preset to use",
		type: "string",
		default: "",
	});
	pi.registerFlag("profile-name", {
		description: "Profile name to use for permissions (overrides PI_PROFILE_NAME env var)",
		type: "string",
		default: "",
	});

	pi.on("session_start", async (_event, ctx) => {
		taskProjectTrustState = undefined;
		const canonicalCwd = canonicalizeTaskProjectCwd(ctx.cwd);
		const projectResourcesPresent = hasProjectTaskResources(canonicalCwd);
		const trusted = await resolveTaskProjectTrust(ctx);
		taskProjectTrustState = {
			canonicalCwd,
			sessionId: ctx.sessionManager.getSessionId?.(),
			projectResourcesPresent,
			trusted,
		};
		ensureMainSessionBaseline(ctx, pi);
		syncTaskUiChrome(ctx);
		startupCompositionError = undefined;
		const rawCliAgent = pi.getFlag("agent");
		const rawCliProfile = pi.getFlag("profile");
		const rawCliEffort = pi.getFlag("effort");
		const hasCliSelection = [rawCliAgent, rawCliProfile, rawCliEffort].some(
			(value) => typeof value === "string" && value.trim().length > 0,
		);
		const cliSelection = {
			agent: normalizeMainAgentSelection(rawCliAgent),
			profile: normalizeMainAgentSelection(rawCliProfile),
			effort: normalizeMainAgentSelection(rawCliEffort),
		};
		const persisted = getPersistedMainAgentState(ctx.sessionManager.getBranch());
		if (hasCliSelection) {
			const result = await applyMainSessionAgentSelection(ctx, pi, cliSelection, {
				persist:
					!persisted.found ||
					persisted.agent !== cliSelection.agent ||
					persisted.profile !== cliSelection.profile ||
					persisted.effort !== cliSelection.effort,
				notify: false,
			});
			if (result.ok) return;
			activeMainWorker = undefined;
			startupCompositionError = result.error;
			syncRuntimeEnv(pi, {});
			if (ctx.hasUI) ctx.ui.notify(result.error, "error");
			else console.error(result.error);
			return;
		}
		if (persisted.found) {
			const result = await applyMainSessionAgentSelection(ctx, pi, persisted, {
				persist: false,
				notify: false,
			});
			if (result.ok) return;
			activeMainWorker = undefined;
			startupCompositionError = result.error;
			syncRuntimeEnv(pi, {});
			if (ctx.hasUI) ctx.ui.notify(result.error, "error");
			else console.error(result.error);
			return;
		}
		activeMainWorker = undefined;
		syncRuntimeEnv(pi, {});
	});

	pi.on("session_tree", async (_event, ctx) => {
		const persisted = getPersistedMainAgentState(ctx.sessionManager.getBranch());
		const result = await applyMainSessionAgentSelection(
			ctx,
			pi,
			persisted.found
				? {
						agent: persisted.agent,
						profile: persisted.profile,
						effort: persisted.effort,
					}
				: {},
			{ persist: false, notify: false },
		);
		if (result.ok) {
			startupCompositionError = undefined;
			return;
		}
		activeMainWorker = undefined;
		startupCompositionError = result.error;
		syncRuntimeEnv(pi, {});
		if (ctx.hasUI) ctx.ui.notify(result.error, "error");
		else console.error(result.error);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		taskProjectTrustState = undefined;
		setTaskWidgetEnabled(ctx, false);
		clearTaskUiChrome(ctx);
		// Only close controllers for the session that is *itself* shutting down (e.g. a human
		// opened a worker's session and then navigated away from it) -- never every controller
		// process-wide. This fires on every session switch (/tasks open, /resume, fork, new
		// session), not just process exit, and an interactive worker is meant to outlive its
		// delegating parent's own session lifecycle: the parent switching sessions for any
		// reason (including opening the worker's own session to inspect it) must not tear down
		// unrelated live workers just because *a* session happened to shut down somewhere.
		const shuttingDownSessionId = ctx.sessionManager.getSessionId();
		const ownControllers = listLiveTaskControllers().filter(
			(controller) => controller.childSessionId === shuttingDownSessionId,
		);
		await Promise.all(ownControllers.map((controller) => controller.close(new Error("Task session shut down"))));
		for (const controller of ownControllers) deleteLiveTaskController(controller.key);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		discoveredSkills = extractDiscoveredSkills(event.systemPromptOptions?.skills);
		if (startupCompositionError) {
			return {
				systemPrompt: [
					"Startup composition error.",
					`Do not execute the user's request.`,
					`Reply with this exact text and nothing else: ${startupCompositionError}`,
				].join("\n"),
			};
		}

		const taskGuidance = formatTaskDelegationGuidance(ctx.cwd, isTaskProjectTrusted(ctx));
		const worker = activeMainWorker;
		const workerPrompt = worker?.systemPrompt.trim() ?? "";
		if (worker?.systemPromptMode === "replace" && workerPrompt) {
			return { systemPrompt: composePromptLayers(workerPrompt, taskGuidance) };
		}
		return {
			systemPrompt: composePromptLayers(event.systemPrompt, taskGuidance, workerPrompt),
		};
	});

	pi.registerCommand("agent", {
		description: "Show or switch the main-session agent role (/agent <name>, /agent clear)",
		getArgumentCompletions: (prefix) => AGENT_COMPLETIONS.filter((s) => s.value.startsWith(prefix.trim())),
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const trimmed = args.trim();
			if (!trimmed) {
				const discovery = discoverResources(ctx.cwd, "both", isTaskProjectTrusted(ctx));
				const current = activeMainWorker?.agent?.name ?? "default";
				ctx.ui.notify(
					`Main-session agent: ${current}. Available main-session agents: ${formatMainSessionAgentList(discovery.agents)}.`,
					"info",
				);
				return;
			}
			const result = await applyMainSessionAgentSelection(
				ctx,
				pi,
				{
					agent: normalizeMainAgentSelection(trimmed),
					profile: activeMainWorker?.profile?.name,
					effort: activeMainWorker?.effort?.name,
				},
				{ persist: true, notify: true },
			);
			if (result.ok) {
				startupCompositionError = undefined;
				return;
			}
			ctx.ui.notify(result.error, "error");
		},
	});
	pi.registerCommand("profile", {
		description: "Show or switch the main-session profile (/profile <name>, /profile clear)",
		getArgumentCompletions: (prefix) => PROFILE_COMPLETIONS.filter((s) => s.value.startsWith(prefix.trim())),
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const trimmed = args.trim();
			if (!trimmed) {
				const current = activeMainWorker?.profile?.name ?? "none";
				ctx.ui.notify(`Main-session profile: ${current}.`, "info");
				return;
			}
			const result = await applyMainSessionAgentSelection(
				ctx,
				pi,
				{
					agent: activeMainWorker?.agent?.name,
					profile: normalizeMainAgentSelection(trimmed),
					effort: activeMainWorker?.effort?.name,
				},
				{ persist: true, notify: true },
			);
			if (result.ok) {
				startupCompositionError = undefined;
				return;
			}
			ctx.ui.notify(result.error, "error");
		},
	});
	pi.registerCommand("effort", {
		description: "Show or switch the main-session effort (/effort <name>, /effort clear)",
		getArgumentCompletions: (prefix) => EFFORT_COMPLETIONS.filter((s) => s.value.startsWith(prefix.trim())),
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const trimmed = args.trim();
			if (!trimmed) {
				const current = activeMainWorker?.effort?.name ?? "none";
				ctx.ui.notify(`Main-session effort: ${current}.`, "info");
				return;
			}
			const result = await applyMainSessionAgentSelection(
				ctx,
				pi,
				{
					agent: activeMainWorker?.agent?.name,
					profile: activeMainWorker?.profile?.name,
					effort: normalizeMainAgentSelection(trimmed),
				},
				{ persist: true, notify: true },
			);
			if (result.ok) {
				startupCompositionError = undefined;
				return;
			}
			ctx.ui.notify(result.error, "error");
		},
	});

	const tasksCommand = {
		description: `Inspect persisted task child sessions. Usage: ${TASKS_COMMAND_USAGE}`,
		getArgumentCompletions: (prefix: string) => TASKS_COMPLETIONS.filter((s) => s.value.startsWith(prefix.trim())),
		handler: async (args, ctx) => {
			try {
				const parsed = parseTasksCommand(args);
				if (parsed.action === "parent" || parsed.action === "origin") {
					await ctx.waitForIdle();
				}
				if (parsed.error) {
					ctx.ui.notify(`${parsed.error}. Usage: ${TASKS_COMMAND_USAGE}`, "error");
					return;
				}

				if (parsed.action === "toggle") {
					if (!ctx.hasUI) {
						ctx.ui.notify("Task widget toggle is only available with UI.", "warning");
						return;
					}
					const nextEnabled = !isTaskWidgetEnabled(ctx);
					if (!setTaskWidgetEnabled(ctx, nextEnabled)) {
						ctx.ui.notify("Could not resolve the current session identity for /tasks toggle.", "error");
						return;
					}
					syncTaskUiChrome(ctx);
					ctx.ui.notify(
						nextEnabled
							? "Tasks widget enabled for this session."
							: "Tasks widget hidden for this session.",
						"info",
					);
					return;
				}

				if (parsed.action === "parent") {
					const currentSessionFile = ctx.sessionManager.getSessionFile?.();
					if (!currentSessionFile) {
						ctx.ui.notify(
							"Current session is not persisted. No parent session can be resolved automatically (detached or non-persisted session).",
							"error",
						);
						return;
					}

					const parentResolution = await resolveParentSessionForCurrentSession(
						currentSessionFile,
						ctx.sessionManager.getBranch(),
					);
					if (!parentResolution.resolved) {
						const baseMessage = parentResolution.error ?? "Failed to resolve parent session.";
						const guidance = parentResolution.noParent
							? ""
							: '\nIf you know the parent session file, open it via /resume or run: pi --session "<parent-session-file>"';
						ctx.ui.notify(`${baseMessage}${guidance}`, "error");
						return;
					}

					const parentSessionPath = parentResolution.resolved.parentSessionPath;
					const normalizedCurrentSessionPath = normalizeSessionPathForComparison(currentSessionFile);
					const normalizedParentSessionPath = normalizeSessionPathForComparison(parentSessionPath);

					if (normalizedParentSessionPath === normalizedCurrentSessionPath) {
						ctx.ui.notify(
							"Resolved parent session points to the current session. Refusing to open the same session file.",
							"error",
						);
						return;
					}
					if (!fs.existsSync(parentSessionPath)) {
						ctx.ui.notify(
							`Resolved parent session is missing: ${shortenHomePath(parentSessionPath)}.\n${manualParentSessionOpenInstruction(parentSessionPath)}`,
							"error",
						);
						return;
					}

					const openedMessage = "Opened parent session (from child session header).";

					const openResult = await tryOpenTaskSession(ctx as unknown, parentSessionPath, {
						withSession: async (replacementCtx) => {
							await notifyTaskSessionOpened(replacementCtx, openedMessage);
						},
					});
					if (openResult.opened) return;

					ctx.ui.notify(
						`${openResult.message}\n${manualParentSessionOpenInstruction(parentSessionPath)}`,
						"warning",
					);
					return;
				}

				const runs = reconstructCurrentTaskRuns({
					entries: ctx.sessionManager.getBranch(),
					sourceSessionFile: ctx.sessionManager.getSessionFile?.(),
					customType: TASK_CHILD_SESSION_CUSTOM_TYPE,
					metadataVersion: TASK_CHILD_SESSION_METADATA_VERSION,
					extraLiveStepKeys: collectLiveTaskControllerStepKeys(ctx.sessionManager.getSessionFile?.()),
				});

				if (runs.length === 0) {
					ctx.ui.notify(TASKS_NO_CURRENT_RUNS_MESSAGE, "info");
					return;
				}

				if (parsed.action === "list") {
					if (
						await withTaskWidgetTemporarilyHidden(ctx, (onReplacement) =>
							browseTaskRuns(ctx, parsed.scope, runs, onReplacement),
						)
					)
						return;
					ctx.ui.notify(formatTaskRunList(parsed.scope, runs), "info");
					return;
				}

				const selector = parsed.selector?.trim();
				if (!selector) {
					ctx.ui.notify(`Missing selector. Usage: ${TASKS_COMMAND_USAGE}`, "error");
					return;
				}

				const resolved = resolveTaskSelector(selector, runs);
				if (resolved.error || !resolved.resolution) {
					ctx.ui.notify(resolved.error ?? `No task run matches selector "${selector}".`, "error");
					return;
				}

				const { run, step } = resolved.resolution;
				const selectedStep = step as TaskRunStepView | undefined;
				if (parsed.action === "view") {
					await showTaskRunView(ctx, parsed.scope, run, selectedStep);
					return;
				}
				if (parsed.action === "origin") {
					const originResult = await revealTaskRunOrigin(ctx, run, selectedStep);
					ctx.ui.notify(originResult.message, originResult.level);
					syncTaskUiChrome(ctx);
					return;
				}
				if (parsed.action === "steer") {
					const message = parsed.message?.trim();
					if (!message) {
						ctx.ui.notify(`Missing steering message. Usage: ${TASKS_COMMAND_USAGE}`, "error");
						return;
					}
					const steerResult = await sendTaskSteeringMessage(run, selectedStep, message);
					ctx.ui.notify(steerResult.message, steerResult.level);
					syncTaskUiChrome(ctx);
					return;
				}

				// Only wait for idle when actually opening a finished session (a structural
				// session-replacement operation) -- attaching to a still-running step must work
				// *while* the outer task tool call is in progress, exactly like view/steer; waiting
				// here would silently hang until that call returns.
				const openTargetStep = selectTaskRunStepForOpen(run, selectedStep);
				const openTargetIsLive =
					!!openTargetStep &&
					isLiveController(getLiveTaskController(makeTaskRunStepKey(run.runId, openTargetStep.step)));
				if (!openTargetIsLive) await ctx.waitForIdle();
				const openResult = await openTaskRunSession(ctx, run, selectedStep);
				if (!openResult.opened) {
					if (openResult.message) ctx.ui.notify(openResult.message, openResult.level);
					syncTaskUiChrome(ctx);
				}
			} catch (error) {
				ctx.ui.notify(
					`/tasks command failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	} satisfies Parameters<ExtensionAPI["registerCommand"]>[1];

	pi.registerCommand("tasks", tasksCommand);
	pi.registerCommand("task", {
		...tasksCommand,
		description: `Alias for /tasks. Usage: ${TASKS_COMMAND_USAGE}`,
	});

	pi.registerShortcut(TASKS_BROWSER_SHORTCUT, {
		description: "Browse task runs in the current session",
		handler: async (ctx) => {
			const runs = reconstructCurrentTaskRuns({
				entries: ctx.sessionManager.getBranch(),
				sourceSessionFile: ctx.sessionManager.getSessionFile?.(),
				customType: TASK_CHILD_SESSION_CUSTOM_TYPE,
				metadataVersion: TASK_CHILD_SESSION_METADATA_VERSION,
				extraLiveStepKeys: collectLiveTaskControllerStepKeys(ctx.sessionManager.getSessionFile?.()),
			});
			if (runs.length === 0) {
				ctx.ui.notify(TASKS_NO_CURRENT_RUNS_MESSAGE, "info");
				return;
			}
			if (
				await withTaskWidgetTemporarilyHidden(ctx, (onReplacement) =>
					browseTaskRuns(ctx, "current", runs, onReplacement),
				)
			)
				return;
			ctx.ui.notify(formatTaskRunList("current", runs), "info");
		},
	});

	pi.registerTool({
		name: "task",
		label: "Task",
		description:
			"Delegate to agents in the background. Use mode=parallel for independent steps, chain for {previous}; persist is config-only. " +
			"Returns an acknowledgment immediately; the real result is delivered later as a new message when the worker finishes.",
		promptSnippet:
			"Delegate substantial focused work to specialized agents; each step needs `agent` or behavioral `prompt`. Runs in the background -- do not wait or poll for the result.",
		promptGuidelines: [
			"Use `task` for substantial focused delegation; skip it for trivial work.",
			"Every `task` step must define worker behavior: set `agent` (for example `reviewer`, `thinker`, or `implementer`) or provide a behavioral `prompt`; do not send bare `{ task: ... }` steps.",
			'Use `mode: "parallel"` for independent steps and `mode: "chain"` only when later steps need `{previous}`.',
			"`task` always runs in the background: this call returns only an acknowledgment, and the actual result arrives later as a separate message once the worker finishes. Do not poll, check status in a loop, or block waiting for it -- continue with other work and react when that message arrives.",
			"Never report, summarize, or assume a delegated result before its message actually arrives. If you haven't received it yet, the work is not done -- do not fabricate what the worker probably found or say it succeeded.",
			'In `mode: "parallel"`, expect one such message per step as each one finishes, not a single combined summary at the end.',
			"If a result says the worker needs input (it called `ask_caller`, or an interactive worker paused without finishing), reply by calling `task` again with that result's `resumeSessionId` and your reply as `task` -- do not start a fresh delegation for the same work.",
		],
		parameters: SubagentParams,
		prepareArguments: prepareTaskToolArguments,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const normalizedParams = normalizeTaskToolParams(params as unknown);
			const agentScope: AgentScope = normalizedParams.agentScope ?? "user";
			const projectTrusted = isTaskProjectTrusted(ctx);
			const discovery = discoverResources(ctx.cwd, agentScope, projectTrusted);
			const callableAgents = getTaskCallableAgents(discovery);
			const stepsToRun = normalizedParams.steps ?? [];
			const requestedMode = normalizedParams.mode;
			const mode = requestedMode ?? (stepsToRun.length === 1 ? "single" : undefined);
			const detailMode: TaskExecutionMode = isTaskExecutionMode(mode) ? mode : "single";

			let sessionRunId: string | undefined;
			let childMetadataRunId: string | undefined;
			const makeDetails =
				(mode: TaskExecutionMode) =>
				(results: SingleResult[]): TaskDetails => {
					const childSessions = results.flatMap((stepResult) =>
						stepResult.childSession ? [stepResult.childSession] : [],
					);
					return {
						mode,
						agentScope,
						projectAgentsDir: discovery.projectAgentsDir,
						results,
						sessionRunId,
						toolCallId,
						childSessions: childSessions.length > 0 ? childSessions : undefined,
					};
				};
			const previewTaskError = (message: string): string => truncateOutput(message);
			const throwTaskError = (message: string, details: TaskDetails): never => {
				const error = new Error(previewTaskError(message)) as Error & { details?: TaskDetails };
				error.details = details;
				throw error;
			};

			// Recursion depth guard
			const depthCheck = checkSubagentDepth();
			if (depthCheck.blocked) {
				throwTaskError(
					`Task depth limit reached (depth ${depthCheck.depth}, max ${depthCheck.maxDepth}). Nested task delegation is blocked to prevent runaway recursion.`,
					makeDetails(detailMode)([]),
				);
			}

			const invalidParameters = (message: string) => {
				const available = callableAgents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text" as const,
							text: `${message}\nAvailable task agents: ${available}`,
						},
					],
					details: makeDetails(detailMode)([]),
				};
			};

			if (stepsToRun.length === 0) {
				return invalidParameters("Invalid parameters. Provide at least one task step in `steps`.");
			}
			if (!requestedMode && stepsToRun.length > 1) {
				return invalidParameters('Invalid parameters. Set `mode` to "parallel" or "chain" for multiple steps.');
			}
			if (!mode || !isTaskExecutionMode(mode)) {
				return invalidParameters(
					'Invalid parameters. Provide `steps` and optional `mode` ("single", "parallel", or "chain").',
				);
			}
			if (mode === "single" && stepsToRun.length !== 1) {
				return invalidParameters("Invalid parameters. Single mode requires exactly one step.");
			}

			const resumeStep = stepsToRun.find((step) => step.resumeSessionId);
			if (resumeStep) {
				if (mode !== "single" || stepsToRun.length !== 1) {
					return invalidParameters(
						'Invalid parameters. `resumeSessionId` is only supported with a single step in mode: "single".',
					);
				}
				const target = findLiveWorkerBySessionId(resumeStep.resumeSessionId!);
				if (!target) {
					return {
						content: [
							{
								type: "text",
								text: `No live worker session found for resumeSessionId "${resumeStep.resumeSessionId}" -- it may have already finished or been closed.`,
							},
						],
						details: makeDetails("single")([]),
					};
				}

				const workerPromise = resumeWorkerRun({
					controller: target,
					task: resumeStep.task,
					signal,
					parentCtx: ctx,
				});
				void workerPromise.then((result) => {
					if (shouldSuppressTaskPingback(result)) return;
					void deliverTaskPingback(
						pi,
						buildSingleStepPingbackText(result),
						{
							mode: "single",
							toolCallId,
							result,
						},
						ctx.sessionManager,
					);
				});

				return {
					content: [
						{
							type: "text",
							text: `Resumed ${target.agent}'s session in the background. You'll be notified when it finishes${target.interactive ? " or needs input" : ""}.`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			const taskOrigin = resolveTaskOriginForBranch(
				ctx.sessionManager.getBranch(),
				createTaskPreview,
				ctx.sessionManager.getLeafId?.(),
			);

			if (hasRuntimePersistOverride(params)) {
				throwTaskError(
					"Invalid parameters. Runtime persist overrides are not supported.",
					makeDetails(mode)([]),
				);
			}

			if (mode !== "chain") {
				const invalidStep = stepsToRun.findIndex((step) => hasPreviousPlaceholder(step.task));
				if (invalidStep !== -1) {
					throwTaskError(
						`Invalid task at step ${invalidStep + 1}: {previous} is only supported in chain mode.`,
						makeDetails(mode)([]),
					);
				}
			}

			if (mode === "parallel" && stepsToRun.length > MAX_PARALLEL_TASKS) {
				throwTaskError(
					`Too many parallel tasks (${stepsToRun.length}). Max is ${MAX_PARALLEL_TASKS}.`,
					makeDetails("parallel")([]),
				);
			}

			let preparedSteps: PreparedTaskStep[] = [];

			const preflight = await preflightTaskRun(
				mode,
				stepsToRun,
				discovery,
				ctx.cwd,
				ctx.sessionManager,
				projectTrusted,
			);
			if (preflight.error || !preflight.prepared) {
				throwTaskError(preflight.error ?? "Failed to prepare task run.", makeDetails(mode)([]));
			}
			const preparedRun = preflight.prepared!;
			sessionRunId = preparedRun.sessionRunId;
			preparedSteps = preparedRun.steps;
			childMetadataRunId = sessionRunId ?? `${toolCallId}-run`;

			if (mode === "chain") {
				const runChain = async (): Promise<SingleResult[]> => {
					const results: SingleResult[] = [];
					let previousOutput = "";

					for (let i = 0; i < preparedSteps.length; i++) {
						const preparedStep = preparedSteps[i];
						if (!preparedStep) continue;
						const taskWithContext = preparedStep.rawStep.task.replace(/\{previous\}/g, previousOutput);

						const chainUpdate: OnUpdateCallback | undefined = onUpdate
							? (partial) => {
									const currentResult = partial.details?.results[0];
									if (currentResult) {
										const allResults = [...results, currentResult];
										onUpdate({
											content: partial.content,
											details: makeDetails("chain")(allResults),
										});
									}
								}
							: undefined;

						const result = await runTaskStepWithMetadata({
							preparedStep,
							task: taskWithContext,
							mode: "chain",
							step: preparedStep.step,
							toolCallId: toolCallId,
							runId: childMetadataRunId,
							signal,
							onUpdate: chainUpdate,
							makeDetails: makeDetails("chain"),
							sessionManager: ctx.sessionManager,
							origin: taskOrigin,
							refreshUi: () => syncTaskUiChrome(ctx),
							parentCtx: ctx,
						});
						results.push(result);

						if (isTaskStepError(result)) {
							const errorMsg = previewTaskError(
								result.errorMessage ||
									result.stderr ||
									getFinalOutput(result.messages) ||
									"(no output)",
							);
							throwTaskError(
								`Chain stopped at step ${preparedStep.step} (${preparedStep.rawStep.agent ?? preparedStep.rawStep.profile ?? "generic"}): ${errorMsg}\n\n${formatChainResults(results)}`,
								makeDetails("chain")(results),
							);
						}
						previousOutput = truncateOutput(getFinalOutput(result.messages));
					}
					return results;
				};

				// Chain steps run sequentially in the background -- {previous} needs each step's
				// real output, so this can't fan out like parallel mode -- with a single pingback
				// once the whole chain settles (or stops early on a failing step).
				void runChain()
					.then((results) => {
						void deliverTaskPingback(
							pi,
							`Task chain (${results.length} step${results.length === 1 ? "" : "s"}) finished:\n\n${formatChainResults(results)}`,
							{ mode: "chain", toolCallId, sessionRunId, results },
							ctx.sessionManager,
						);
					})
					.catch((error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						const details = (error as { details?: TaskDetails } | undefined)?.details;
						void deliverTaskPingback(
							pi,
							`Task chain stopped:\n\n${message}`,
							{
								mode: "chain",
								toolCallId,
								sessionRunId,
								results: details?.results ?? [],
							},
							ctx.sessionManager,
						);
					});

				return {
					content: [
						{
							type: "text",
							text: `Started a ${preparedSteps.length}-step chain in the background. You'll be notified with the final result.`,
						},
					],
					details: makeDetails("chain")([]),
				};
			}

			if (mode === "parallel") {
				const allResults: SingleResult[] = new Array(preparedSteps.length);
				for (let i = 0; i < preparedSteps.length; i++) {
					const preparedStep = preparedSteps[i];
					if (!preparedStep) continue;
					allResults[i] = {
						agent: preparedStep.worker.displayAgentName,
						agentSource: preparedStep.worker.agent?.source ?? "unknown",
						profile: preparedStep.worker.profile?.name,
						effort: preparedStep.worker.effort?.name,
						skills: preparedStep.worker.skills,
						task: preparedStep.rawStep.task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0,
							contextTokens: 0,
							turns: 0,
						},
						model: preparedStep.worker.model,
						step: preparedStep.step,
						sessionMode: preparedStep.session.mode,
						sessionPersist: preparedStep.session.persist,
						sessionFile: preparedStep.session.sessionFile,
						uiNotices: [],
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{
									type: "text",
									text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
								},
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const totalSteps = preparedSteps.length;
				const pingbackStep = (result: SingleResult, index: number) => {
					if (shouldSuppressTaskPingback(result)) return;
					void deliverTaskPingback(
						pi,
						buildSingleStepPingbackText(result, { index, total: totalSteps }),
						{
							mode: "parallel",
							toolCallId,
							sessionRunId,
							step: index,
							result,
						},
						ctx.sessionManager,
					);
				};

				// Each step gets its own pingback the moment it finishes -- the caller already
				// knows how many are running, so an aggregated summary at the end would just delay
				// news it could act on sooner.
				void mapWithConcurrencyLimit<PreparedTaskStep, SingleResult>(
					preparedSteps,
					MAX_CONCURRENCY,
					async (preparedStep, index) => {
						const result = await runTaskStepWithMetadata({
							preparedStep,
							task: preparedStep.rawStep.task,
							mode: "parallel",
							step: preparedStep.step,
							toolCallId: toolCallId,
							runId: childMetadataRunId,
							signal,
							onUpdate: (partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									emitParallelUpdate();
								}
							},
							makeDetails: makeDetails("parallel"),
							sessionManager: ctx.sessionManager,
							origin: taskOrigin,
							refreshUi: () => syncTaskUiChrome(ctx),
							parentCtx: ctx,
						});
						allResults[index] = result;
						emitParallelUpdate();
						pingbackStep(result, index);
						return result;
					},
					{
						isCancelled: () => signal?.aborted === true,
						onCancelled: (_preparedStep, index) => {
							const pendingResult = allResults[index];
							if (!pendingResult)
								throw new Error(
									`Internal error: missing pending result for parallel step ${index + 1}.`,
								);
							const cancelled: SingleResult = {
								...pendingResult,
								exitCode: 130,
								stopReason: "aborted" as const,
								errorMessage: "Task was aborted before starting",
							};
							allResults[index] = cancelled;
							emitParallelUpdate();
							pingbackStep(cancelled, index);
							return cancelled;
						},
					},
				);

				return {
					content: [
						{
							type: "text",
							text: `Delegated ${totalSteps} task${totalSteps === 1 ? "" : "s"} in parallel in the background. You'll get a ping as each one finishes.`,
						},
					],
					details: makeDetails("parallel")([...allResults]),
				};
			}

			if (mode === "single") {
				const preparedStep = preparedSteps[0]!;
				const workerPromise = runTaskStepWithMetadata({
					preparedStep,
					task: preparedStep.rawStep.task,
					mode: "single",
					step: preparedStep.step,
					toolCallId: toolCallId,
					runId: childMetadataRunId,
					signal,
					onUpdate,
					makeDetails: makeDetails("single"),
					sessionManager: ctx.sessionManager,
					origin: taskOrigin,
					refreshUi: () => syncTaskUiChrome(ctx),
					parentCtx: ctx,
				});
				void workerPromise.then((result) => {
					if (shouldSuppressTaskPingback(result)) return;
					void deliverTaskPingback(
						pi,
						buildSingleStepPingbackText(result),
						{
							mode: "single",
							toolCallId,
							sessionRunId,
							result,
						},
						ctx.sessionManager,
					);
				});

				return {
					content: [
						{
							type: "text",
							text: `Delegated to ${preparedStep.worker.displayAgentName} in the background. You'll be notified when it finishes${preparedStep.worker.interactive ? " or needs input" : ""}.`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			const available = callableAgents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [
					{
						type: "text",
						text: `Invalid parameters. Available task agents: ${available}`,
					},
				],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const normalizedArgs = normalizeTaskToolParams(args as unknown);
			const steps = normalizedArgs.steps ?? [];
			const mode = normalizedArgs.mode ?? (steps.length > 1 ? "parallel" : "single");
			if (mode === "chain" && steps.length > 0) {
				const tasks = steps.map((step) => step.task.replace(/\{previous\}/g, "").trim());
				const text =
					formatTaskCallHeading("chain", theme, steps.length) +
					formatTaskSnippetLines(tasks, theme.fg.bind(theme), {
						numbered: true,
					});
				return new Text(text, 0, 0);
			}
			if (mode === "parallel" && steps.length > 0) {
				const text =
					formatTaskCallHeading("parallel", theme, steps.length) +
					formatTaskSnippetLines(
						steps.map((step) => step.task),
						theme.fg.bind(theme),
					);
				return new Text(text, 0, 0);
			}
			const task = steps[0]?.task ?? "...";
			const text =
				formatTaskCallHeading("simple", theme) +
				formatTaskSnippetLines([task], theme.fg.bind(theme), {
					maxItems: 1,
					maxLength: 80,
				});
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TaskDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
						continue;
					}
					if (item.type === "toolCall") {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
						continue;
					}
					if (!expanded) continue;
					const icon = item.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
					text += `${theme.fg("muted", "↳ ")}${icon} ${theme.fg("muted", `${item.name} result`)}\n`;
					if (item.text) text += `${theme.fg(item.isError ? "error" : "dim", item.text)}\n`;
					if (item.diff) text += `${theme.fg("muted", "diff available")}\n`;
				}
				return text.trimEnd();
			};

			const appendExpandedTaskResult = (container: Container, r: SingleResult, header: string) => {
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				container.addChild(new Text(header, 0, 0));
				if (isError && r.errorMessage)
					container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
				container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Configuration ───"), 0, 0));
				container.addChild(new Text(formatTaskConfigurationLines(r, theme.fg.bind(theme)), 0, 0));
				if (r.childSession) {
					container.addChild(
						new Text(formatChildSessionExpanded(r.childSession, theme.fg.bind(theme)), 0, 0),
					);
				}
				if ((r.uiNotices?.length ?? 0) > 0) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Notices ───"), 0, 0));
					container.addChild(
						new Text(formatTaskInlineNoticeLines(r.uiNotices ?? [], theme.fg.bind(theme)), 0, 0),
					);
				}
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
				appendTaskOutputSection(container, displayItems, finalOutput, theme.fg.bind(theme));
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
				}
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				if (!r) return new Text("(no output)", 0, 0);
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);

				if (expanded) {
					const container = new Container();
					let header = formatTaskHeader(
						{
							leadingIcon: icon,
							agent: r.agent,
							agentColor: "toolTitle",
							boldAgent: true,
							taskResult: r,
						},
						theme,
					);
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					appendExpandedTaskResult(container, r, header);
					return container;
				}

				let text = formatTaskHeader(
					{
						leadingIcon: icon,
						agent: r.agent,
						agentColor: "toolTitle",
						boldAgent: true,
						taskResult: r,
					},
					theme,
				);
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (r.childSession) text += `\n${formatChildSessionCompact(r.childSession, theme.fg.bind(theme))}`;
				if ((r.uiNotices?.length ?? 0) > 0)
					text += `\n${formatTaskInlineNoticeLines(r.uiNotices ?? [], theme.fg.bind(theme))}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0 && (r.uiNotices?.length ?? 0) === 0)
					text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT)
						text += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					turns: 0,
				};
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon =
					successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");

						container.addChild(new Spacer(1));
						const stepHeader = formatTaskHeader(
							{
								prefix: theme.fg("muted", `─── Step ${r.step}: `),
								agent: r.agent,
								taskResult: r,
								suffix: ` ${rIcon}`,
							},
							theme,
						);
						appendExpandedTaskResult(container, r, stepHeader);
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${formatTaskHeader(
						{
							prefix: theme.fg("muted", `─── Step ${r.step}: `),
							agent: r.agent,
							taskResult: r,
							suffix: ` ${rIcon}`,
						},
						theme,
					)}`;
					if (r.childSession) text += `\n${formatChildSessionCompact(r.childSession, theme.fg.bind(theme))}`;
					if ((r.uiNotices?.length ?? 0) > 0)
						text += `\n${formatTaskInlineNoticeLines(r.uiNotices ?? [], theme.fg.bind(theme))}`;
					if (displayItems.length === 0 && (r.uiNotices?.length ?? 0) === 0)
						text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon =
							r.exitCode === -1
								? theme.fg("warning", "⏳")
								: r.exitCode === 0
									? theme.fg("success", "✓")
									: theme.fg("error", "✗");

						container.addChild(new Spacer(1));
						const taskHeader = formatTaskHeader(
							{
								prefix: theme.fg("muted", "─── "),
								agent: r.agent,
								taskResult: r,
								suffix: ` ${rIcon}`,
							},
							theme,
						);
						appendExpandedTaskResult(container, r, taskHeader);
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${formatTaskHeader(
						{
							prefix: theme.fg("muted", "─── "),
							agent: r.agent,
							taskResult: r,
							suffix: ` ${rIcon}`,
						},
						theme,
					)}`;
					if (r.childSession) text += `\n${formatChildSessionCompact(r.childSession, theme.fg.bind(theme))}`;
					if ((r.uiNotices?.length ?? 0) > 0)
						text += `\n${formatTaskInlineNoticeLines(r.uiNotices ?? [], theme.fg.bind(theme))}`;
					if (displayItems.length === 0 && (r.uiNotices?.length ?? 0) === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// Registered globally -- like `task` itself -- so every worker (a separate `pi --mode rpc`
	// process running this same extension) has them available regardless of its own tools/
	// excludeTools configuration. Their execute() bodies are static acknowledgments: the worker
	// process has no access to the delegating parent's liveTaskControllers registry (different
	// process, different memory), so completion/ping detection happens on the PARENT side
	// instead -- the RpcWorkerHandle's own event-stream watcher sees these calls via
	// tool_execution_start events (see task-rpc-worker.ts) and sets the controlOutcome that
	// finalizeWorkerRun consumes, well before (and independent of) these execute() bodies
	// finishing.
	pi.registerTool({
		name: TASK_COMPLETE_TOOL_NAME,
		label: "Task Complete",
		description:
			"Call this when you have finished the delegated task and are ready to report back. " +
			"Write `summary` as your actual answer to whoever delegated this to you, not a status update " +
			'(e.g. "Found 3 callers of foo(), listed below" rather than "Done searching"). ' +
			"Calling this ends your session -- the caller is notified automatically; you do not need to say anything else.",
		parameters: Type.Object({
			summary: Type.String({ description: "Your final answer, to be delivered to the caller as the result." }),
		}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			return {
				content: [{ type: "text", text: "Reported completion to the caller. Ending session." }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: ASK_CALLER_TOOL_NAME,
		label: "Ask Caller",
		description:
			"Call this when you're stuck, need clarification, or need the caller to do something before you can " +
			"make progress -- not for routine tool-permission prompts. `message` is delivered to the caller " +
			"immediately. Your session stays alive and waits; the caller answers by delegating a follow-up back " +
			"to this same session (they are given your session reference for that). Call this once and then " +
			"actually stop -- do not call it again to check whether an answer has arrived, and do not guess an " +
			"answer yourself and keep going.",
		parameters: Type.Object({
			message: Type.String({ description: "What you need from the caller." }),
		}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			return {
				content: [{ type: "text", text: "Sent your question to the caller. Waiting for a response." }],
				details: {},
			};
		},
	});
}

export const __test__ = {
	AGENT_COMPLETIONS,
	PROFILE_COMPLETIONS,
	EFFORT_COMPLETIONS,
	TASKS_COMPLETIONS,
	addTaskInlineNotice,
	buildTaskInlineNoticeLines,
	hasRuntimePersistOverride,
	normalizeTaskToolParams,
	prepareTaskToolArguments,
	formatTaskRunList,
	formatParallelResults,
	formatChainResults,
	truncateOutput,
	formatTaskHeader,
	formatTaskConfigurationLines,
	formatToolCall,
	getDisplayItems,
	getFinalOutput,
	shouldDisplayTaskInlineNotice,
	buildTaskWidgetLines,
	normalizeChildSessionSnapshot: (data: unknown) =>
		normalizeChildSessionSnapshot(data, TASK_CHILD_SESSION_METADATA_VERSION),
	buildWorkerSessionSpec,
	resolveWorkerProjectTrust,
	getPersistedMainAgentState,
	parseTasksCommand,
	preflightTaskRun,
	relayTaskExtensionUiRequest,
	resolveModelFromEffort,
	formatTaskDelegationGuidance,
	resolveParentSessionForCurrentSession,
	resolveTaskOriginForBranch: (entries: readonly SessionEntry[], leafId?: string | null) =>
		resolveTaskOriginForBranch(entries, createTaskPreview, leafId),
	resolveWorkerConfig,
	loadRequiredSkillInstructions,
	composeWorkerSystemPrompt,
	prepareWorkerSystemPrompt,
	resolveTaskSelector,
	setTaskWidgetEnabled,
	mapWithConcurrencyLimit,
	appendBoundedText,
	estimateBytes,
	pushBoundedMessage,
	runSingleAgentViaAgentSession,
	runTaskStepWithMetadata,
	isTaskStepError,
	composeTaskResultBody,
	shouldSuppressTaskPingback,
	buildSingleStepPingbackText,
	deliverTaskPingback,
	finalizeWorkerRun,
	resumeWorkerRun,
	findLiveWorkerBySessionId,
	resolveLiveTaskControllerForRun,
	describeTaskRunAccess,
	// Narrow seams for deterministic replacement-safety tests.
	tryOpenTaskSession,
	openTaskRunSession,
	revealTaskRunOrigin,
	showTaskRunView,
	sendAttachMessage,
	withTaskWidgetTemporarilyHidden,
};
