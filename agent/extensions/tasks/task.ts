/**
 * Task Tool - Delegate work to specialized agents
 *
 * Spawns a separate `pi` process for each delegated task,
 * with fresh/fork child-session context and optional persisted sessions.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from delegated agents.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, type SessionEntry, getMarkdownTheme, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { MAIN_SESSION_AGENT_CUSTOM_TYPE } from "../agent-state";
import {
	type AgentConfig,
	type AgentScope,
	type ContextMode,
	type ModelTierConfig,
	type ProfileConfig,
	type ResourceDiscoveryResult,
	discoverResources,
	resolveSkillPaths,
} from "./agents.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const TASK_SESSION_ROOT = path.join(os.homedir(), ".pi", "agent", "extensions", "tasks", "sessions");
const TASK_SESSION_VERSION_FALLBACK = 3;
const TASK_CHILD_SESSION_CUSTOM_TYPE = "tasks.child-session";
const TASK_CHILD_SESSION_METADATA_VERSION = 1;
const TASKS_PARENT_SESSION_ROOT = path.join(os.homedir(), ".pi", "agent", "sessions");
const TASKS_NO_CURRENT_RUNS_MESSAGE = "No task runs in current session. Try /tasks recent.";
const TASKS_COMMAND_USAGE = [
	"/tasks",
	"/tasks list",
	"/tasks recent",
	"/tasks show <selector>",
	"/tasks open <selector>",
	"/tasks recent show <selector>",
	"/tasks recent open <selector>",
].join(" | ");
const TASK_SELECTOR_CANDIDATE_LIMIT = 8;

type TaskExecutionMode = "single" | "parallel" | "chain";
type ChildSessionStatus = "created" | "succeeded" | "failed" | "aborted";
type TasksScope = "current" | "recent";
type TasksAction = "list" | "show" | "open";
type TaskRunStepStatus = ChildSessionStatus | "running" | "interrupted" | "not-persisted";
type TaskRunStatus = "running" | "interrupted" | "failed" | "aborted" | "succeeded" | "not-persisted";

// Recursion depth guard
const DEFAULT_MAX_SUBAGENT_DEPTH = 2;

function checkSubagentDepth(): { blocked: boolean; depth: number; maxDepth: number } {
	const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const maxDepth = Number.isFinite(Number(process.env.PI_SUBAGENT_MAX_DEPTH))
		? Number(process.env.PI_SUBAGENT_MAX_DEPTH)
		: DEFAULT_MAX_SUBAGENT_DEPTH;
	return { blocked: Number.isFinite(depth) && depth >= maxDepth, depth, maxDepth };
}

function getSubagentDepthEnv(): Record<string, string> {
	const current = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const next = Number.isFinite(current) ? current + 1 : 1;
	const max = process.env.PI_SUBAGENT_MAX_DEPTH ?? String(DEFAULT_MAX_SUBAGENT_DEPTH);
	return { PI_SUBAGENT_DEPTH: String(next), PI_SUBAGENT_MAX_DEPTH: max };
}

// Output truncation
const MAX_OUTPUT_BYTES = 200 * 1024; // 200 KB
const MAX_OUTPUT_LINES = 5000;

function truncateOutput(text: string): string {
	const lines = text.split("\n");
	const bytes = Buffer.byteLength(text, "utf-8");
	if (bytes <= MAX_OUTPUT_BYTES && lines.length <= MAX_OUTPUT_LINES) return text;

	let truncated = lines.length > MAX_OUTPUT_LINES ? lines.slice(0, MAX_OUTPUT_LINES) : lines;
	let result = truncated.join("\n");
	if (Buffer.byteLength(result, "utf-8") > MAX_OUTPUT_BYTES) {
		let lo = 0;
		let hi = result.length;
		while (lo < hi) {
			const mid = Math.floor((lo + hi + 1) / 2);
			if (Buffer.byteLength(result.slice(0, mid), "utf-8") <= MAX_OUTPUT_BYTES) lo = mid;
			else hi = mid - 1;
		}
		result = result.slice(0, lo);
	}
	const keptLines = result.split("\n").length;
	const keptBytes = Buffer.byteLength(result, "utf-8");
	return `[TRUNCATED: showing first ${keptLines} of ${lines.length} lines, ${keptBytes} of ${bytes} bytes]\n${result}`;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatTaskExecutionSelection(
	selection: { profile?: string; modelTier?: string },
	themeFg: (color: any, text: string) => string,
): string {
	const parts: string[] = [];
	if (selection.profile) {
		parts.push(themeFg("muted", "profile: ") + themeFg("accent", selection.profile));
	}
	if (selection.modelTier) {
		parts.push(themeFg("muted", "model-tier: ") + themeFg("accent", selection.modelTier));
	}
	return parts.join(themeFg("muted", " · "));
}

function formatTaskExecutionContext(
	agentSource: string | undefined,
	sessionMode: ContextMode | undefined,
	themeFg: (color: any, text: string) => string,
): string {
	const source = agentSource ?? "unknown";
	const mode = sessionMode ?? "fresh";
	return themeFg("muted", ` (${source}:${mode})`);
}

function formatTaskExecutionMetadata(
	taskResult: { agentSource?: string; sessionMode?: ContextMode; profile?: string; modelTier?: string },
	themeFg: (color: any, text: string) => string,
): string {
	const context = formatTaskExecutionContext(taskResult.agentSource, taskResult.sessionMode, themeFg);
	const selection = formatTaskExecutionSelection(taskResult, themeFg);
	return selection ? `${context}${themeFg("muted", " · ")}${selection}` : context;
}

function formatTaskHeader(
	options: {
		agent: string;
		taskResult: { agentSource?: string; sessionMode?: ContextMode; profile?: string; modelTier?: string };
		prefix?: string;
		leadingIcon?: string;
		suffix?: string;
		agentColor?: any;
		boldAgent?: boolean;
	},
	theme: { fg: (color: any, text: string) => string; bold: (text: string) => string },
): string {
	const parts: string[] = [];
	if (options.leadingIcon) parts.push(`${options.leadingIcon} `);
	if (options.prefix) parts.push(options.prefix);
	const agentText = options.boldAgent ? theme.bold(options.agent) : options.agent;
	parts.push(theme.fg(options.agentColor ?? "accent", agentText));
	parts.push(formatTaskExecutionMetadata(options.taskResult, theme.fg.bind(theme)));
	if (options.suffix) parts.push(options.suffix);
	return parts.join("");
}

function formatTaskCallHeading(
	kind: "simple" | "chain" | "parallel",
	theme: { fg: (color: any, text: string) => string; bold: (text: string) => string },
	count?: number,
): string {
	let heading = theme.fg("toolTitle", theme.bold("task ")) + theme.fg("accent", kind);
	if (kind === "chain" && count !== undefined) heading += theme.fg("muted", ` (${count} steps)`);
	if (kind === "parallel" && count !== undefined) heading += theme.fg("muted", ` (${count} tasks)`);
	return heading;
}

function formatTaskSnippetLines(
	tasks: string[],
	themeFg: (color: any, text: string) => string,
	options: { numbered?: boolean; maxItems?: number; maxLength?: number } = {},
): string {
	const maxItems = options.maxItems ?? 3;
	const maxLength = options.maxLength ?? 50;
	let text = "";
	for (let i = 0; i < Math.min(tasks.length, maxItems); i++) {
		const preview = tasks[i].length > maxLength ? `${tasks[i].slice(0, maxLength)}...` : tasks[i];
		const index = options.numbered ? `${themeFg("muted", `${i + 1}.`)} ` : "";
		text += `\n  ${index}${themeFg("dim", preview)}`;
	}
	if (tasks.length > maxItems) text += `\n  ${themeFg("muted", `... +${tasks.length - maxItems} more`)}`;
	return text;
}

function appendTaskOutputSection(
	container: Container,
	displayItems: DisplayItem[],
	finalOutput: string,
	mdTheme: ReturnType<typeof getMarkdownTheme>,
	themeFg: (color: any, text: string) => string,
): void {
	if (displayItems.length === 0 && !finalOutput) {
		container.addChild(new Text(themeFg("muted", "(no output)"), 0, 0));
		return;
	}
	for (const item of displayItems) {
		if (item.type !== "toolCall") continue;
		container.addChild(new Text(themeFg("muted", "→ ") + formatToolCall(item.name, item.args, themeFg), 0, 0));
	}
	if (finalOutput) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
	}
}

function shortenHomePath(filePath: string): string {
	const home = os.homedir();
	return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenHomePath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenHomePath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenHomePath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenHomePath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenHomePath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenHomePath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface TaskStepConfig {
	agent?: string;
	profile?: string;
	modelTier?: string;
	task: string;
	cwd?: string;
	model?: string;
	skills?: string[];
	prompt?: string;
	context?: ContextMode;
}

interface ChildSessionSnapshot {
	v: number;
	runId: string;
	toolCallId: string;
	mode: TaskExecutionMode;
	step: number;
	childSessionId: string;
	childSessionPath: string;
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

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	profile?: string;
	modelTier?: string;
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
}

interface TaskDetails {
	mode: TaskExecutionMode;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	sessionRunId?: string;
	sessionRunRoot?: string;
	toolCallId?: string;
	childSessions?: ChildSessionSnapshot[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function createTaskPreview(task: string, maxLength = 120): string {
	const compact = task.replace(/\s+/g, " ").trim();
	if (!compact) return "(empty task)";
	return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function resolveChildSessionTerminalStatus(result: SingleResult): Exclude<ChildSessionStatus, "created"> {
	if (result.stopReason === "aborted") return "aborted";
	if (result.exitCode === 0 && result.stopReason !== "error") return "succeeded";
	return "failed";
}

function formatChildSessionStatus(
	status: ChildSessionStatus,
	themeFg: (color: any, text: string) => string,
): string {
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

function formatChildSessionCompact(snapshot: ChildSessionSnapshot, themeFg: (color: any, text: string) => string): string {
	const shortId = snapshot.childSessionId.slice(0, 8);
	return [
		themeFg("muted", "session: "),
		themeFg("accent", shortId),
		themeFg("muted", " · "),
		formatChildSessionStatus(snapshot.status, themeFg),
	].join("");
}

function formatChildSessionExpanded(snapshot: ChildSessionSnapshot, themeFg: (color: any, text: string) => string): string {
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
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-task-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function normalizeLegacyModelName(model: string | undefined): string | undefined {
	if (!model || model.includes("/")) return model;
	return model.replace(/(\d)-(\d)(?=(?:\D|$))/g, "$1.$2");
}

type OnUpdateCallback = (partial: AgentToolResult<TaskDetails>) => void;

interface ResolvedWorkerConfig {
	agent?: AgentConfig;
	profile?: ProfileConfig;
	modelTier?: ModelTierConfig;
	model?: string;
	skills?: string[];
	tools?: string[];
	context: {
		mode: ContextMode;
		project: boolean;
		skills: boolean;
	};
	persist: boolean;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
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
	return getTaskCallableAgents(resources)
		.map((a) => `${a.name} (${a.source})`)
		.join(", ") || "none";
}

function formatProfileList(resources: ResourceDiscoveryResult): string {
	return resources.profiles.filter((profile) => profile.enabled).map((profile) => `${profile.name} (${profile.source})`).join(", ") || "none";
}

function formatModelTierList(resources: ResourceDiscoveryResult): string {
	return resources.modelTiers.map((tier) => `${tier.name} (${tier.source})`).join(", ") || "none";
}

function composePromptLayers(...layers: string[]): string {
	const trimmed = layers.map((layer) => layer.trim()).filter(Boolean);
	return trimmed.join("\n\n---\n\n");
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
	for (const value of values) {
		if (value !== undefined) return value;
	}
	return undefined;
}

function resolveModelFromTier(
	model: string | undefined,
	modelTierName: string | undefined,
	resources: ResourceDiscoveryResult,
): { model?: string; modelTier?: ModelTierConfig; error?: string } {
	if (model) return { model: normalizeLegacyModelName(model) };
	if (!modelTierName) return {};
	const tier = resources.modelTiers.find((candidate) => candidate.name === modelTierName);
	if (!tier) {
		return {
			error: `Unknown model-tier: "${modelTierName}". Available model-tiers: ${formatModelTierList(resources)}.`,
		};
	}
	return { model: normalizeLegacyModelName(tier.model), modelTier: tier };
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
			return { error: `Agent "${step.agent}" is not task-callable (availability: main).` };
		}
		if (context === "main" && agent.availability === "task") {
			return { error: `Agent "${step.agent}" is not main-session callable (availability: task).` };
		}
	}

	const profileName = step.profile ?? agent?.defaultProfile;
	const profile = profileName ? resources.profiles.find((candidate) => candidate.name === profileName) : undefined;
	if (profileName) {
		if (!profile) {
			return { error: `Unknown profile: "${profileName}". Available profiles: ${formatProfileList(resources)}.` };
		}
		if (!profile.enabled) return { error: `Profile "${profileName}" is disabled.` };
	}

	const resolvedModel = resolveModelFromTier(step.model ?? agent?.model, step.modelTier ?? agent?.defaultModelTier, resources);
	if (resolvedModel.error) return { error: resolvedModel.error };

	const skills = step.skills ?? agent?.defaultSkills;
	const prompt = composePromptLayers(profile?.systemPrompt ?? "", agent?.systemPrompt ?? "", step.prompt ?? "");
	const tools = agent?.tools ?? profile?.tools;
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
	}> = [{
		source: "runtime step context",
		mode: step.context,
	}];
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
		firstDefined(agentContextProject, profileContextProject, projectTaskDefaults?.context?.project, globalTaskDefaults?.context?.project) ??
		false;
	const effectiveContextSkills =
		firstDefined(agentContextSkills, profileContextSkills, projectTaskDefaults?.context?.skills, globalTaskDefaults?.context?.skills) ??
		false;
	const effectivePersist = firstDefined(agentPersist, profilePersist, projectTaskDefaults?.persist, globalTaskDefaults?.persist) ?? true;

	const inheritProjectContext = agent?.inheritProjectContext ?? profile?.inheritProjectContext ?? false;
	const inheritSkills = agent?.inheritSkills ?? profile?.inheritSkills ?? false;

	if ((options.requireBehavior ?? true) && !agent && !prompt.trim()) {
		return {
			error:
				"Invalid task configuration. Provide an agent or a behavioral prompt. Generic workers require `prompt` when no `agent` is selected.",
		};
	}

	return {
		config: {
			agent,
			profile,
			modelTier: resolvedModel.modelTier,
			model: resolvedModel.model,
			skills,
			tools,
			context: {
				mode: effectiveContextMode,
				project: effectiveContextProject,
				skills: effectiveContextSkills,
			},
			persist: effectivePersist,
			inheritProjectContext,
			inheritSkills,
			systemPrompt: prompt,
			systemPromptMode,
			displayAgentName,
		},
	};
}

interface MainSessionBaseline {
	sessionId: string;
	model?: { provider: string; id: string };
	tools: string[];
}

interface PersistedMainAgentState {
	found: boolean;
	agent?: string;
	profile?: string;
	modelTier?: string;
}

let mainSessionBaseline: MainSessionBaseline | undefined;
let activeMainWorker: ResolvedWorkerConfig | undefined;
let startupCompositionError: string | undefined;

function isMainSessionCallableAgent(agent: AgentConfig): boolean {
	return agent.enabled && (agent.availability === "main" || agent.availability === "both");
}

function getMainSessionCallableAgents(agents: AgentConfig[]): AgentConfig[] {
	return agents.filter(isMainSessionCallableAgent);
}

function formatMainSessionAgentList(agents: AgentConfig[]): string {
	return getMainSessionCallableAgents(agents).map((agent) => `${agent.name} (${agent.source})`).join(", ") || "none";
}

function getCurrentModelRef(ctx: { model?: { provider: string; id: string } }): { provider: string; id: string } | undefined {
	return ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
}

function ensureMainSessionBaseline(
	ctx: {
		model?: { provider: string; id: string };
		sessionManager: { getSessionId(): string };
	},
	piApi: Pick<ExtensionAPI, "getActiveTools">,
): void {
	const sessionId = ctx.sessionManager.getSessionId();
	if (mainSessionBaseline?.sessionId === sessionId) return;
	mainSessionBaseline = {
		sessionId,
		model: getCurrentModelRef(ctx),
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

function getPersistedMainAgentState(entries: SessionEntry[]): PersistedMainAgentState {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== MAIN_SESSION_AGENT_CUSTOM_TYPE) continue;
		const data = (entry.data ?? {}) as Record<string, unknown>;
		return {
			found: true,
			agent: typeof data.agent === "string" ? data.agent : undefined,
			profile: typeof data.profile === "string" ? data.profile : undefined,
			modelTier: typeof data.modelTier === "string" ? data.modelTier : undefined,
		};
	}
	return { found: false };
}

function persistMainAgentSelection(
	ctx: { sessionManager: { getBranch(): SessionEntry[]; appendCustomEntry(customType: string, data?: unknown): string } },
	state: { agent?: string; profile?: string; modelTier?: string },
): void {
	const current = getPersistedMainAgentState(ctx.sessionManager.getBranch());
	if (current.found && current.agent === state.agent && current.profile === state.profile && current.modelTier === state.modelTier) return;
	ctx.sessionManager.appendCustomEntry(MAIN_SESSION_AGENT_CUSTOM_TYPE, {
		agent: state.agent ?? null,
		profile: state.profile ?? null,
		modelTier: state.modelTier ?? null,
	});
}

function syncRuntimeEnv(
	piApi: Pick<ExtensionAPI, "getFlag">,
	state: { agent?: string; profile?: string },
): void {
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
	piApi: Pick<ExtensionAPI, "setModel" | "setActiveTools">,
): Promise<string | undefined> {
	if (!mainSessionBaseline) return undefined;
	if (mainSessionBaseline.model) {
		const baselineModel = ctx.modelRegistry.find(mainSessionBaseline.model.provider, mainSessionBaseline.model.id) as
			| { provider: string; id: string }
			| undefined;
		if (!baselineModel) {
			return `Baseline model not found: ${mainSessionBaseline.model.provider}/${mainSessionBaseline.model.id}.`;
		}
		const success = await piApi.setModel(baselineModel as never);
		if (!success) {
			return `No API key available for baseline model ${mainSessionBaseline.model.provider}/${mainSessionBaseline.model.id}.`;
		}
	}
	piApi.setActiveTools([...mainSessionBaseline.tools]);
	return undefined;
}

async function applyMainSessionAgentSelection(
	ctx: {
		cwd: string;
		hasUI: boolean;
		ui: { confirm(title: string, message: string): Promise<boolean>; notify(message: string, level: "info" | "warning" | "error"): void };
		model?: { provider: string; id: string };
		modelRegistry: { find(provider: string, modelId: string): unknown };
		sessionManager: { getSessionId(): string; getBranch(): SessionEntry[]; appendCustomEntry(customType: string, data?: unknown): string };
	},
	piApi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "getFlag" | "setActiveTools" | "setModel">,
	selection: { agent?: string; profile?: string; modelTier?: string },
	options: { persist?: boolean; notify?: boolean; confirmProjectAgent?: boolean } = {},
): Promise<{ ok: true; worker?: ResolvedWorkerConfig } | { ok: false; error: string }> {
	ensureMainSessionBaseline(ctx, piApi);
	const resources = discoverResources(ctx.cwd, "both");

	if (selection.agent) {
		const role = resources.agents.find((candidate) => candidate.name === selection.agent);
		if (!role) {
			return { ok: false, error: `Unknown agent: "${selection.agent}". Available main-session agents: ${formatMainSessionAgentList(resources.agents)}.` };
		}
		if (!role.enabled) return { ok: false, error: `Agent "${selection.agent}" is disabled.` };
		if (role.availability === "task") return { ok: false, error: `Agent "${selection.agent}" is not main-session callable (availability: task).` };
		if (options.confirmProjectAgent && role.source === "project" && ctx.hasUI) {
			const ok = await ctx.ui.confirm(
				"Switch to project-local agent?",
				`Agent: ${role.name}\nSource: ${role.filePath}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
			);
			if (!ok) return { ok: false, error: "Canceled: project-local agent not approved." };
		}
	}

	if (!selection.agent && !selection.profile && !selection.modelTier) {
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
			modelTier: selection.modelTier,
			task: "main-session",
			prompt: undefined,
		},
		resources,
		{ requireBehavior: false, context: "main" },
	);
	if (resolved.error || !resolved.config) {
		return { ok: false, error: resolved.error ?? "Failed to resolve main-session worker configuration." };
	}
	const worker = resolved.config;

	const allToolNames = new Set(piApi.getAllTools().map((tool) => tool.name));
	if (worker.tools !== undefined) {
		const invalidTools = worker.tools.filter((tool) => !allToolNames.has(tool));
		if (invalidTools.length > 0) {
			return { ok: false, error: `Unknown tools in main-session composition: ${invalidTools.join(", ")}.` };
		}
	}

	if (worker.model) {
		const resolvedModel = parseAgentModelSpec(worker.model, ctx.model);
		if (!resolvedModel) {
			return { ok: false, error: `Could not resolve model for main session: ${worker.model}.` };
		}
		const model = ctx.modelRegistry.find(resolvedModel.provider, resolvedModel.modelId) as { provider: string; id: string } | undefined;
		if (!model) return { ok: false, error: `Model not found for main session: ${resolvedModel.provider}/${resolvedModel.modelId}.` };
		const success = await piApi.setModel(model as never);
		if (!success) return { ok: false, error: `No API key available for model ${resolvedModel.provider}/${resolvedModel.modelId}.` };
	} else {
		const restoreError = await restoreMainSessionBaseline(ctx, piApi);
		if (restoreError) return { ok: false, error: restoreError };
	}

	if (worker.tools !== undefined) piApi.setActiveTools([...worker.tools]);
	else if (mainSessionBaseline) piApi.setActiveTools([...mainSessionBaseline.tools]);

	activeMainWorker = worker;
	syncRuntimeEnv(piApi, { agent: worker.agent?.name, profile: worker.profile?.permissionsProfile ?? worker.profile?.name });
	if (options.persist) persistMainAgentSelection(ctx, selection);
	if (options.notify) {
		ctx.ui.notify(
			`Main session: ${selection.agent ?? "generic"}${selection.profile ? ` + ${selection.profile}` : ""}${selection.modelTier ? ` + ${selection.modelTier}` : ""}`,
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
	session: {
		mode: ContextMode;
		persist: boolean;
		sessionFile?: string;
		sessionId?: string;
		stepDir?: string;
	};
}

interface PreparedTaskRun {
	mode: TaskExecutionMode;
	steps: PreparedTaskStep[];
	sessionRunId?: string;
	sessionRunRoot?: string;
}

function hasRuntimePersistOverride(params: unknown): boolean {
	if (!params || typeof params !== "object") return false;
	const record = params as Record<string, unknown>;
	if (Object.prototype.hasOwnProperty.call(record, "persist")) return true;
	const arrays = [record.tasks, record.chain];
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

function sanitizeStepLabel(step: TaskStepConfig, index: number): string {
	const base = (step.agent ?? step.profile ?? "generic")
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32) || "generic";
	return `${String(index + 1).padStart(2, "0")}-${base}`;
}

function createTaskRunId(): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `${timestamp}_${randomUUID().slice(0, 8)}`;
}

function cloneSessionEntries(entries: SessionEntry[]): SessionEntry[] {
	return entries.map((entry) => JSON.parse(JSON.stringify(entry)) as SessionEntry);
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	});
}

async function writeFreshSessionFile(filePath: string, childCwd: string): Promise<string> {
	const sessionId = randomUUID();
	const header = {
		type: "session",
		version: TASK_SESSION_VERSION_FALLBACK,
		id: sessionId,
		timestamp: new Date().toISOString(),
		cwd: childCwd,
	};
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, `${JSON.stringify(header)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
	});
	return sessionId;
}

async function writeForkedSessionFile(
	filePath: string,
	parentSessionFile: string,
	parentEntries: SessionEntry[],
	childCwd: string,
): Promise<string> {
	const sourceHeader = parentEntries.find((entry) => entry.type === "session") as
		| (SessionEntry & { type: "session"; version?: number })
		| undefined;
	if (!sourceHeader) {
		throw new Error("Parent session snapshot has no header.");
	}
	const sessionId = randomUUID();
	const header = {
		type: "session",
		version: typeof sourceHeader.version === "number" ? sourceHeader.version : TASK_SESSION_VERSION_FALLBACK,
		id: sessionId,
		timestamp: new Date().toISOString(),
		cwd: childCwd,
		parentSession: parentSessionFile,
	};
	const lines = [JSON.stringify(header)];
	for (const entry of parentEntries) {
		if (entry.type === "session") continue;
		lines.push(JSON.stringify(entry));
	}
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, `${lines.join("\n")}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
	});
	return sessionId;
}

async function preflightTaskRun(
	mode: TaskExecutionMode,
	steps: TaskStepConfig[],
	resources: ResourceDiscoveryResult,
	defaultCwd: string,
	sessionManager: { getSessionFile?: () => string | undefined; getBranch(): SessionEntry[] },
): Promise<{ prepared?: PreparedTaskRun; error?: string }> {
	const preparedSteps: PreparedTaskStep[] = [];
	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		if (step.context !== undefined && step.context !== "fresh" && step.context !== "fork") {
			return { error: `Invalid context.mode at step ${i + 1}: "${String(step.context)}". Expected "fresh" or "fork".` };
		}
		const resolved = resolveWorkerConfig(step, resources);
		if (resolved.error || !resolved.config) {
			return { error: resolved.error ?? `Failed to resolve step ${i + 1}.` };
		}
		const worker = resolved.config;
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
			session: {
				mode: worker.context.mode,
				persist: worker.persist,
			},
		});
	}

	const needsPersistedSessions = preparedSteps.some((step) => step.session.persist);
	const needsFork = preparedSteps.some((step) => step.session.mode === "fork");

	let parentSessionFile: string | undefined;
	let parentSnapshot: SessionEntry[] = [];
	if (needsFork) {
		parentSessionFile = sessionManager.getSessionFile?.();
		if (!parentSessionFile) {
			return { error: "context.mode=\"fork\" requires a parent session file, but the current session is unavailable." };
		}
		const branch = sessionManager.getBranch();
		if (!branch.some((entry) => entry.type === "session")) {
			return { error: "context.mode=\"fork\" requires a valid parent session snapshot, but none was found." };
		}
		parentSnapshot = cloneSessionEntries(branch);
	}

	let sessionRunId: string | undefined;
	let sessionRunRoot: string | undefined;
	let sessionStepsRoot: string | undefined;

	if (needsPersistedSessions) {
		sessionRunId = createTaskRunId();
		sessionRunRoot = path.join(TASK_SESSION_ROOT, sessionRunId);
		sessionStepsRoot = path.join(sessionRunRoot, "steps");
		try {
			await fs.promises.mkdir(sessionStepsRoot, { recursive: true });
			await writeJsonFile(path.join(sessionRunRoot, "run.json"), {
				runId: sessionRunId,
				createdAt: new Date().toISOString(),
				mode,
				stepCount: preparedSteps.length,
				persistedStepCount: preparedSteps.filter((step) => step.session.persist).length,
				parentSessionFile: parentSessionFile ?? null,
			});
		} catch (error) {
			return {
				error: `Failed to create task session root at ${sessionRunRoot}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	for (let i = 0; i < preparedSteps.length; i++) {
		const preparedStep = preparedSteps[i];
		const stepLabel = sanitizeStepLabel(preparedStep.rawStep, i);
		if (sessionStepsRoot) {
			preparedStep.session.stepDir = path.join(sessionStepsRoot, stepLabel);
			try {
				await fs.promises.mkdir(preparedStep.session.stepDir, { recursive: true });
			} catch (error) {
				return {
					error: `Failed to create session directory for step ${i + 1}: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}

		if (!preparedStep.session.persist) {
			if (preparedStep.session.stepDir) {
				try {
					await writeJsonFile(path.join(preparedStep.session.stepDir, "step.json"), {
						step: i + 1,
						mode: preparedStep.session.mode,
						persist: false,
						cwd: preparedStep.launchCwd,
						agent: preparedStep.worker.agent?.name ?? null,
						profile: preparedStep.worker.profile?.name ?? null,
						sessionFile: null,
					});
				} catch (error) {
					return {
						error: `Failed to write step metadata for step ${i + 1}: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
			}
			continue;
		}

		if (!preparedStep.session.stepDir) {
			return { error: `Internal error: missing step directory for persisted step ${i + 1}.` };
		}

		const sessionFile = path.join(preparedStep.session.stepDir, "child-session.jsonl");
		let sessionId: string;
		try {
			if (preparedStep.session.mode === "fresh") {
				sessionId = await writeFreshSessionFile(sessionFile, preparedStep.launchCwd);
			} else {
				if (!parentSessionFile) {
					return { error: `Step ${i + 1} cannot fork because parent session is unavailable.` };
				}
				sessionId = await writeForkedSessionFile(sessionFile, parentSessionFile, parentSnapshot, preparedStep.launchCwd);
			}
		} catch (error) {
			return {
				error: `Failed to create child session for step ${i + 1}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		preparedStep.session.sessionFile = sessionFile;
		preparedStep.session.sessionId = sessionId;
		try {
			await writeJsonFile(path.join(preparedStep.session.stepDir, "step.json"), {
				step: i + 1,
				mode: preparedStep.session.mode,
				persist: true,
				cwd: preparedStep.launchCwd,
				agent: preparedStep.worker.agent?.name ?? null,
				profile: preparedStep.worker.profile?.name ?? null,
				sessionId,
				sessionFile,
			});
		} catch (error) {
			return {
				error: `Failed to write step metadata for step ${i + 1}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	return {
		prepared: {
			mode,
			steps: preparedSteps,
			sessionRunId,
			sessionRunRoot,
		},
	};
}

async function runSingleAgent(
	preparedStep: PreparedTaskStep,
	task: string,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => TaskDetails,
	initialChildSession?: ChildSessionSnapshot,
): Promise<SingleResult> {
	const worker = preparedStep.worker;
	const agent = worker.agent;
	const args: string[] = ["--mode", "json", "-p"];
	if (preparedStep.session.persist) {
		if (!preparedStep.session.sessionFile) {
			return {
				agent: worker.displayAgentName,
				agentSource: agent?.source ?? "unknown",
				profile: worker.profile?.name,
				modelTier: worker.modelTier?.name,
				task,
				exitCode: 1,
				messages: [],
				stderr: "Missing child session file for persisted task step.",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				model: worker.model,
				step,
				sessionMode: preparedStep.session.mode,
				sessionPersist: preparedStep.session.persist,
				sessionFile: preparedStep.session.sessionFile,
				childSession: initialChildSession ? { ...initialChildSession } : undefined,
			};
		}
		args.push("--session", preparedStep.session.sessionFile);
	} else {
		args.push("--no-session");
	}

	const agentModel = worker.model;
	if (agentModel) args.push("--model", agentModel);
	if (worker.modelTier?.thinkingLevel) args.push("--thinking", worker.modelTier.thinkingLevel);
	if (worker.tools !== undefined) {
		if (worker.tools.length > 0) args.push("--tools", worker.tools.join(","));
		else args.push("--no-tools");
	}
	if (!worker.inheritProjectContext) args.push("--no-context-files");

	if (worker.skills && worker.skills.length > 0) {
		const { paths, missing } = resolveSkillPaths(worker.skills, preparedStep.launchCwd);
		if (missing.length > 0) {
			return {
				agent: worker.displayAgentName,
				agentSource: agent?.source ?? "unknown",
				profile: worker.profile?.name,
				modelTier: worker.modelTier?.name,
				task,
				exitCode: 1,
				messages: [],
				stderr: `Failed to resolve required skills for worker "${worker.displayAgentName}": ${missing.join(", ")}.`,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				model: agentModel,
				step,
				sessionMode: preparedStep.session.mode,
				sessionPersist: preparedStep.session.persist,
				sessionFile: preparedStep.session.sessionFile,
				childSession: initialChildSession ? { ...initialChildSession } : undefined,
			};
		}
		args.push("--no-skills");
		for (const skillPath of paths) args.push("--skill", skillPath);
	} else if (!worker.inheritSkills) {
		args.push("--no-skills");
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: worker.displayAgentName,
		agentSource: agent?.source ?? "unknown",
		profile: worker.profile?.name,
		modelTier: worker.modelTier?.name,
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
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		const composedPrompt = worker.systemPrompt;
		if (composedPrompt.trim()) {
			const tmp = await writePromptToTempFile(worker.displayAgentName, composedPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			const promptFlag = worker.systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt";
			args.push(promptFlag, tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: preparedStep.launchCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					...getSubagentDepthEnv(),
					...(agent ? { PI_AGENT_NAME: agent.name } : {}),
					...(worker.profile ? { PI_PROFILE_NAME: worker.profile.permissionsProfile ?? worker.profile.name } : {}),
				},
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) {
			currentResult.stopReason = "aborted";
			if (!currentResult.errorMessage) currentResult.errorMessage = "Task was aborted";
			if (currentResult.exitCode === 0) currentResult.exitCode = 130;
		}
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

function appendTaskChildSessionMetadata(
	sessionManager: { appendCustomEntry(customType: string, data?: unknown): string },
	snapshot: ChildSessionSnapshot,
): string | undefined {
	try {
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
	sessionManager: { appendCustomEntry(customType: string, data?: unknown): string };
}): Promise<SingleResult> {
	const { preparedStep, task, mode, step, toolCallId, runId, signal, onUpdate, makeDetails, sessionManager } = options;
	const metadataRunId = runId ?? `${toolCallId}-run`;

	let createdSnapshot: ChildSessionSnapshot | undefined;
	if (preparedStep.session.persist && preparedStep.session.sessionFile && preparedStep.session.sessionId) {
		createdSnapshot = {
			v: TASK_CHILD_SESSION_METADATA_VERSION,
			runId: metadataRunId,
			toolCallId,
			mode,
			step,
			childSessionId: preparedStep.session.sessionId,
			childSessionPath: preparedStep.session.sessionFile,
			effectiveContext: preparedStep.session.mode,
			persist: true,
			agent: preparedStep.worker.agent?.name,
			profile: preparedStep.worker.profile?.name,
			taskPreview: createTaskPreview(task),
			createdAt: new Date().toISOString(),
			status: "created",
		};
		const appendError = appendTaskChildSessionMetadata(sessionManager, createdSnapshot);
		if (appendError) {
			const metadataError =
				`Failed to append initial ${TASK_CHILD_SESSION_CUSTOM_TYPE} metadata (status="created"). ` +
				"Persisted child step was not started because parent metadata is authoritative.";
			const fullError = `${metadataError}\n${appendError}`;
			return {
				agent: preparedStep.worker.displayAgentName,
				agentSource: preparedStep.worker.agent?.source ?? "unknown",
				profile: preparedStep.worker.profile?.name,
				modelTier: preparedStep.worker.modelTier?.name,
				task,
				exitCode: 1,
				messages: [],
				stderr: fullError,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
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
		result = await runSingleAgent(
			preparedStep,
			task,
			step,
			signal,
			onUpdate,
			makeDetails,
			createdSnapshot,
		);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const aborted = /aborted/i.test(errorMessage);
		result = {
			agent: preparedStep.worker.displayAgentName,
			agentSource: preparedStep.worker.agent?.source ?? "unknown",
			profile: preparedStep.worker.profile?.name,
			modelTier: preparedStep.worker.modelTier?.name,
			task,
			exitCode: aborted ? 130 : 1,
			messages: [],
			stderr: errorMessage,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
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
			errorMessage: result.errorMessage ?? (result.stderr.trim().length > 0 ? createTaskPreview(result.stderr.trim(), 240) : undefined),
		};
		const appendError = appendTaskChildSessionMetadata(sessionManager, terminalSnapshot);
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

	return result;
}

interface ParsedTasksCommand {
	scope: TasksScope;
	action: TasksAction;
	selector?: string;
	error?: string;
}

interface TaskChildSessionRecord {
	snapshot: ChildSessionSnapshot;
	sourceOrder: number;
	sourceSessionFile?: string;
	sourceSessionId?: string;
}

interface TaskRunStepView {
	step: number;
	snapshot: ChildSessionSnapshot;
	status: TaskRunStepStatus;
	isLive: boolean;
	hasTerminalMetadata: boolean;
	warnings: string[];
	sourceOrder: number;
}

interface TaskRunView {
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

interface TaskSelectorResolution {
	run: TaskRunView;
	step?: TaskRunStepView;
	matchedBy: "runId" | "childSession" | "basename" | "index";
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

function normalizeChildSessionSnapshot(data: unknown): ChildSessionSnapshot | undefined {
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

	return {
		v: typeof data.v === "number" && Number.isFinite(data.v) ? data.v : TASK_CHILD_SESSION_METADATA_VERSION,
		runId: data.runId,
		toolCallId: data.toolCallId,
		mode: data.mode,
		step: data.step,
		childSessionId,
		childSessionPath,
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

function parseTasksCommand(args: string): ParsedTasksCommand {
	const trimmed = args.trim();
	if (!trimmed) return { scope: "current", action: "list" };
	const tokens = trimmed.split(/\s+/).filter(Boolean);
	const lower = tokens.map((token) => token.toLowerCase());

	if (lower[0] === "list") {
		if (tokens.length === 1) return { scope: "current", action: "list" };
		return { scope: "current", action: "list", error: `Unsupported /tasks arguments: ${args}` };
	}

	if (lower[0] === "recent") {
		if (tokens.length === 1) return { scope: "recent", action: "list" };
		if ((lower[1] === "show" || lower[1] === "open") && tokens.length >= 3) {
			return {
				scope: "recent",
				action: lower[1] as TasksAction,
				selector: tokens.slice(2).join(" "),
			};
		}
		return { scope: "recent", action: "list", error: `Unsupported /tasks arguments: ${args}` };
	}

	if ((lower[0] === "show" || lower[0] === "open") && tokens.length >= 2) {
		return {
			scope: "current",
			action: lower[0] as TasksAction,
			selector: tokens.slice(1).join(" "),
		};
	}

	return { scope: "current", action: "list", error: `Unsupported /tasks arguments: ${args}` };
}

function makeTaskRunStepKey(runId: string, step: number): string {
	return `${runId}:${step}`;
}

function toMillis(value: string | undefined): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function getSnapshotEventTimestamp(snapshot: ChildSessionSnapshot): string {
	return snapshot.finishedAt ?? snapshot.createdAt;
}

function formatTimestampCompact(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function collectTaskMetadataRecordsFromEntries(entries: readonly SessionEntry[], sourceSessionFile?: string): TaskChildSessionRecord[] {
	const records: TaskChildSessionRecord[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== TASK_CHILD_SESSION_CUSTOM_TYPE) continue;
		const snapshot = normalizeChildSessionSnapshot(entry.data);
		if (!snapshot) continue;
		records.push({ snapshot, sourceOrder: index, sourceSessionFile });
	}
	return records;
}

function collectLiveTaskRunSteps(entries: readonly SessionEntry[]): Set<string> {
	const live = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!isRecord(message) || message.role !== "toolResult" || message.toolName !== "task") continue;
		const details = message.details;
		if (!isRecord(details)) continue;

		const childSessions = Array.isArray(details.childSessions) ? details.childSessions : [];
		for (const value of childSessions) {
			const snapshot = normalizeChildSessionSnapshot(value);
			if (!snapshot) continue;
			if (snapshot.status === "created") live.add(makeTaskRunStepKey(snapshot.runId, snapshot.step));
		}

		const results = Array.isArray(details.results) ? details.results : [];
		for (const rawResult of results) {
			if (!isRecord(rawResult)) continue;
			const snapshot = normalizeChildSessionSnapshot(rawResult.childSession);
			if (!snapshot) continue;
			const exitCode = typeof rawResult.exitCode === "number" ? rawResult.exitCode : undefined;
			if (snapshot.status === "created" || exitCode === -1) {
				live.add(makeTaskRunStepKey(snapshot.runId, snapshot.step));
			}
		}
	}
	return live;
}

async function listSessionFiles(rootDir: string): Promise<string[]> {
	const files: string[] = [];
	let currentLayer: string[] = [rootDir];
	while (currentLayer.length > 0) {
		const nextLayer: string[] = [];
		for (const dir of currentLayer) {
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) nextLayer.push(fullPath);
				else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
			}
		}
		currentLayer = nextLayer;
	}
	return files;
}

async function collectTaskMetadataRecordsFromSessionFile(sessionFile: string): Promise<TaskChildSessionRecord[]> {
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
					if (isRecord(parsedHeader) && parsedHeader.type === "session" && typeof parsedHeader.id === "string") {
						sourceSessionId = parsedHeader.id;
					}
				} catch {
					// Ignore malformed header line.
				}
			}

			if (!line.includes(TASK_CHILD_SESSION_CUSTOM_TYPE)) continue;

			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (!isRecord(parsed) || parsed.type !== "custom" || parsed.customType !== TASK_CHILD_SESSION_CUSTOM_TYPE) continue;
			const snapshot = normalizeChildSessionSnapshot(parsed.data);
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

function buildTaskRunViews(records: TaskChildSessionRecord[], liveStepKeys: Set<string>): TaskRunView[] {
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
		const orderedRecords = Array.from(byStep.values()).sort((left, right) => left.snapshot.step - right.snapshot.step);
		if (orderedRecords.length === 0) continue;

		const steps: TaskRunStepView[] = orderedRecords.map((record) => {
			const snapshot = record.snapshot;
			const isLive = liveStepKeys.has(makeTaskRunStepKey(snapshot.runId, snapshot.step));
			const status = deriveTaskRunStepStatus(snapshot, isLive);
			const hasTerminalMetadata = snapshot.status !== "created";
			const warnings: string[] = [];

			if (snapshot.persist) {
				if (!snapshot.childSessionPath.trim()) warnings.push("missing child session path (stale metadata)");
				else if (!fs.existsSync(snapshot.childSessionPath)) warnings.push("child session file missing (stale metadata)");
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

		const latestStep = steps.reduce((latest, current) => (current.sourceOrder > latest.sourceOrder ? current : latest), steps[0]!);
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
			updatedAt: updatedAt > 0 ? new Date(updatedAt).toISOString() : getSnapshotEventTimestamp(latestStep.snapshot),
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

async function reconstructRecentTaskRuns(): Promise<TaskRunView[]> {
	if (!fs.existsSync(TASKS_PARENT_SESSION_ROOT)) return [];
	const sessionFiles = await listSessionFiles(TASKS_PARENT_SESSION_ROOT);
	const fileRecords = await mapWithConcurrencyLimit<string, TaskChildSessionRecord[]>(sessionFiles, MAX_CONCURRENCY, async (sessionFile) => {
		return collectTaskMetadataRecordsFromSessionFile(sessionFile);
	});
	const records = fileRecords.flat();
	const runs = buildTaskRunViews(records, new Set<string>());
	return runs.filter((run) => run.persistedStepCount > 0);
}

function reconstructCurrentTaskRuns(entries: readonly SessionEntry[], sourceSessionFile?: string): TaskRunView[] {
	const records = collectTaskMetadataRecordsFromEntries(entries, sourceSessionFile);
	const liveSteps = collectLiveTaskRunSteps(entries);
	return buildTaskRunViews(records, liveSteps);
}

function formatTaskRunSummary(run: TaskRunView, index: number, includeSource: boolean): string {
	const stepLabel = run.stepCount === 1 ? "step" : "steps";
	let text = `${index}. ${run.status} ${run.runId} · ${run.mode} · ${run.stepCount} ${stepLabel} · ${formatTimestampCompact(run.updatedAt)}`;
	if (includeSource && run.sourceSessionFile) {
		text += ` · ${path.basename(run.sourceSessionFile)}`;
	}
	if (run.warnings.length > 0) text += ` · warnings:${run.warnings.length}`;
	return text;
}

function formatTaskRunList(scope: TasksScope, runs: TaskRunView[]): string {
	if (runs.length === 0) {
		return scope === "current" ? TASKS_NO_CURRENT_RUNS_MESSAGE : "No persisted task runs in recent sessions.";
	}
	const header = scope === "current" ? `Task runs in current session (${runs.length}):` : `Recent persisted task runs (${runs.length}):`;
	const includeSource = scope === "recent";
	return [header, ...runs.map((run, index) => formatTaskRunSummary(run, index + 1, includeSource))].join("\n");
}

function formatTaskRunDetails(scope: TasksScope, run: TaskRunView, selectedStep?: TaskRunStepView): string {
	const lines: string[] = [];
	lines.push(`Run: ${run.runId}`);
	lines.push(`Status: ${run.status} · mode: ${run.mode} · steps: ${run.stepCount}`);
	lines.push(`Scope: ${scope}`);
	lines.push(`Created: ${formatTimestampCompact(run.createdAt)} · Updated: ${formatTimestampCompact(run.updatedAt)}`);
	if (run.sourceSessionFile) {
		lines.push(`Source session: ${shortenHomePath(run.sourceSessionFile)}${run.sourceSessionId ? ` (${run.sourceSessionId.slice(0, 8)})` : ""}`);
	}
	if (selectedStep) {
		lines.push(`Selector matched step ${selectedStep.step} (${selectedStep.status}).`);
	}
	lines.push("Steps:");
	for (const step of run.steps) {
		const marker = selectedStep?.step === step.step ? "*" : "-";
		const childShort = step.snapshot.childSessionId.slice(0, 8);
		const persistLabel = step.snapshot.persist ? "persisted" : "not-persisted";
		lines.push(`${marker} ${step.step}. ${step.status} · ${persistLabel} · session ${childShort} · ${step.snapshot.effectiveContext}`);
		lines.push(`   path: ${step.snapshot.childSessionPath ? shortenHomePath(step.snapshot.childSessionPath) : "(missing)"}`);
		if (step.snapshot.taskPreview) lines.push(`   task: ${step.snapshot.taskPreview}`);
		for (const warning of step.warnings) lines.push(`   warning: ${warning}`);
	}
	if (run.warnings.length > 0) {
		lines.push("Warnings:");
		for (const warning of run.warnings) lines.push(`- ${warning}`);
	}
	return lines.join("\n");
}

function formatRunCandidate(run: TaskRunView, runs: TaskRunView[]): string {
	const index = runs.findIndex((candidate) => candidate.internalRunKey === run.internalRunKey);
	const indexLabel = index >= 0 ? `#${index + 1}` : "#?";
	return `${indexLabel} ${run.runId} (${run.status}, ${run.mode})`;
}

function formatStepCandidate(run: TaskRunView, step: TaskRunStepView, runs: TaskRunView[]): string {
	const index = runs.findIndex((candidate) => candidate.internalRunKey === run.internalRunKey);
	const indexLabel = index >= 0 ? `#${index + 1}` : "#?";
	const basename = path.basename(step.snapshot.childSessionPath);
	return `${indexLabel} ${run.runId} step ${step.step} session ${step.snapshot.childSessionId.slice(0, 8)} (${basename})`;
}

function formatAmbiguousSelectorError(
	selector: string,
	kind: string,
	candidates: string[],
): string {
	const shown = candidates.slice(0, TASK_SELECTOR_CANDIDATE_LIMIT);
	const lines = [`Ambiguous selector "${selector}" (${kind}).`, ...shown.map((candidate) => `- ${candidate}`)];
	if (candidates.length > shown.length) lines.push(`- ... ${candidates.length - shown.length} more`);
	return lines.join("\n");
}

function resolveTaskSelector(selector: string, runs: TaskRunView[]): { resolution?: TaskSelectorResolution; error?: string } {
	const trimmed = selector.trim();
	if (!trimmed) return { error: `Missing selector. Usage: ${TASKS_COMMAND_USAGE}` };

	if (/^\d+$/.test(trimmed)) {
		const index = Number.parseInt(trimmed, 10);
		const run = runs[index - 1];
		if (!run) {
			return { error: `List index ${index} is out of range (1-${runs.length}).` };
		}
		return { resolution: { run, matchedBy: "index" } };
	}

	const runIdMatches = runs.filter((run) => run.runId.startsWith(trimmed));
	if (runIdMatches.length === 1) return { resolution: { run: runIdMatches[0]!, matchedBy: "runId" } };
	if (runIdMatches.length > 1) {
		return {
			error: formatAmbiguousSelectorError(trimmed, "runId prefix", runIdMatches.map((run) => formatRunCandidate(run, runs))),
		};
	}

	const childSessionMatches: Array<{ run: TaskRunView; step: TaskRunStepView }> = [];
	for (const run of runs) {
		for (const step of run.steps) {
			if (step.snapshot.childSessionId.startsWith(trimmed)) childSessionMatches.push({ run, step });
		}
	}
	if (childSessionMatches.length === 1) {
		const match = childSessionMatches[0]!;
		return { resolution: { run: match.run, step: match.step, matchedBy: "childSession" } };
	}
	if (childSessionMatches.length > 1) {
		return {
			error: formatAmbiguousSelectorError(
				trimmed,
				"child session id prefix",
				childSessionMatches.map((match) => formatStepCandidate(match.run, match.step, runs)),
			),
		};
	}

	const basenameMatches: Array<{ run: TaskRunView; step: TaskRunStepView }> = [];
	for (const run of runs) {
		for (const step of run.steps) {
			if (path.basename(step.snapshot.childSessionPath) === trimmed) basenameMatches.push({ run, step });
		}
	}
	if (basenameMatches.length === 1) {
		const match = basenameMatches[0]!;
		return { resolution: { run: match.run, step: match.step, matchedBy: "basename" } };
	}
	if (basenameMatches.length > 1) {
		return {
			error: formatAmbiguousSelectorError(
				trimmed,
				"session file basename",
				basenameMatches.map((match) => formatStepCandidate(match.run, match.step, runs)),
			),
		};
	}

	return { error: `No task run matches selector "${trimmed}".` };
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

function manualTaskSessionOpenInstruction(sessionPath: string): string {
	return [
		`Child session path: ${shortenHomePath(sessionPath)}`,
		`Open manually via /resume, or run: pi --session "${sessionPath}"`,
	].join("\n");
}

type TaskSessionWithSessionCallback = (ctx: unknown) => Promise<void> | void;

interface TryOpenTaskSessionOptions {
	withSession?: TaskSessionWithSessionCallback;
	targetSessionId?: string;
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
	await Promise.resolve((notify as (text: string, level?: "info" | "warning" | "error") => unknown).call(ui, message, "info"));
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
			identity.sessionPath = identity.sessionPath ?? pickString(sessionManager.sessionFile) ?? pickString(sessionManager.path);
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
			identity.sessionId = identity.sessionId ?? pickString(sessionManager.sessionId) ?? pickString(sessionManager.id);
		}
	}

	return identity;
}

function sessionIdentityMatchesTarget(identity: SessionIdentity, targetPath: string, targetSessionId?: string): boolean {
	if (identity.sessionPath) {
		const candidatePath = normalizeSessionPathForComparison(identity.sessionPath);
		if (candidatePath === targetPath) return true;
	}
	if (identity.sessionId && targetSessionId) {
		const candidateId = identity.sessionId.trim();
		const expectedId = targetSessionId.trim();
		if (candidateId && expectedId && (candidateId === expectedId || candidateId.startsWith(expectedId) || expectedId.startsWith(candidateId))) {
			return true;
		}
	}
	return false;
}

function isExplicitSessionOpenSuccess(result: unknown): boolean {
	if (result === true) return true;
	if (!isRecord(result)) return false;
	if (result.cancelled === true || result.canceled === true) return false;
	if (result.opened === true || result.ok === true || result.success === true || result.switched === true || result.resumed === true) {
		return true;
	}
	if (typeof result.status === "string") {
		const status = result.status.toLowerCase();
		if (status === "opened" || status === "ok" || status === "success" || status === "switched" || status === "resumed") {
			return true;
		}
	}
	return false;
}

async function tryOpenTaskSession(
	ctx: unknown,
	sessionPath: string,
	options: TryOpenTaskSessionOptions = {},
): Promise<{ opened: boolean; message: string }> {
	if (!isRecord(ctx)) {
		return { opened: false, message: "Session switching is unavailable in this extension context." };
	}

	const descriptors: Array<{ owner: Record<string, unknown>; key: string; supportsOptionsArg: boolean }> = [
		{ owner: ctx, key: "openSession", supportsOptionsArg: true },
		{ owner: ctx, key: "resumeSession", supportsOptionsArg: true },
		{ owner: ctx, key: "switchSession", supportsOptionsArg: true },
	];
	const sessionManager = isRecord(ctx.sessionManager) ? ctx.sessionManager : undefined;
	if (sessionManager) {
		descriptors.push({ owner: sessionManager, key: "openSession", supportsOptionsArg: true });
		descriptors.push({ owner: sessionManager, key: "resumeSession", supportsOptionsArg: true });
		descriptors.push({ owner: sessionManager, key: "switchSession", supportsOptionsArg: true });
		descriptors.push({ owner: sessionManager, key: "open", supportsOptionsArg: false });
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
			await options.withSession?.(replacementCtx);
		};

		const argsToTry: unknown[][] = [];
		if (descriptor.supportsOptionsArg) {
			argsToTry.push([sessionPath, { withSession: withSessionCallback }]);
		}
		argsToTry.push([sessionPath]);

		for (const args of argsToTry) {
			try {
				const result = await Promise.resolve((fn as (...fnArgs: unknown[]) => unknown).call(descriptor.owner, ...args));
				if (openedWithVerifiedReplacementCtx || isExplicitSessionOpenSuccess(result)) {
					return { opened: true, message: `Opened child session via ${descriptor.key}.` };
				}
				if (isRecord(result) && (result.cancelled === true || result.canceled === true)) {
					return { opened: false, message: "Session open canceled." };
				}
				if (result === false) continue;
			} catch (error) {
				if (openedWithVerifiedReplacementCtx) {
					return { opened: true, message: `Opened child session via ${descriptor.key}.` };
				}
				lastError = error instanceof Error ? error.message : String(error);
			}
		}
	}

	if (!attempted) {
		return { opened: false, message: "Session switching is unavailable in this extension context." };
	}
	return {
		opened: false,
		message: lastError ? `Failed to open child session automatically: ${lastError}` : "Failed to open child session automatically.",
	};
}

const ContextModeSchema = StringEnum(["fresh", "fork"] as const, {
	description: 'Runtime context mode shorthand. "fresh" starts a fresh worker context, "fork" creates a persisted child session forked from the parent snapshot.',
});

const TaskItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the role agent to invoke" })),
	profile: Type.Optional(Type.String({ description: "Capability profile to apply" })),
	modelTier: Type.Optional(Type.String({ description: "Named model-tier override for this task step" })),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(Type.String({ description: "Exact model override for this task step" })),
	skills: Type.Optional(Type.Array(Type.String(), { description: "Explicit skill names to load for this task step" })),
	prompt: Type.Optional(Type.String({ description: "Additional system prompt appended after the agent/profile prompts" })),
	context: Type.Optional(ContextModeSchema),
});

const ChainItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the role agent to invoke" })),
	profile: Type.Optional(Type.String({ description: "Capability profile to apply" })),
	modelTier: Type.Optional(Type.String({ description: "Named model-tier override for this task step" })),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(Type.String({ description: "Exact model override for this task step" })),
	skills: Type.Optional(Type.Array(Type.String(), { description: "Explicit skill names to load for this task step" })),
	prompt: Type.Optional(Type.String({ description: "Additional system prompt appended after the agent/profile prompts" })),
	context: Type.Optional(ContextModeSchema),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the role agent to invoke (for single mode)" })),
	profile: Type.Optional(Type.String({ description: "Capability profile to apply (for single mode)" })),
	modelTier: Type.Optional(Type.String({ description: "Named model-tier override for single mode" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	model: Type.Optional(Type.String({ description: "Exact model override for single mode" })),
	skills: Type.Optional(Type.Array(Type.String(), { description: "Explicit skill names to load for single mode" })),
	prompt: Type.Optional(Type.String({ description: "Additional system prompt appended after the profile/agent prompts for single mode" })),
	context: Type.Optional(ContextModeSchema),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of task steps for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of task steps for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local role agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
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
	pi.registerFlag("model-tier", {
		description: "Main-session model-tier preset to use",
		type: "string",
		default: "",
	});
	pi.registerFlag("profile-name", {
		description: "Profile name to use for permissions (overrides PI_PROFILE_NAME env var)",
		type: "string",
		default: "",
	});

	pi.on("session_start", async (_event, ctx) => {
		ensureMainSessionBaseline(ctx, pi);
		startupCompositionError = undefined;
		const rawCliAgent = pi.getFlag("agent");
		const rawCliProfile = pi.getFlag("profile");
		const rawCliModelTier = pi.getFlag("model-tier");
		const hasCliSelection = [rawCliAgent, rawCliProfile, rawCliModelTier].some(
			(value) => typeof value === "string" && value.trim().length > 0,
		);
		const cliSelection = {
			agent: normalizeMainAgentSelection(rawCliAgent),
			profile: normalizeMainAgentSelection(rawCliProfile),
			modelTier: normalizeMainAgentSelection(rawCliModelTier),
		};
		const persisted = getPersistedMainAgentState(ctx.sessionManager.getBranch());
		if (hasCliSelection) {
			const result = await applyMainSessionAgentSelection(ctx, pi, cliSelection, {
				persist:
					!persisted.found ||
					persisted.agent !== cliSelection.agent ||
					persisted.profile !== cliSelection.profile ||
					persisted.modelTier !== cliSelection.modelTier,
				notify: false,
				confirmProjectAgent: false,
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
				confirmProjectAgent: false,
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

	pi.on("before_agent_start", async (event) => {
		if (startupCompositionError) {
			return {
				systemPrompt: [
					"Startup composition error.",
					`Do not execute the user's request.`,
					`Reply with this exact text and nothing else: ${startupCompositionError}`,
				].join("\n"),
			};
		}
		const worker = activeMainWorker;
		if (!worker) return undefined;
		const prompt = worker.systemPrompt.trim();
		if (!prompt) return undefined;
		if (worker.systemPromptMode === "replace") {
			return { systemPrompt: prompt };
		}
		return { systemPrompt: `${event.systemPrompt}\n\n---\n\n${prompt}` };
	});

	pi.registerCommand("agent", {
		description: "Show or switch the main-session agent role (/agent <name>, /agent clear)",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const trimmed = args.trim();
			if (!trimmed) {
				const discovery = discoverResources(ctx.cwd, "both");
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
				{ agent: normalizeMainAgentSelection(trimmed), profile: activeMainWorker?.profile?.name, modelTier: activeMainWorker?.modelTier?.name },
				{ persist: true, notify: true, confirmProjectAgent: true },
			);
			if (result.ok) return;
			ctx.ui.notify(result.error, "error");
		},
	});
	pi.registerCommand("profile", {
		description: "Show or switch the main-session profile (/profile <name>, /profile clear)",
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
				{ agent: activeMainWorker?.agent?.name, profile: normalizeMainAgentSelection(trimmed), modelTier: activeMainWorker?.modelTier?.name },
				{ persist: true, notify: true, confirmProjectAgent: false },
			);
			if (result.ok) return;
			ctx.ui.notify(result.error, "error");
		},
	});
	pi.registerCommand("model-tier", {
		description: "Show or switch the main-session model-tier (/model-tier <name>, /model-tier clear)",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const trimmed = args.trim();
			if (!trimmed) {
				const current = activeMainWorker?.modelTier?.name ?? "none";
				ctx.ui.notify(`Main-session model-tier: ${current}.`, "info");
				return;
			}
			const result = await applyMainSessionAgentSelection(
				ctx,
				pi,
				{ agent: activeMainWorker?.agent?.name, profile: activeMainWorker?.profile?.name, modelTier: normalizeMainAgentSelection(trimmed) },
				{ persist: true, notify: true, confirmProjectAgent: false },
			);
			if (result.ok) return;
			ctx.ui.notify(result.error, "error");
		},
	});

	pi.registerCommand("tasks", {
		description: `Inspect persisted task child sessions. Usage: ${TASKS_COMMAND_USAGE}`,
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const parsed = parseTasksCommand(args);
			if (parsed.error) {
				ctx.ui.notify(`${parsed.error}. Usage: ${TASKS_COMMAND_USAGE}`, "error");
				return;
			}

			const runs =
				parsed.scope === "current"
					? reconstructCurrentTaskRuns(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionFile?.())
					: await reconstructRecentTaskRuns();

			if (runs.length === 0) {
				const emptyMessage = parsed.scope === "current" ? TASKS_NO_CURRENT_RUNS_MESSAGE : "No persisted task runs in recent sessions.";
				ctx.ui.notify(emptyMessage, "info");
				return;
			}

			if (parsed.action === "list") {
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
			if (parsed.action === "show") {
				const hasWarnings = run.warnings.length > 0 || run.steps.some((candidate) => candidate.warnings.length > 0);
				ctx.ui.notify(formatTaskRunDetails(parsed.scope, run, step), hasWarnings ? "warning" : "info");
				return;
			}

			const targetStep = selectTaskRunStepForOpen(run, step);
			if (!targetStep) {
				ctx.ui.notify(`Run ${run.runId} has no persisted child session to open.`, "error");
				return;
			}
			if (!targetStep.snapshot.persist) {
				ctx.ui.notify(
					`Run ${run.runId} step ${targetStep.step} is not persisted and cannot be opened.`,
					"error",
				);
				return;
			}

			const childSessionPath = targetStep.snapshot.childSessionPath;
			if (!childSessionPath.trim()) {
				ctx.ui.notify(
					`Run ${run.runId} step ${targetStep.step} has missing child session path metadata (stale metadata).`,
					"error",
				);
				return;
			}
			if (!fs.existsSync(childSessionPath)) {
				ctx.ui.notify(
					`Run ${run.runId} step ${targetStep.step} child session is missing: ${shortenHomePath(childSessionPath)}.`,
					"error",
				);
				return;
			}

			let openedMessage = `Opened run ${run.runId} step ${targetStep.step} (${targetStep.snapshot.childSessionId.slice(0, 8)}).`;
			if (!step && run.persistedStepCount > 1) {
				openedMessage += " Use a child session id prefix selector to open a different step.";
			}

			const openResult = await tryOpenTaskSession(ctx as unknown, childSessionPath, {
				targetSessionId: targetStep.snapshot.childSessionId,
				withSession: async (replacementCtx) => {
					await notifyTaskSessionOpened(replacementCtx, openedMessage);
				},
			});
			if (openResult.opened) return;

			ctx.ui.notify(`${openResult.message}\n${manualTaskSessionOpenInstruction(childSessionPath)}`, "warning");
		},
	});

	pi.registerTool({
		name: "task",
		label: "Task",
		description: [
			"Delegate work to specialized agents with configurable child-session context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Runtime context override supports only mode shorthand (`context: "fresh" | "fork"`).',
			"Session persistence is config-driven (`persist`) and cannot be overridden at runtime.",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		promptSnippet: "Delegate substantial or parallelizable work to specialized agents.",
		promptGuidelines: [
			"Use `task` when work can be delegated to a focused agent, especially for multi-file changes, independent investigations, or parallelizable subtasks.",
			"Use single mode for one focused delegation, `tasks` for independent work that can run in parallel, and `chain` when later steps depend on earlier output via `{previous}`.",
			"Choose the most specific agent that fits the job, and set `agentScope` to `both` or `project` only when you need project-local agents.",
			"Skip `task` for trivial edits or when direct tool use is simpler than delegation.",
		],
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverResources(ctx.cwd, agentScope);
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const callableAgents = getTaskCallableAgents(discovery);

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.task && (params.agent || params.profile || params.prompt || params.skills?.length));
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			let sessionRunId: string | undefined;
			let sessionRunRoot: string | undefined;
			let childMetadataRunId: string | undefined;
			const makeDetails =
				(mode: TaskExecutionMode) =>
				(results: SingleResult[]): TaskDetails => {
					const childSessions = results.flatMap((stepResult) => (stepResult.childSession ? [stepResult.childSession] : []));
					return {
						mode,
						agentScope,
						projectAgentsDir: discovery.projectAgentsDir,
						results,
						sessionRunId,
						sessionRunRoot,
						toolCallId,
						childSessions: childSessions.length > 0 ? childSessions : undefined,
					};
				};

			// Recursion depth guard
			const depthCheck = checkSubagentDepth();
			if (depthCheck.blocked) {
				const mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
				return {
					content: [{ type: "text", text: `Task depth limit reached (depth ${depthCheck.depth}, max ${depthCheck.maxDepth}). Nested task delegation is blocked to prevent runaway recursion.` }],
					details: makeDetails(mode)([]),
					isError: true,
				};
			}

			if (modeCount !== 1) {
				const available = callableAgents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable task agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			const mode: TaskExecutionMode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
			const stepsToRun: TaskStepConfig[] = [];
			if (params.chain) stepsToRun.push(...params.chain);
			if (params.tasks) stepsToRun.push(...params.tasks);
			if (params.task && (params.agent || params.profile || params.prompt || params.skills?.length)) {
				stepsToRun.push({
					agent: params.agent,
					profile: params.profile,
					modelTier: params.modelTier,
					task: params.task,
					cwd: params.cwd,
					model: params.model,
					skills: params.skills,
					prompt: params.prompt,
					context: params.context,
				});
			}

			if (hasRuntimePersistOverride(params as unknown)) {
				return {
					content: [{ type: "text", text: "Invalid parameters. Runtime persist overrides are not supported." }],
					details: makeDetails(mode)([]),
					isError: true,
				};
			}

			if (mode !== "chain") {
				const invalidStep = stepsToRun.findIndex((step) => hasPreviousPlaceholder(step.task));
				if (invalidStep !== -1) {
					return {
						content: [{ type: "text", text: `Invalid task at step ${invalidStep + 1}: {previous} is only supported in chain mode.` }],
						details: makeDetails(mode)([]),
						isError: true,
					};
				}
			}

			if (mode === "parallel" && stepsToRun.length > MAX_PARALLEL_TASKS)
				return {
					content: [
						{
							type: "text",
							text: `Too many parallel tasks (${stepsToRun.length}). Max is ${MAX_PARALLEL_TASKS}.`,
						},
					],
					details: makeDetails("parallel")([]),
					isError: true,
				};

			let preparedSteps: PreparedTaskStep[] = [];

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) if (step.agent) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) if (t.agent) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => discovery.agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project" && isTaskCallableAgent(a));

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(mode)([]),
						};
				}
			}

			const preflight = await preflightTaskRun(mode, stepsToRun, discovery, ctx.cwd, ctx.sessionManager);
			if (preflight.error || !preflight.prepared) {
				return {
					content: [{ type: "text", text: preflight.error ?? "Failed to prepare task run." }],
					details: makeDetails(mode)([]),
					isError: true,
				};
			}
			sessionRunId = preflight.prepared.sessionRunId;
			sessionRunRoot = preflight.prepared.sessionRunRoot;
			preparedSteps = preflight.prepared.steps;
			childMetadataRunId = sessionRunId ?? `${toolCallId}-run`;

			if (mode === "chain") {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < preparedSteps.length; i++) {
					const preparedStep = preparedSteps[i];
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
					});
					results.push(result);

					const isError =
						result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg =
							result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
						return {
							content: [
								{
									type: "text",
									text: `Chain stopped at step ${preparedStep.step} (${preparedStep.rawStep.agent ?? preparedStep.rawStep.profile ?? "generic"}): ${errorMsg}`,
								},
							],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = truncateOutput(getFinalOutput(result.messages));
				}
				return {
					content: [{ type: "text", text: truncateOutput(getFinalOutput(results[results.length - 1].messages)) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (mode === "parallel") {
				const allResults: SingleResult[] = new Array(preparedSteps.length);
				for (let i = 0; i < preparedSteps.length; i++) {
					const preparedStep = preparedSteps[i];
					allResults[i] = {
						agent: preparedStep.worker.displayAgentName,
						agentSource: preparedStep.worker.agent?.source ?? "unknown",
						profile: preparedStep.worker.profile?.name,
						modelTier: preparedStep.worker.modelTier?.name,
						task: preparedStep.rawStep.task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						model: preparedStep.worker.model,
						step: preparedStep.step,
						sessionMode: preparedStep.session.mode,
						sessionPersist: preparedStep.session.persist,
						sessionFile: preparedStep.session.sessionFile,
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit<PreparedTaskStep, SingleResult>(
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
						});
						allResults[index] = result;
						emitParallelUpdate();
						return result;
					},
				);

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const output = truncateOutput(getFinalOutput(r.messages));
					const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
					return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (mode === "single") {
				const preparedStep = preparedSteps[0]!;
				const result = await runTaskStepWithMetadata({
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
				});
				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg =
						result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: truncateOutput(getFinalOutput(result.messages)) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = callableAgents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available task agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			if (args.chain && args.chain.length > 0) {
				const tasks = args.chain.map((step) => step.task.replace(/\{previous\}/g, "").trim());
				const text =
					formatTaskCallHeading("chain", theme, args.chain.length) +
					formatTaskSnippetLines(tasks, theme.fg.bind(theme), { numbered: true });
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				const text =
					formatTaskCallHeading("parallel", theme, args.tasks.length) +
					formatTaskSnippetLines(
						args.tasks.map((task) => task.task),
						theme.fg.bind(theme),
					);
				return new Text(text, 0, 0);
			}
			const task = args.task ?? "...";
			const text =
				formatTaskCallHeading("simple", theme) +
				formatTaskSnippetLines([task], theme.fg.bind(theme), { maxItems: 1, maxLength: 80 });
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TaskDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = formatTaskHeader(
						{ leadingIcon: icon, agent: r.agent, agentColor: "toolTitle", boldAgent: true, taskResult: r },
						theme,
					);
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					if (r.childSession) {
						container.addChild(new Text(formatChildSessionExpanded(r.childSession, theme.fg.bind(theme)), 0, 0));
					}
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					appendTaskOutputSection(container, displayItems, finalOutput, mdTheme, theme.fg.bind(theme));
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = formatTaskHeader(
					{ leadingIcon: icon, agent: r.agent, agentColor: "toolTitle", boldAgent: true, taskResult: r },
					theme,
				);
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (r.childSession) text += `\n${formatChildSessionCompact(r.childSession, theme.fg.bind(theme))}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
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
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

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
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

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
						container.addChild(new Text(stepHeader, 0, 0));
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						if (r.childSession) {
							container.addChild(new Text(formatChildSessionExpanded(r.childSession, theme.fg.bind(theme)), 0, 0));
						}
						appendTaskOutputSection(container, displayItems, finalOutput, mdTheme, theme.fg.bind(theme));
						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
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
						{ prefix: theme.fg("muted", `─── Step ${r.step}: `), agent: r.agent, taskResult: r, suffix: ` ${rIcon}` },
						theme,
					)}`;
					if (r.childSession) text += `\n${formatChildSessionCompact(r.childSession, theme.fg.bind(theme))}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
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

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						const taskHeader = formatTaskHeader(
							{ prefix: theme.fg("muted", "─── "), agent: r.agent, taskResult: r, suffix: ` ${rIcon}` },
							theme,
						);
						container.addChild(new Text(taskHeader, 0, 0));
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						if (r.childSession) {
							container.addChild(new Text(formatChildSessionExpanded(r.childSession, theme.fg.bind(theme)), 0, 0));
						}
						appendTaskOutputSection(container, displayItems, finalOutput, mdTheme, theme.fg.bind(theme));
						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
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
						{ prefix: theme.fg("muted", "─── "), agent: r.agent, taskResult: r, suffix: ` ${rIcon}` },
						theme,
					)}`;
					if (r.childSession) text += `\n${formatChildSessionCompact(r.childSession, theme.fg.bind(theme))}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
