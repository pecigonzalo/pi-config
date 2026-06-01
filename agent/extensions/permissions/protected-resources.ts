export type ProtectedResourceAccess = "read" | "write";

export interface ProtectedResourceSandboxDenySpec {
	globs: readonly string[];
	includeGitMetadataPaths?: boolean;
}

interface ProtectedResourceDefinition {
	id: string;
	match: string;
	denyRead?: boolean;
	denyWrite?: boolean;
	sandboxDenyRead?: readonly string[];
	sandboxDenyWrite?: readonly string[];
	sandboxDenyWriteGitMetadata?: boolean;
}

export const GIT_METADATA_PROTECTED_RESOURCE_MATCH = "(^|[/])\\.git/(hooks/|config$)";

const ENV_FILE_GLOBS = ["**/.env", "**/.env.*"] as const;
const KEY_MATERIAL_GLOBS = [
	"**/*.pem",
	"**/*.key",
	"**/*.p12",
	"**/*.pfx",
	"**/*.crt",
	"**/*.ca-bundle",
] as const;

const BUILTIN_PROTECTED_RESOURCES: readonly ProtectedResourceDefinition[] = [
	{
		id: "env-files",
		match: "\\.env(\\..+)?$",
		denyRead: true,
		denyWrite: true,
		sandboxDenyRead: ENV_FILE_GLOBS,
		sandboxDenyWrite: ENV_FILE_GLOBS,
	},
	{
		id: "key-material",
		match: "\\.(pem|key|p12|pfx|crt|ca-bundle)$",
		denyRead: true,
		denyWrite: true,
		sandboxDenyRead: KEY_MATERIAL_GLOBS,
		sandboxDenyWrite: KEY_MATERIAL_GLOBS,
	},
	{
		id: "credential-directories",
		match: "(^|[/])(\\.aws[/]|\\.ssh[/]|\\.gnupg[/])",
		denyRead: true,
		sandboxDenyRead: ["**/.aws", "**/.aws/**", "**/.ssh", "**/.ssh/**", "**/.gnupg", "**/.gnupg/**"],
	},
	{
		id: "git-hooks-and-config",
		match: GIT_METADATA_PROTECTED_RESOURCE_MATCH,
		denyWrite: true,
		sandboxDenyWrite: ["**/.git/hooks", "**/.git/hooks/**", "**/.git/config"],
		sandboxDenyWriteGitMetadata: true,
	},
	{
		id: "shell-startup-files",
		match: "(^|[/])(\\.bashrc|\\.bash_profile|\\.zshrc|\\.zprofile|\\.profile)$",
		denyWrite: true,
		sandboxDenyWrite: ["**/.bashrc", "**/.bash_profile", "**/.zshrc", "**/.zprofile", "**/.profile"],
	},
	{
		id: "developer-config-files",
		match: "(^|[/])\\.(gitconfig|gitmodules|ripgreprc|mcp\\.json)$",
		denyWrite: true,
		sandboxDenyWrite: ["**/.gitconfig", "**/.gitmodules", "**/.ripgreprc", "**/.mcp.json"],
	},
	{
		id: "editor-directories",
		match: "(^|[/])(\\.vscode/|\\.idea/)",
		denyWrite: true,
		sandboxDenyWrite: ["**/.vscode", "**/.vscode/**", "**/.idea", "**/.idea/**"],
	},
	{
		id: "claude-extension-directories",
		match: "(^|[/])\\.claude/(commands/|agents/)",
		denyWrite: true,
		sandboxDenyWrite: ["**/.claude/commands", "**/.claude/commands/**", "**/.claude/agents", "**/.claude/agents/**"],
	},
] as const;

export function getBuiltinProtectedResourceMatches(access: ProtectedResourceAccess): string[] {
	return BUILTIN_PROTECTED_RESOURCES
		.filter((resource) => (access === "read" ? resource.denyRead === true : resource.denyWrite === true))
		.map((resource) => resource.match);
}

export function getProtectedResourceSandboxDenySpec(
	match: string,
	access: ProtectedResourceAccess,
): ProtectedResourceSandboxDenySpec | undefined {
	const resource = BUILTIN_PROTECTED_RESOURCES.find((candidate) => candidate.match === match);
	if (!resource) return undefined;

	const globs = access === "read" ? resource.sandboxDenyRead : resource.sandboxDenyWrite;
	const includeGitMetadataPaths = access === "write" && resource.sandboxDenyWriteGitMetadata === true;
	if ((!globs || globs.length === 0) && !includeGitMetadataPaths) return undefined;

	return {
		globs: globs ?? [],
		includeGitMetadataPaths: includeGitMetadataPaths || undefined,
	};
}
