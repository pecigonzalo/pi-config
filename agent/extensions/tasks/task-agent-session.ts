import { resolveCliModel, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	appendProjectTrustFlags,
	appendWorkerPromptFlags,
	appendWorkerSkillFlags,
	appendWorkerToolFlags,
	getWorkerProcessEnv,
	spawnRpcWorker,
	type RpcWorkerEvent,
	type RpcWorkerHandle,
} from "./task-rpc-worker.js";

export type { WorkerControlSignal } from "./task-rpc-worker.js";
import type { WorkerControlSignal } from "./task-rpc-worker.js";

/**
 * Runs a delegated task step as a separate `pi --mode rpc` process (see task-rpc-worker.ts)
 * rather than an in-process AgentSession -- so a human inspecting a live worker via
 * `/tasks open` never disposes the delegating parent's own session (pi's session-replacement
 * machinery always tears down whatever session is "current" in a terminal before replacing
 * it, and a human inspects a worker from the same terminal as the delegating parent).
 */

export const TASK_COMPLETE_TOOL_NAME = "task_complete";
export const ASK_CALLER_TOOL_NAME = "ask_caller";

export function resolveWorkerModel(modelSpec: string | undefined, modelRegistry: ModelRegistry): { error?: string } {
	if (!modelSpec) return {};
	const result = resolveCliModel({ cliModel: modelSpec, modelRegistry });
	if (result.error) return { error: result.error };
	if (!result.model) return { error: `Unknown model: "${modelSpec}".` };
	return {};
}

export interface WorkerSessionSpec {
	cwd: string;
	modelRegistry: ModelRegistry;
	/** Fully composed system prompt text (worker/profile/step prompt + any required-skill blocks). */
	systemPrompt: string;
	systemPromptMode: "append" | "replace";
	model?: string;
	thinkingLevel?: string;
	tools?: string[];
	excludeTools?: string[];
	allowDelegation: boolean;
	projectTrusted: boolean;
	/** Disables loading AGENTS.md/project context files, independent of project trust. */
	noContextFiles: boolean;
	/** Explicit skill paths to load. Undefined means "use default skill discovery" (subject to noSkills). */
	additionalSkillPaths?: string[];
	/** Disables default skill discovery. additionalSkillPaths, if given, still loads explicitly. */
	noSkills: boolean;
	/** Persisted session file to resume (already created and seeded by the caller), or undefined for ephemeral. */
	sessionFile?: string;
	/** Read by the permissions extension's own pi.getFlag("agent-name") to pick a permission profile. */
	agentName?: string;
	/** Read by the permissions extension's own pi.getFlag("profile-name"). */
	profileName?: string;
	/** Detects the worker's task_complete/ask_caller tool calls from the child's own event
	 * stream (tool_execution_start), since the child has no access to the parent's controller
	 * registry to signal completion directly. */
	controlSignal: WorkerControlSignal;
	/** Relays the child's extension_ui_request events (dialogs/status/widget) to the parent's
	 * real UI. Omit when the parent has no real UI -- the child's own extension host then
	 * auto-resolves dialogs to their default after a timeout, with nothing to relay. */
	onUiRequest?: (event: RpcWorkerEvent, respond: (response: Record<string, unknown>) => void) => void;
}

export interface WorkerSessionResult {
	session?: RpcWorkerHandle;
	error?: string;
}

/**
 * Spawns the `pi --mode rpc` child process a delegated worker runs in, translating a
 * WorkerSessionSpec into the equivalent CLI flags (--model, --tools/--no-tools,
 * --exclude-tools, --system-prompt/--append-system-prompt, --no-context-files, --no-skills/
 * --skill, --approve/--no-approve, --session/--no-session).
 */
export async function createWorkerAgentSession(spec: WorkerSessionSpec): Promise<WorkerSessionResult> {
	const { error: modelError } = resolveWorkerModel(spec.model, spec.modelRegistry);
	if (modelError) return { error: modelError };

	const args: string[] = ["--mode", "rpc"];
	if (spec.sessionFile) args.push("--session", spec.sessionFile);
	else args.push("--no-session");
	if (spec.model) args.push("--model", spec.model);
	if (spec.thinkingLevel) args.push("--thinking", spec.thinkingLevel);

	// task_complete/ask_caller must always be reachable, even when the worker's own tools are
	// an explicit (possibly empty) allowlist -- tool filtering applies uniformly to builtin and
	// extension tools alike, so an allowlist that doesn't mention them would otherwise strand an
	// interactive worker with no way to finish.
	const toolsWithControl =
		spec.tools !== undefined
			? [...new Set([...spec.tools, TASK_COMPLETE_TOOL_NAME, ASK_CALLER_TOOL_NAME])]
			: undefined;
	appendWorkerToolFlags(args, {
		tools: toolsWithControl,
		excludeTools: spec.excludeTools,
		allowDelegation: spec.allowDelegation,
	});
	appendProjectTrustFlags(args, spec.projectTrusted);
	if (spec.noContextFiles) args.push("--no-context-files");
	appendWorkerSkillFlags(args, { noSkills: spec.noSkills, additionalSkillPaths: spec.additionalSkillPaths });

	const promptFile = await appendWorkerPromptFlags(
		args,
		spec.sessionFile ?? "ephemeral",
		spec.systemPrompt,
		spec.systemPromptMode,
	);

	const result = await spawnRpcWorker({
		cwd: spec.cwd,
		args,
		env: getWorkerProcessEnv({ agentName: spec.agentName, profileName: spec.profileName }),
		sessionFile: spec.sessionFile,
		tmpPromptDir: promptFile.dir,
		tmpPromptPath: promptFile.filePath,
		signal: spec.controlSignal,
		onUiRequest: spec.onUiRequest,
	});
	if (result.error || !result.handle) return { error: result.error ?? "Failed to start worker process." };
	return { session: result.handle };
}
