export type PermissionMode = "plan" | "workspace-write" | "full-access";
export type ExternalPathPolicy = "allow" | "ask" | "block";

export const FILESYSTEM_TOOL_NAMES = ["read", "write", "edit", "grep", "find", "ls"] as const;
export type FilesystemToolName = (typeof FILESYSTEM_TOOL_NAMES)[number];
export type KnownToolName = "bash" | FilesystemToolName;
export type RuleToolName = KnownToolName | "*" | (string & {});
export type PermissionToolName = Exclude<RuleToolName, "*">;

export type PermissionToolInput = {
	path?: unknown;
	command?: unknown;
};

export interface Rule {
	tool: RuleToolName;
	match?: string;
	action: "allow" | "block" | "ask";
	reason?: string;
	externalPathAction?: "inherit" | "allow" | "ask" | "block";
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
}

export interface EffectivePolicy {
	mode: PermissionMode;
	rules: Rule[];
	externalPath: ExternalPathPolicy;
	protectedResources: ResolvedProtectedResources;
}

export type CodemodeProfileName = "analysis" | "orchestrator";
export type CodemodeCapability = "message" | "artifact" | "task" | "todo";

export interface CodemodeEffectivePolicy {
	profile: CodemodeProfileName;
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
