import {
	createAgentSession,
	DefaultResourceLoader,
	resolveCliModel,
	SessionManager,
	type AgentSession,
	type CreateAgentSessionOptions,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";

/**
 * Runs a delegated task step as a real, in-process AgentSession -- the same session type,
 * the same prompt()/steer()/subscribe() primitives, that a normal interactive pi session
 * uses. No subprocess, no pty, no RPC-over-pipes protocol: task.ts calls the functions here
 * directly, in-process, and gets back either a resolved model/session pair or a plain error
 * string (never throws) so callers can fold failures into a SingleResult uniformly.
 */

export function resolveWorkerModel(
	modelSpec: string | undefined,
	modelRegistry: ModelRegistry,
): { model?: CreateAgentSessionOptions["model"]; error?: string } {
	if (!modelSpec) return {};
	const result = resolveCliModel({ cliModel: modelSpec, modelRegistry });
	if (result.error) return { error: result.error };
	if (!result.model) return { error: `Unknown model: "${modelSpec}".` };
	return { model: result.model };
}

export interface WorkerSessionSpec {
	cwd: string;
	agentDir: string;
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
}

export interface WorkerSessionResult {
	session?: AgentSession;
	error?: string;
}

/**
 * Builds the AgentSession a delegated worker runs in. Mirrors what the old subprocess model
 * did with CLI flags (--model, --tools/--no-tools, --exclude-tools, --system-prompt/
 * --append-system-prompt, --no-context-files, --no-skills, --session/--no-session), just as
 * direct JS options instead of a spawned process's argv.
 */
export async function createWorkerAgentSession(spec: WorkerSessionSpec): Promise<WorkerSessionResult> {
	const { model, error: modelError } = resolveWorkerModel(spec.model, spec.modelRegistry);
	if (modelError) return { error: modelError };

	const excludeTools = new Set(spec.excludeTools);
	if (!spec.allowDelegation) excludeTools.add("task");

	const resourceLoader = new DefaultResourceLoader({
		cwd: spec.cwd,
		agentDir: spec.agentDir,
		systemPrompt: spec.systemPromptMode === "replace" ? spec.systemPrompt : undefined,
		appendSystemPrompt: spec.systemPromptMode === "append" && spec.systemPrompt ? [spec.systemPrompt] : undefined,
		noContextFiles: spec.noContextFiles,
		noSkills: spec.noSkills,
		additionalSkillPaths: spec.additionalSkillPaths,
	});
	try {
		await resourceLoader.reload({ resolveProjectTrust: async () => spec.projectTrusted });
	} catch (error) {
		return { error: `Failed to load worker resources: ${error instanceof Error ? error.message : String(error)}` };
	}

	// Session-scoped equivalent of the old --agent-name/--profile-name CLI flags (read by the
	// permissions extension via pi.getFlag(...)). Each worker's own DefaultResourceLoader owns
	// an independent ExtensionRuntime with its own flagValues Map (loader.js's
	// createExtensionRuntime() always builds a fresh one), so this is race-free across
	// concurrently-running workers -- unlike a process.env var, which every worker would share.
	const { runtime } = resourceLoader.getExtensions();
	if (spec.agentName !== undefined) runtime.flagValues.set("agent-name", spec.agentName);
	if (spec.profileName !== undefined) runtime.flagValues.set("profile-name", spec.profileName);

	const sessionManager = spec.sessionFile ? SessionManager.open(spec.sessionFile) : SessionManager.inMemory(spec.cwd);

	const options: CreateAgentSessionOptions = {
		cwd: spec.cwd,
		agentDir: spec.agentDir,
		modelRegistry: spec.modelRegistry,
		model,
		thinkingLevel: spec.thinkingLevel as CreateAgentSessionOptions["thinkingLevel"],
		tools: spec.tools && spec.tools.length > 0 ? spec.tools : undefined,
		noTools: spec.tools !== undefined && spec.tools.length === 0 ? "all" : undefined,
		excludeTools: excludeTools.size > 0 ? [...excludeTools] : undefined,
		resourceLoader,
		sessionManager,
	};

	try {
		const { session } = await createAgentSession(options);
		return { session };
	} catch (error) {
		return { error: `Failed to create worker session: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * Depth tracking for the recursion guard, keyed by session id (not the AgentSession object
 * itself) because task.ts's tool-execute context only ever exposes a session id, not the raw
 * session -- see task.ts's "Recursion depth guard" comment for why this replaced the old
 * PI_SUBAGENT_DEPTH env var: in-process workers share process.env with the parent, so a global
 * env var can't distinguish one session's depth from another's the way a per-process env var
 * could when each worker was a separate OS process.
 */
const subagentDepthBySessionId = new Map<string, number>();

export function getSubagentDepth(sessionId: string | undefined): number {
	if (!sessionId) return 0;
	return subagentDepthBySessionId.get(sessionId) ?? 0;
}

export function setSubagentDepth(sessionId: string, depth: number): void {
	subagentDepthBySessionId.set(sessionId, depth);
}
