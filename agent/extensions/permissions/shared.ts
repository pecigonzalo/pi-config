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

export const FILESYSTEM_TOOL_NAMES = ["read", "write", "edit", "grep", "find", "ls"] as const;
export type FilesystemToolName = (typeof FILESYSTEM_TOOL_NAMES)[number];
export type KnownToolName = "bash" | "mcp" | FilesystemToolName;
export type RuleToolName = KnownToolName | "*" | (string & {});
export type PermissionToolName = Exclude<RuleToolName, "*">;

export type PermissionToolInput = {
	path?: unknown;
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
}

export interface AgentProfile {
	inherit?: boolean;
	mode?: PermissionMode;
	rules?: Rule[];
	externalPath?: ExternalPathPolicy;
}

export interface PermissionsConfig {
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
export type CodemodeCapability = "message" | "artifact" | "task" | "todo" | "mcp";

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
}

export interface ResolvedProtectedResources {
	denyRead: string[];
	denyWrite: string[];
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

export function dedupeStrings(items: string[]): string[] {
	return [...new Set(items)];
}
