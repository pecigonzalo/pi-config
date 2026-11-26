export type PermissionMode = "plan" | "workspace-write" | "full-access" | "auto";
export type ExternalPathPolicy = "allow" | "ask" | "block";

/**
 * "auto" shares "workspace-write"'s rule boundaries, sandbox posture, and restriction tier — it
 * only changes whether a human or the classifier resolves an "ask" outcome. Anything that keys
 * behavior off `PermissionMode` for one of those purposes (restriction ranking, sandbox defaults,
 * sandbox-unavailable fallback, ...) should resolve through this first instead of adding another
 * `auto: <copy of workspace-write>` entry to its own lookup table.
 */
export function baseRestrictionMode(mode: PermissionMode): Exclude<PermissionMode, "auto"> {
	return mode === "auto" ? "workspace-write" : mode;
}

export const FILESYSTEM_TOOL_NAMES = ["read", "write", "edit", "grep", "find", "ls", "code_intel"] as const;
export type FilesystemToolName = (typeof FILESYSTEM_TOOL_NAMES)[number];
export type KnownToolName = "bash" | "mcp" | FilesystemToolName;
export type RuleToolName = KnownToolName | "*" | (string & {});
export type PermissionToolName = Exclude<RuleToolName, "*">;

export type PermissionToolInput = {
	path?: unknown;
	root?: unknown;
	command?: unknown;
};

export interface Rule {
	tool: RuleToolName;
	match?: string | string[];
	action: "allow" | "block" | "ask";
	reason?: string;
	externalPathAction?: "inherit" | "allow" | "ask" | "block";
	/** For bash rules, false runs the command outside the OS sandbox after permission checks pass. */
	sandbox?: boolean;
	/**
	 * In "auto" mode, whether an "ask" resolution from this rule may be auto-reviewed by the
	 * permissions classifier instead of always prompting the human. Defaults to true. Set to
	 * false to force a human prompt for this rule regardless of classifier confidence.
	 */
	autoReview?: boolean;
	/**
	 * Marks a rule compiled from `protectedResources`. Read-tagged rules are skipped when the
	 * target matches a workspace read exception; user rules are never affected.
	 */
	protectedAccess?: "read" | "write";
}

export interface AgentProfile {
	inherit?: boolean;
	mode?: PermissionMode;
	rules?: Rule[];
	externalPath?: ExternalPathPolicy;
}

/**
 * How `<cwd>/.pi/permissions.jsonc` is handled. Set in the global config only.
 *
 * - `"never"` (default): the project file is ignored, so a repository cannot change the
 *   policy that governs it by shipping a file.
 * - `"trusted"`: the project file applies only when Pi reports the project as trusted.
 *   Pi treats a project with no other trust-requiring resources as trusted, so a repository
 *   whose only Pi resource is `.pi/permissions.jsonc` still counts as trusted.
 * - `"always"`: the project file always applies.
 */
export type ProjectConfigPolicy = "never" | "trusted" | "always";

export interface PermissionsConfig {
	/** Project-local config handling. Global config only; defaults to `"never"`. */
	projectConfig?: ProjectConfigPolicy;
	default?: {
		mode?: PermissionMode;
		rules?: Rule[];
		externalPath?: ExternalPathPolicy;
	};
	profiles?: Record<string, AgentProfile>;
	agents?: Record<string, AgentProfile>;
	sandbox?: SandboxSettings;
	approvals?: ApprovalsSettings;
	protectedResources?: ProtectedResourcesSettings;
	annotations?: AnnotationPolicySettings;
	classifier?: ClassifierSettings;
}

/**
 * Settings for the "auto" mode permission classifier. A rule resolving to "ask" is only ever
 * routed through the classifier when the active policy's mode is "auto" — this section has no
 * effect under "plan" | "workspace-write" | "full-access". The classifier can only skip a human
 * prompt (decision: "allow"); any error, timeout, low confidence, or unparseable response always
 * falls back to asking the human.
 */
export interface ClassifierSettings {
	/** Kill switch within auto mode. Defaults to true. */
	enabled?: boolean;
	/** Model provider id, e.g. "anthropic". Defaults to "anthropic". */
	provider?: string;
	/** Model id to classify with. Defaults to a small/cheap model, not the main session model. */
	model?: string;
	/** Minimum confidence (0-1) required to auto-allow. Below this, always escalate. */
	confidenceThreshold?: number;
	/** How many recent session entries to include as context for the classifier. */
	historyTurns?: number;
	/** Hard timeout for the classifier call; a timeout always escalates. */
	timeoutMs?: number;
	/** Max output tokens for the classifier's verdict response. */
	maxTokens?: number;
}

export interface ResolvedClassifierSettings {
	enabled: boolean;
	provider: string;
	model: string;
	confidenceThreshold: number;
	historyTurns: number;
	timeoutMs: number;
	maxTokens: number;
}

export interface EffectivePolicy {
	mode: PermissionMode;
	rules: Rule[];
	externalPath: ExternalPathPolicy;
	protectedResources: ResolvedProtectedResources;
}

export type CodemodeMode = "analysis" | "orchestrator";
export type CodemodeCapability = "message" | "artifact" | "task" | "todo" | "mcp" | "codeintel";

export interface CodemodeEffectivePolicy {
	codeMode: CodemodeMode;
	mode: PermissionMode;
	capabilities: CodemodeCapability[];
	allowProjectAgents: boolean;
	sandbox: {
		enabled: boolean;
		config: SandboxRuntimeConfigLike;
		reason: string;
	};
}

