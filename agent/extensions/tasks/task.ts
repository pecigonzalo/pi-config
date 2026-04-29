/**
 * Task Tool - Delegate work to specialized agents
 *
 * Spawns a separate `pi` process for each delegated task,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from delegated agents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
	type ModelTierConfig,
	type ProfileConfig,
	type ResourceDiscoveryResult,
	discoverResources,
	resolveSkillPaths,
} from "./agents.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

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

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
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
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
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
}

interface TaskDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
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
	const inheritProjectContext = agent?.inheritProjectContext ?? profile?.inheritProjectContext ?? false;
	const inheritSkills = agent?.inheritSkills ?? profile?.inheritSkills ?? false;
	const tools = agent?.tools ?? profile?.tools;
	const systemPromptMode = agent?.systemPromptMode ?? profile?.systemPromptMode ?? "append";
	const displayAgentName = agent?.name ?? "generic";

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

function validateTaskStep(step: TaskStepConfig, resources: ResourceDiscoveryResult): string | undefined {
	return resolveWorkerConfig(step, resources).error;
}

async function runSingleAgent(
	defaultCwd: string,
	resources: ResourceDiscoveryResult,
	stepConfig: TaskStepConfig,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => TaskDetails,
): Promise<SingleResult> {
	const { task, cwd } = stepConfig;
	const resolved = resolveWorkerConfig(stepConfig, resources);
	if (resolved.error || !resolved.config) {
		return {
			agent: stepConfig.agent ?? "generic",
			agentSource: "unknown",
			profile: stepConfig.profile,
			modelTier: stepConfig.modelTier,
			task,
			exitCode: 1,
			messages: [],
			stderr: resolved.error ?? "Failed to resolve task worker configuration.",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const worker = resolved.config;
	const agent = worker.agent;
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const agentModel = worker.model;
	if (agentModel) args.push("--model", agentModel);
	if (worker.modelTier?.thinkingLevel) args.push("--thinking", worker.modelTier.thinkingLevel);
	if (worker.tools !== undefined) {
		if (worker.tools.length > 0) args.push("--tools", worker.tools.join(","));
		else args.push("--no-tools");
	}
	if (!worker.inheritProjectContext) args.push("--no-context-files");

	if (worker.skills && worker.skills.length > 0) {
		const { paths, missing } = resolveSkillPaths(worker.skills, cwd ?? defaultCwd);
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
				cwd: cwd ?? defaultCwd,
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
		if (wasAborted) throw new Error("Task was aborted");
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

const TaskItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the role agent to invoke" })),
	profile: Type.Optional(Type.String({ description: "Capability profile to apply" })),
	modelTier: Type.Optional(Type.String({ description: "Named model-tier override for this task step" })),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(Type.String({ description: "Exact model override for this task step" })),
	skills: Type.Optional(Type.Array(Type.String(), { description: "Explicit skill names to load for this task step" })),
	prompt: Type.Optional(Type.String({ description: "Additional system prompt appended after the agent/profile prompts" })),
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

	pi.registerTool({
		name: "task",
		label: "Task",
		description: [
			"Delegate work to specialized agents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
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

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverResources(ctx.cwd, agentScope);
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const callableAgents = getTaskCallableAgents(discovery);

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.task && (params.agent || params.profile || params.prompt || params.skills?.length));
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): TaskDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

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

			const stepsToValidate: TaskStepConfig[] = [];
			if (params.chain) stepsToValidate.push(...params.chain);
			if (params.tasks) stepsToValidate.push(...params.tasks);
			if (params.task && (params.agent || params.profile || params.prompt || params.skills?.length)) {
				stepsToValidate.push({
					agent: params.agent,
					profile: params.profile,
					modelTier: params.modelTier,
					task: params.task,
					cwd: params.cwd,
					model: params.model,
					skills: params.skills,
					prompt: params.prompt,
				});
			}
			for (const step of stepsToValidate) {
				const validationError = validateTaskStep(step, discovery);
				if (validationError) {
					const mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
					return {
						content: [{ type: "text", text: validationError }],
						details: makeDetails(mode)([]),
						isError: true,
					};
				}
			}

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
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
					const resolvedStep: TaskStepConfig = { ...step, task: taskWithContext };

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
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

					const result = await runSingleAgent(
						ctx.cwd,
						discovery,
						resolvedStep,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError =
						result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg =
							result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent ?? step.profile ?? "generic"}): ${errorMsg}` }],
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

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
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

				const results = await mapWithConcurrencyLimit<TaskStepConfig, SingleResult>(
					params.tasks as TaskStepConfig[],
					MAX_CONCURRENCY,
					async (t, index) => {
						const result = await runSingleAgent(
							ctx.cwd,
							discovery,
							t,
							undefined,
							signal,
							// Per-task update callback
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									emitParallelUpdate();
								}
							},
							makeDetails("parallel"),
						);
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

			if (params.task && (params.agent || params.profile || params.prompt || params.skills?.length)) {
				const result = await runSingleAgent(
					ctx.cwd,
					discovery,
					{
						agent: params.agent,
						profile: params.profile,
						modelTier: params.modelTier,
						task: params.task,
						cwd: params.cwd,
						model: params.model,
						skills: params.skills,
						prompt: params.prompt,
					},
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
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
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("task ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					const label = step.agent ?? step.profile ?? "generic";
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", label) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("task ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					const label = t.agent ?? t.profile ?? "generic";
					text += `\n  ${theme.fg("accent", label)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent ?? args.profile ?? "generic";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("task ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
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
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
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
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

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
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
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
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

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
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
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