export interface ProtectedResourcesSettings {
	enabled?: boolean;
	defaults?: boolean;
	addDenyRead?: string[];
	addDenyWrite?: string[];
	unprotectRead?: string[];
	unprotectWrite?: string[];
	/**
	 * What a protected read resolves to. `"ask"` (default) prompts the user, who can approve it
	 * for the request, session, or permanently. `"block"` is a hard denial with no approval path.
	 * Protected writes are controlled separately by `envWriteAction` and otherwise always block.
	 */
	readAction?: ProtectedAction;
	/**
	 * How writes to env files resolve. `"ask"` (default) prompts, so worktree setup and `cp
	 * .env.example .env` can proceed after approval; the OS sandbox no longer denies these
	 * writes. `"block"` restores a hard denial in both layers. Other protected writes always
	 * block.
	 */
	envWriteAction?: ProtectedAction;
	/**
	 * Glob patterns relative to cwd that are exempt from read protection when the resolved path
	 * stays inside the workspace. Writes stay protected, and reads of the same file name outside
	 * cwd stay protected. Intended for env files that the project's own tooling reads.
	 */
	workspaceRead?: string[];
}

/** Settings for the annotation-based default applied to tools no rule classifies. */
export interface AnnotationPolicySettings {
	/** Ask before unclassified tools whose annotations indicate risk. Defaults to true. */
	enabled?: boolean;
	/** Ask when an unclassified tool declares no annotations at all. Defaults to true. */
	askWhenUnannotated?: boolean;
}

export interface ResolvedAnnotationPolicySettings {
	enabled: boolean;
	askWhenUnannotated: boolean;
}

export type ProtectedAction = "ask" | "block";

/** Reason text used by protected-resource rules; bash hits append the resolved path. */
export const PROTECTED_RESOURCE_BLOCK_REASON = "Blocked by protected resource policy";
const PROTECTED_RESOURCE_ASK_REASON = "Protected resource requires confirmation";

export function protectedResourceReason(action: ProtectedAction): string {
	return action === "block" ? PROTECTED_RESOURCE_BLOCK_REASON : PROTECTED_RESOURCE_ASK_REASON;
}

export interface ResolvedProtectedResources {
	denyRead: string[];
	denyWrite: string[];
	/** Workspace-relative globs exempt from read protection. Includes built-in templates. */
	workspaceRead: string[];
	/** How protected reads resolve. Defaults to `"ask"`. */
	readAction: ProtectedAction;
	/** How env-file writes resolve. Defaults to `"ask"`; other protected writes always block. */
	envWriteAction: ProtectedAction;
}

export interface ApprovalsSettings {
	scopeByProject?: boolean;
	scopeByAgent?: boolean;
	maxAgeDays?: number;
}

export interface ResolvedApprovalsSettings {
	scopeByProject: boolean;
	scopeByAgent: boolean;
	maxAgeDays?: number;
}

export interface ApprovalRecord {
	tool: RuleToolName;
	scopeType: "path-prefix" | "tool" | "bash-exact" | "bash-prefix";
	scopeValue: string;
	projectRoot?: string;
	agentName?: string;
	createdAt: number;
}

export interface ApprovalFile {
	approvals: ApprovalRecord[];
}

export interface SandboxSettings {
	enabled?: boolean;
	network?: boolean;
	enableWeakerNetworkIsolation?: boolean;
	allowedDomains?: string[];
	deniedDomains?: string[];
	tmpDir?: string;
	tmpDirMode?: "shared" | "session";
	compatWritePaths?: boolean;
	allowSshAuthSock?: boolean;
	allowUnixSockets?: string[];
	allowAllUnixSockets?: boolean;
	allowLocalBinding?: boolean;
	allowMachLookup?: string[];
	allowPty?: boolean;
	bypassCommands?: string[];
	addAllowWrite?: string[];
	allowRead?: string[];
	denyRead?: string[];
	denyWrite?: string[];
	env?: Record<string, string>;
}

export interface SandboxRuntimeConfigLike {
	enableWeakerNetworkIsolation?: boolean;
	allowPty?: boolean;
	network?: {
		allowedDomains?: string[];
		deniedDomains?: string[];
		allowUnixSockets?: string[];
		allowAllUnixSockets?: boolean;
		allowLocalBinding?: boolean;
		allowMachLookup?: string[];
	};
	filesystem?: {
		denyRead?: string[];
		allowRead?: string[];
		allowWrite?: string[];
		denyWrite?: string[];
	};
}

export interface SandboxManagerLike {
	initialize(config: SandboxRuntimeConfigLike): Promise<void>;
	wrapWithSandbox(
		command: string,
		binShell?: string,
		customConfig?: Partial<SandboxRuntimeConfigLike>,
		abortSignal?: AbortSignal,
	): Promise<string>;
	reset(): Promise<void>;
}

export const FILESYSTEM_TOOLS = new Set<FilesystemToolName>(FILESYSTEM_TOOL_NAMES);

export function isFilesystemToolName(toolName: PermissionToolName): toolName is FilesystemToolName {
	return FILESYSTEM_TOOLS.has(toolName as FilesystemToolName);
}

/** MCP tools are registered as `mcp__<server>__<tool>`; a bare `mcp` name is also accepted. */
export function isMcpToolName(toolName: string): boolean {
	return toolName === "mcp" || toolName.startsWith("mcp__");
}

export function dedupeStrings(items: string[]): string[] {
	return [...new Set(items)];
}

/**
 * Footer text for the permissions status. Only deviations from a healthy session are appended, so a
 * normal session renders just the mode instead of `mode · sandbox · tree-sitter` noise.
 */
export function formatPermissionStatus(input: { mode: string; sandboxProblem?: string; parserReady: boolean }): string {
	const parts = [input.mode];
	if (input.sandboxProblem) parts.push(input.sandboxProblem);
	if (!input.parserReady) parts.push("no-parser");
	return parts.join(" · ");
}
