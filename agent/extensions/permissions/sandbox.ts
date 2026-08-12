import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
	baseRestrictionMode,
	type EffectivePolicy,
	type PermissionMode,
	type SandboxManagerLike,
	type SandboxRuntimeConfigLike,
	type SandboxSettings,
	dedupeStrings,
} from "./shared";
import { resolveToken, ruleMatch } from "./matching";
import { getProtectedResourceSandboxDenySpec, type ProtectedResourceAccess } from "./protected-resources";

/**
 * Capture the real system tmpdir before sandbox overrides $TMPDIR.
 * On macOS this is typically /var/folders/.../T/.
 */
const REAL_SYSTEM_TMPDIR = os.tmpdir();

export function getEffectiveSandboxTmpDir(cwd: string, overrides: SandboxSettings | undefined): string {
	const configured = overrides?.tmpDir ?? process.env.PI_SANDBOX_TMPDIR;
	if (configured && configured.trim().length > 0) return resolveToken(configured, cwd);
	return path.join(os.tmpdir(), "pi");
}

export function getSandboxTmpDirMode(overrides: SandboxSettings | undefined): "shared" | "session" {
	return overrides?.tmpDirMode ?? "shared";
}

function getCompatWritePaths(): string[] {
	return dedupeStrings([REAL_SYSTEM_TMPDIR, os.tmpdir(), "/tmp", "/private/tmp"].flatMap(existingPathAliases));
}

let darwinUserCacheDir: string | undefined;
let darwinUserCacheDirLoaded = false;
let goModCacheDir: string | undefined;
let goModCacheDirLoaded = false;
let goProxy: string | undefined;
let goProxyLoaded = false;

/**
 * On macOS, many tools use the per-user Darwin cache directory returned by
 * `getconf DARWIN_USER_CACHE_DIR` (typically under /var/folders/.../C).
 * Allowing this matches what Codex and Gemini do without broadly opening
 * package-manager state under $HOME.
 */
function getDarwinUserCacheDir(): string | undefined {
	if (process.platform !== "darwin") return undefined;
	if (darwinUserCacheDirLoaded) return darwinUserCacheDir;
	darwinUserCacheDirLoaded = true;
	try {
		const resolved = execFileSync("getconf", ["DARWIN_USER_CACHE_DIR"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		darwinUserCacheDir = resolved || undefined;
	} catch {
		darwinUserCacheDir = undefined;
	}
	return darwinUserCacheDir;
}

function normalizeCacheDir(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || trimmed === "off") return undefined;
	return path.isAbsolute(trimmed) ? trimmed : undefined;
}

function isSandboxPath(value: string | undefined): boolean {
	const sandboxTmpDir = normalizeCacheDir(process.env.PI_SANDBOX_TMPDIR);
	const candidate = normalizeCacheDir(value);
	if (!sandboxTmpDir || !candidate) return false;
	const relative = path.relative(sandboxTmpDir, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function getHostGoEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	if (isSandboxPath(env.GOPATH) || isSandboxPath(env.GOMODCACHE)) {
		delete env.GOPATH;
		delete env.GOMODCACHE;
	}
	return env;
}

function getGoModCacheDir(): string | undefined {
	const configured = process.env.GOMODCACHE?.trim();
	if (configured === "off") return undefined;
	// Pi may inject a session-local GOPATH/GOMODCACHE into its own environment;
	// resolve the user's normal Go environment instead of treating that overlay
	// as the reusable host cache.

	if (configured && !isSandboxPath(configured)) return normalizeCacheDir(configured);
	if (goModCacheDirLoaded) return goModCacheDir;
	goModCacheDirLoaded = true;
	try {
		const resolved = execFileSync("go", ["env", "GOMODCACHE"], {
			env: getHostGoEnv(),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		goModCacheDir = normalizeCacheDir(resolved);
	} catch {
		goModCacheDir = undefined;
	}
	return goModCacheDir;
}

function getGoProxy(): string | undefined {
	if (process.env.GOPROXY !== undefined && process.env.GOPROXY.trim().length > 0) {
		return process.env.GOPROXY.trim();
	}
	if (goProxyLoaded) return goProxy;
	goProxyLoaded = true;
	try {
		goProxy =
			execFileSync("go", ["env", "GOPROXY"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() || undefined;
	} catch {
		goProxy = undefined;
	}
	return goProxy;
}

function getGlobalGoDownloadProxy(): string | undefined {
	const globalGoModCache = getGoModCacheDir();
	if (!globalGoModCache) return undefined;
	const downloadCache = path.join(globalGoModCache, "cache", "download");
	try {
		if (!fs.statSync(downloadCache).isDirectory()) return undefined;
	} catch {
		return undefined;
	}
	return pathToFileURL(downloadCache).href;
}

function getPlatformCacheWritePaths(): string[] {
	const darwinCacheDir = getDarwinUserCacheDir();
	const darwinLibraryCacheDir =
		process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches") : undefined;
	return dedupeStrings(
		[darwinCacheDir, darwinLibraryCacheDir]
			.filter((value): value is string => value !== undefined)
			.flatMap(existingPathAliases),
	);
}

// c-ares-based tools on macOS (for example Nix curl) read DNS settings via
// SystemConfiguration instead of /etc/resolv.conf. Seatbelt blocks that Mach
// lookup unless it is explicitly allowed, which leaves network enabled but DNS
// unusable. This service exposes resolver configuration; it does not perform
// DNS requests itself, unlike mDNSResponder.
const DARWIN_DNS_CONFIG_MACH_LOOKUPS = ["com.apple.SystemConfiguration.configd"];
const DEFAULT_SANDBOX_ENV: NodeJS.ProcessEnv = {
	GIT_SSH_COMMAND: "ssh -o ControlMaster=no",
};
const SANDBOX_HINT_MAX_ITEMS = 4;

function formatSandboxHintPath(value: string, cwd: string | undefined): string {
	const home = os.homedir();
	let formatted = value;

	if (cwd && path.isAbsolute(value)) {
		const relative = path.relative(cwd, value);
		if (relative === "") return ".";
		if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
			formatted = `./${relative}`;
		}
	}

	if (formatted === home) return "~";
	if (formatted.startsWith(`${home}${path.sep}`)) return `~/${formatted.slice(home.length + 1)}`;
	return formatted;
}

function summarizeSandboxHintItems(
	values: string[] | undefined,
	cwd?: string,
	maxItems = SANDBOX_HINT_MAX_ITEMS,
): string {
	const uniqueValues = dedupeStrings((values ?? []).filter((value) => value.trim().length > 0));
	if (uniqueValues.length === 0) return "(none)";

	const shown = uniqueValues.slice(0, maxItems).map((value) => formatSandboxHintPath(value, cwd));
	const remaining = uniqueValues.length - shown.length;
	return `${shown.join(", ")}${remaining > 0 ? `, … +${remaining} more` : ""}`;
}

function summarizeSandboxNetwork(network: SandboxRuntimeConfigLike["network"]): string {
	if (!network) return "not configured";

	const allowedDomains = network.allowedDomains;
	const deniedDomains = network.deniedDomains;
	const domainsBlocked =
		Array.isArray(allowedDomains) &&
		allowedDomains.length === 0 &&
		Array.isArray(deniedDomains) &&
		deniedDomains.length === 0;
	const segments: string[] = [];

	if (domainsBlocked) {
		segments.push("blocked");
	} else if (allowedDomains === undefined && deniedDomains === undefined) {
		segments.push("unrestricted");
	} else {
		segments.push(
			allowedDomains === undefined
				? "allowed domains: any"
				: `allowed domains: ${summarizeSandboxHintItems(allowedDomains)}`,
		);
		if (deniedDomains !== undefined && deniedDomains.length > 0) {
			segments.push(`denied domains: ${summarizeSandboxHintItems(deniedDomains)}`);
		}
	}

	if (network.allowLocalBinding) segments.push("localhost binding allowed");
	if (network.allowAllUnixSockets) {
		segments.push("all Unix sockets allowed");
	} else if ((network.allowUnixSockets ?? []).length > 0) {
		segments.push(`Unix sockets: ${summarizeSandboxHintItems(network.allowUnixSockets, undefined, 2)}`);
	}

	return segments.join("; ");
}

/**
 * Returns a compact prompt hint that helps the agent avoid predictable sandbox denials.
 */
export function formatSandboxPromptHint(
	config: SandboxRuntimeConfigLike,
	options: { reason?: string; tmpDir?: string; cwd?: string } = {},
): string {
	const filesystem = config.filesystem ?? {};
	const lines = [
		`Sandbox hint for bash: OS sandbox is active${options.reason ? ` (${options.reason})` : ""}.`,
		`- Filesystem writes are limited to: ${summarizeSandboxHintItems(filesystem.allowWrite, options.cwd)}.`,
	];
	const denyRead = summarizeSandboxHintItems(filesystem.denyRead, options.cwd);
	const denyWrite = summarizeSandboxHintItems(filesystem.denyWrite, options.cwd);

	if (denyRead !== "(none)" || denyWrite !== "(none)") {
		lines.push(`- Protected paths blocked: read ${denyRead}; write ${denyWrite}.`);
	}

	lines.push(`- Network: ${summarizeSandboxNetwork(config.network)}.`);
	if (options.tmpDir) {
		lines.push(
			`- Prefer temporary/cache writes under TMPDIR=${formatSandboxHintPath(options.tmpDir, options.cwd)}.`,
		);
	}
	lines.push("- If a command needs broader filesystem or network access, ask instead of retrying blocked variants.");

	return lines.join("\n");
}

function resolveSandboxPathTokens(values: string[], cwd: string): string[] {
	return values.map((value) => resolveToken(value, cwd));
}

interface ProtectedSandboxDenyPaths {
	paths: string[];
	unmappedPatterns: string[];
}

function getProtectedSandboxDenyPaths(
	patterns: string[] | undefined,
	access: ProtectedResourceAccess,
	cwd: string,
): ProtectedSandboxDenyPaths {
	const paths: string[] = [];
	const unmappedPatterns: string[] = [];

	for (const pattern of patterns ?? []) {
		const spec = getProtectedResourceSandboxDenySpec(pattern, access);
		if (!spec) {
			unmappedPatterns.push(pattern);
			continue;
		}

		paths.push(...resolveSandboxPathTokens([...spec.globs], cwd));
		if (access === "write" && spec.includeGitMetadataPaths) {
			paths.push(...getProtectedGitDenyWritePaths(cwd));
		}
	}

	return {
		paths: dedupeStrings(paths),
		unmappedPatterns: dedupeStrings(unmappedPatterns),
	};
}

function existingPathAliases(candidate: string): string[] {
	const resolved = path.resolve(candidate);
	try {
		return dedupeStrings([resolved, fs.realpathSync.native(resolved)]);
	} catch {
		return [resolved];
	}
}

function resolveGitPathAliases(candidate: string, cwd: string): string[] {
	return existingPathAliases(path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate));
}

// git resolves --git-dir/--git-common-dir from these environment variables before it
// looks at cwd, so a subprocess spawned here would otherwise resolve against whichever
// repository the *parent* process belongs to (e.g. the real repo when this runs inside a
// git hook) instead of the workspace `cwd` explicitly passed in.
const GIT_REPOSITORY_ENV_KEYS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_PREFIX",
] as const;

function gitScopedEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of GIT_REPOSITORY_ENV_KEYS) delete env[key];
	return env;
}

function gitRevParse(cwd: string, arg: string): string | undefined {
	try {
		const value = execFileSync("git", ["rev-parse", arg], {
			cwd,
			env: gitScopedEnv(),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

function getGitMetadataWritePaths(cwd: string): string[] {
	// Starting pi from a repo subdirectory should still allow `git commit`.
	// Git writes index/object/lock files under the repository metadata directory,
	// which can live outside cwd (and outside the worktree for git worktrees).
	const gitDir = gitRevParse(cwd, "--git-dir");
	const gitCommonDir = gitRevParse(cwd, "--git-common-dir");
	return dedupeStrings([
		...(gitDir ? resolveGitPathAliases(gitDir, cwd) : []),
		...(gitCommonDir ? resolveGitPathAliases(gitCommonDir, cwd) : []),
	]);
}

function getProtectedGitDenyWritePaths(cwd: string): string[] {
	return dedupeStrings(
		getGitMetadataWritePaths(cwd).flatMap((metadataPath) => [
			path.join(metadataPath, "hooks"),
			path.join(metadataPath, "hooks", "**"),
			path.join(metadataPath, "config"),
		]),
	);
}

export function getWorkspaceWritePaths(cwd: string): string[] {
	return dedupeStrings([...existingPathAliases(cwd), ...getGitMetadataWritePaths(cwd)]);
}

function getDockerBuildxWritePaths(cwd: string, overrides: SandboxSettings | undefined): string[] {
	// Docker Buildx writes state under $DOCKER_CONFIG/buildx/activity. Without
	// this write allowance, `docker build`/`docker buildx` can fail with EPERM.
	const configuredDockerConfigDir = overrides?.env?.DOCKER_CONFIG ?? process.env.DOCKER_CONFIG;
	const dockerConfigDir = configuredDockerConfigDir?.trim()
		? resolveToken(configuredDockerConfigDir, cwd)
		: path.join(os.homedir(), ".docker");
	return dedupeStrings([
		...existingPathAliases(path.join(dockerConfigDir, "buildx")),
		...existingPathAliases(path.join(dockerConfigDir, "buildx", "activity")),
	]);
}

// Go's file proxy reads module archives from the user's cache, while module
// extraction and new downloads go to the sandbox-local GOMODCACHE. Keep the
// source cache read-only even when it overlaps another writable path.
function getGlobalGoModCacheDenyWritePaths(): string[] {
	const globalGoModCache = getGoModCacheDir();
	if (!globalGoModCache) return [];
	return dedupeStrings(
		existingPathAliases(globalGoModCache).flatMap((cachePath) => [cachePath, path.join(cachePath, "**")]),
	);
}

function configuredGoWritePaths(cwd: string, overrides: SandboxSettings | undefined): string[] {
	const env = overrides?.env;
	if (!env) return [];

	const paths: string[] = [];
	const addConfiguredPath = (value: string | undefined) => {
		const trimmed = value?.trim();
		if (!trimmed || trimmed === "off") return;
		paths.push(resolveToken(trimmed, cwd));
	};

	addConfiguredPath(env.GOCACHE);
	addConfiguredPath(env.GOTMPDIR);
	addConfiguredPath(env.GOPATH);
	addConfiguredPath(env.GOMODCACHE);

	if (env.GOPATH && !env.GOMODCACHE) {
		paths.push(path.join(resolveToken(env.GOPATH, cwd), "pkg", "mod"));
	}

	return dedupeStrings(paths.flatMap(existingPathAliases));
}

function dockerHostUnixSocketPath(): string | undefined {
	const dockerHost = process.env.DOCKER_HOST?.trim();
	if (!dockerHost?.startsWith("unix://")) return undefined;
	const socketPath = dockerHost.slice("unix://".length);
	return socketPath.length > 0 ? socketPath : undefined;
}

function getDefaultDockerUnixSockets(): string[] {
	return dedupeStrings(
		[
			dockerHostUnixSocketPath(),
			path.join(os.homedir(), ".docker", "run", "docker.sock"),
			"/var/run/docker.sock",
			"/private/var/run/docker.sock",
		].filter((value): value is string => value !== undefined),
	);
}

function getSandboxCacheEnv(cwd: string, env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
	const overrides = env ?? {};
	const mergedEnv: NodeJS.ProcessEnv = { ...DEFAULT_SANDBOX_ENV, ...process.env, ...overrides };
	if (!mergedEnv.GIT_SSH_COMMAND?.trim()) mergedEnv.GIT_SSH_COMMAND = DEFAULT_SANDBOX_ENV.GIT_SSH_COMMAND;
	const effectiveTmpDir =
		overrides.TMPDIR && overrides.TMPDIR.trim().length > 0
			? resolveToken(overrides.TMPDIR, cwd)
			: getEffectiveSandboxTmpDir(cwd, undefined);
	const xdgCacheHome = overrides.XDG_CACHE_HOME ?? path.join(effectiveTmpDir, "xdg-cache");
	const xdgStateHome = overrides.XDG_STATE_HOME ?? path.join(effectiveTmpDir, "xdg-state");
	const npmCache =
		overrides.NPM_CONFIG_CACHE ?? overrides.npm_config_cache ?? path.join(effectiveTmpDir, "npm-cache");
	const goPath = overrides.GOPATH ?? path.join(effectiveTmpDir, "go");
	const goModCache = overrides.GOMODCACHE ?? path.join(goPath, "pkg", "mod");
	const goBuildCache = overrides.GOCACHE ?? path.join(effectiveTmpDir, "go-build-cache");
	const globalGoModCache = getGoModCacheDir();
	// Use only the download-cache subtree as a read-only local module proxy;
	// Go writes extracted modules and new downloads to the local cache above.
	const globalGoProxy =
		globalGoModCache && path.resolve(globalGoModCache) !== path.resolve(goModCache)
			? getGlobalGoDownloadProxy()
			: undefined;
	const inheritedGoProxy = getGoProxy();
	const effectiveGoProxy =
		overrides.GOPROXY ??
		(globalGoProxy && inheritedGoProxy !== "off"
			? [globalGoProxy, inheritedGoProxy].filter(Boolean).join(",")
			: inheritedGoProxy || globalGoProxy);

	return {
		...mergedEnv,
		TMPDIR: effectiveTmpDir,
		XDG_CACHE_HOME: xdgCacheHome,
		XDG_STATE_HOME: xdgStateHome,
		BUN_INSTALL_CACHE_DIR: overrides.BUN_INSTALL_CACHE_DIR ?? path.join(effectiveTmpDir, "bun-cache"),
		NPM_CONFIG_CACHE: overrides.NPM_CONFIG_CACHE ?? npmCache,
		npm_config_cache: overrides.npm_config_cache ?? npmCache,
		YARN_CACHE_FOLDER: overrides.YARN_CACHE_FOLDER ?? path.join(effectiveTmpDir, "yarn-cache"),
		PIP_CACHE_DIR: overrides.PIP_CACHE_DIR ?? path.join(effectiveTmpDir, "pip-cache"),
		UV_CACHE_DIR: overrides.UV_CACHE_DIR ?? path.join(effectiveTmpDir, "uv-cache"),
		GOCACHE: goBuildCache,
		GOTMPDIR: overrides.GOTMPDIR ?? effectiveTmpDir,
		GOPATH: goPath,
		GOMODCACHE: goModCache,
		GOPROXY: effectiveGoProxy,
	};
}

export interface CompiledSandboxConfig {
	enabled: boolean;
	config: SandboxRuntimeConfigLike;
	reason: string;
	warnings: string[];
}

interface SandboxModeDefault {
	enabled: boolean;
	network: boolean;
	allowWrite: string[];
}

function formatUnmappedProtectedPatternWarning(access: ProtectedResourceAccess, pattern: string): string {
	return `Protected ${access} pattern has no sandbox path mapping and is only enforced by Pi tools: ${pattern}`;
}

function getSandboxModeDefault(policy: EffectivePolicy, cwd: string): SandboxModeDefault {
	const workspaceWritePaths = getWorkspaceWritePaths(cwd);
	// Keyed on the restriction-tier base mode (see baseRestrictionMode) — "auto" resolves to
	// "workspace-write" before indexing, so it can't drift out of sync with a fourth copied entry.
	const modeDefaults: Record<Exclude<PermissionMode, "auto">, SandboxModeDefault> = {
		plan: { enabled: true, network: false, allowWrite: [] },
		"workspace-write": { enabled: true, network: true, allowWrite: workspaceWritePaths },
		"full-access": { enabled: false, network: true, allowWrite: workspaceWritePaths },
	};
	return modeDefaults[baseRestrictionMode(policy.mode)];
}

function compileSandboxFilesystemConfig(
	policy: EffectivePolicy,
	cwd: string,
	overrides: SandboxSettings | undefined,
	effectiveTmpDir: string,
	modeDefault: SandboxModeDefault,
): { filesystem: NonNullable<SandboxRuntimeConfigLike["filesystem"]>; warnings: string[] } {
	const compatWritePaths = (overrides?.compatWritePaths ?? true) ? getCompatWritePaths() : [];
	const platformCachePaths = getPlatformCacheWritePaths();
	const goWritePaths = configuredGoWritePaths(cwd, overrides);
	const dockerBuildxWritePaths = policy.mode === "plan" ? [] : getDockerBuildxWritePaths(cwd, overrides);
	const effectiveTmpDirWritePaths = existingPathAliases(effectiveTmpDir);
	const defaultAllowWrite = dedupeStrings([
		...modeDefault.allowWrite,
		...compatWritePaths,
		...platformCachePaths,
		...goWritePaths,
		...dockerBuildxWritePaths,
		...effectiveTmpDirWritePaths,
	]);
	const configuredAllowWrite = resolveSandboxPathTokens(overrides?.addAllowWrite ?? [], cwd);
	const allowWrite = dedupeStrings([
		...defaultAllowWrite,
		...configuredAllowWrite,
		...compatWritePaths,
		...platformCachePaths,
		...goWritePaths,
		...dockerBuildxWritePaths,
		...effectiveTmpDirWritePaths,
	]);
	const protectedDenyRead = getProtectedSandboxDenyPaths(policy.protectedResources.denyRead, "read", cwd);
	const protectedDenyWrite = getProtectedSandboxDenyPaths(policy.protectedResources.denyWrite, "write", cwd);
	const denyRead = dedupeStrings([
		...protectedDenyRead.paths,
		...resolveSandboxPathTokens(overrides?.denyRead ?? [], cwd),
	]);
	const denyWrite = dedupeStrings([
		...protectedDenyWrite.paths,
		...getGlobalGoModCacheDenyWritePaths(),
		...resolveSandboxPathTokens(overrides?.denyWrite ?? [], cwd),
	]);
	const warnings = dedupeStrings([
		...protectedDenyRead.unmappedPatterns.map((pattern) => formatUnmappedProtectedPatternWarning("read", pattern)),
		...protectedDenyWrite.unmappedPatterns.map((pattern) =>
			formatUnmappedProtectedPatternWarning("write", pattern),
		),
	]);

	return {
		warnings,
		filesystem: {
			denyRead,
			allowWrite,
			denyWrite,
		},
	};
}

function compileSandboxNetworkConfig(
	networkEnabled: boolean,
	overrides: SandboxSettings | undefined,
): SandboxRuntimeConfigLike["network"] {
	const socketSet = new Set<string>([...getDefaultDockerUnixSockets(), ...(overrides?.allowUnixSockets ?? [])]);
	if (overrides?.allowSshAuthSock && process.env.SSH_AUTH_SOCK) socketSet.add(process.env.SSH_AUTH_SOCK);
	const allowUnixSockets = [...socketSet];
	const allowAllUnixSockets = overrides?.allowAllUnixSockets ?? false;
	const allowLocalBinding = overrides?.allowLocalBinding || undefined;
	const defaultMachLookups = process.platform === "darwin" && networkEnabled ? DARWIN_DNS_CONFIG_MACH_LOOKUPS : [];
	const allowMachLookup = dedupeStrings([...defaultMachLookups, ...(overrides?.allowMachLookup ?? [])]);
	const commonNetworkConfig = {
		allowUnixSockets: allowUnixSockets.length > 0 ? allowUnixSockets : undefined,
		allowAllUnixSockets: allowAllUnixSockets || undefined,
		allowLocalBinding,
		allowMachLookup: allowMachLookup.length > 0 ? allowMachLookup : undefined,
	};

	if (!networkEnabled) {
		return {
			allowedDomains: [],
			deniedDomains: [],
			...commonNetworkConfig,
		};
	}

	const explicitAllowedDomains = overrides?.allowedDomains;
	const explicitDeniedDomains = overrides?.deniedDomains;
	if (explicitAllowedDomains === undefined && explicitDeniedDomains === undefined) {
		return commonNetworkConfig;
	}

	return {
		allowedDomains: dedupeStrings(explicitAllowedDomains ?? []),
		deniedDomains: dedupeStrings(explicitDeniedDomains ?? []),
		...commonNetworkConfig,
	};
}

export function matchSandboxBypassCommand(command: string, bypassCommands: string[] | undefined): string | undefined {
	for (const pattern of bypassCommands ?? []) {
		if (ruleMatch({ tool: "bash", match: pattern, action: "allow" }, "bash", command)) return pattern;
	}
	return undefined;
}

export function compileSandboxConfig(
	policy: EffectivePolicy,
	cwd: string,
	overrides: SandboxSettings | undefined,
	runtimeTmpDir?: string,
): CompiledSandboxConfig {
	const modeDefault = getSandboxModeDefault(policy, cwd);
	const enabled = overrides?.enabled ?? modeDefault.enabled;
	const networkEnabled = overrides?.network ?? modeDefault.network;
	const effectiveTmpDir = runtimeTmpDir ?? getEffectiveSandboxTmpDir(cwd, overrides);
	const filesystem = compileSandboxFilesystemConfig(policy, cwd, overrides, effectiveTmpDir, modeDefault);

	return {
		enabled,
		reason: enabled ? `mode=${policy.mode}, tmpDir=${effectiveTmpDir}` : `disabled by mode=${policy.mode}`,
		warnings: filesystem.warnings,
		config: {
			enableWeakerNetworkIsolation: overrides?.enableWeakerNetworkIsolation || undefined,
			allowPty: overrides?.allowPty ?? true,
			network: compileSandboxNetworkConfig(networkEnabled, overrides),
			filesystem: filesystem.filesystem,
		},
	};
}

export interface SandboxedCommandOptions {
	command: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	timeout?: number;
	signal?: AbortSignal;
	onData?: (chunk: Buffer) => void;
	onStdoutData?: (chunk: Buffer) => void;
	onStderrData?: (chunk: Buffer) => void;
	stdinMode?: "ignore" | "pipe";
	onSpawn?: (child: ReturnType<typeof spawn>) => void;
	sandboxConfig?: SandboxRuntimeConfigLike;
}

export interface SandboxedCommandResult {
	exitCode: number | null;
}

export interface SandboxCommandExecution {
	config: SandboxRuntimeConfigLike;
	tmpDir: string;
	env?: NodeJS.ProcessEnv;
}

function sandboxCommandEnv(execution: SandboxCommandExecution): NodeJS.ProcessEnv | undefined {
	return execution.tmpDir
		? {
				...(execution.env ?? {}),
				TMPDIR: execution.tmpDir,
			}
		: execution.env;
}

interface NormalizedWritePathPattern {
	path: string;
	wildcard: boolean;
}

function normalizeWritePathPattern(value: string): NormalizedWritePathPattern | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;

	const wildcardIndex = trimmed.indexOf("*");
	const prefix = wildcardIndex >= 0 ? trimmed.slice(0, wildcardIndex) : trimmed;
	const normalizedPrefix = prefix.endsWith(path.sep) ? prefix.slice(0, -1) : prefix;
	const normalizedPath = normalizedPrefix.length === 0 ? path.resolve(path.sep) : path.resolve(normalizedPrefix);
	return { path: normalizedPath, wildcard: wildcardIndex >= 0 };
}

function pathContainsTarget(containerPath: string, targetPath: string): boolean {
	const relative = path.relative(containerPath, targetPath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function escapeRegex(value: string): string {
	return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

function globPathMatchesPath(pattern: string, targetPath: string): boolean {
	const normalizedPattern = path.resolve(pattern);
	const normalizedTarget = path.resolve(targetPath);
	let source = "";
	for (let i = 0; i < normalizedPattern.length; i++) {
		const char = normalizedPattern.charAt(i);
		if (char === "*") {
			if (normalizedPattern[i + 1] === "*") {
				source += ".*";
				i++;
			} else {
				source += `[^${escapeRegex(path.sep)}]*`;
			}
		} else {
			source += escapeRegex(char);
		}
	}
	return new RegExp(`^${source}$`).test(normalizedTarget);
}

function allowedWritePathCoversTarget(writePath: string, targetPath: string): boolean {
	const normalized = normalizeWritePathPattern(writePath);
	if (!normalized) return false;
	const probePath = path.join(targetPath, ".pi-sandbox-write-probe");
	if (normalized.wildcard) return globPathMatchesPath(writePath, probePath);
	return pathContainsTarget(normalized.path, path.resolve(targetPath));
}

function deniedWritePathCoversTarget(writePath: string, targetPath: string): boolean {
	const normalized = normalizeWritePathPattern(writePath);
	if (!normalized) return false;
	const probePath = path.join(targetPath, ".pi-sandbox-write-probe");
	if (normalized.wildcard) return globPathMatchesPath(writePath, probePath);
	return pathContainsTarget(normalized.path, path.resolve(probePath));
}

export function isSandboxWriteAllowedForPath(config: SandboxRuntimeConfigLike, targetPath: string): boolean {
	const allowWrite = config.filesystem?.allowWrite ?? [];
	const denyWrite = config.filesystem?.denyWrite ?? [];
	return (
		allowWrite.some((writePath) => allowedWritePathCoversTarget(writePath, targetPath)) &&
		!denyWrite.some((writePath) => deniedWritePathCoversTarget(writePath, targetPath))
	);
}

interface SandboxManagerLeaseState {
	tail: Promise<void>;
}

const sandboxManagerLeases = new WeakMap<SandboxManagerLike, SandboxManagerLeaseState>();

function getSandboxManagerLeaseState(manager: SandboxManagerLike): SandboxManagerLeaseState {
	const existing = sandboxManagerLeases.get(manager);
	if (existing) return existing;
	const created: SandboxManagerLeaseState = { tail: Promise.resolve() };
	sandboxManagerLeases.set(manager, created);
	return created;
}

async function withSandboxManagerLease<T>(manager: SandboxManagerLike, work: () => Promise<T>): Promise<T> {
	const state = getSandboxManagerLeaseState(manager);
	const previousTail = state.tail;
	let release: (() => void) | undefined;
	const nextTail = new Promise<void>((resolve) => {
		release = resolve;
	});
	state.tail = previousTail.then(
		() => nextTail,
		() => nextTail,
	);

	await previousTail;
	try {
		return await work();
	} finally {
		release?.();
	}
}

export class SandboxRuntimeAdapter {
	constructor(readonly manager: SandboxManagerLike) {}

	private async prepare(config: SandboxRuntimeConfigLike): Promise<void> {
		await this.manager.reset();
		await this.manager.initialize(config);
	}

	async reset(): Promise<void> {
		await withSandboxManagerLease(this.manager, async () => {
			await this.manager.reset();
		});
	}

	async initialize(
		config: SandboxRuntimeConfigLike,
		_configKey: string,
		options: { onResetError?: (error: unknown) => void } = {},
	): Promise<void> {
		await withSandboxManagerLease(this.manager, async () => {
			try {
				await this.manager.reset();
			} catch (err) {
				options.onResetError?.(err);
				throw err;
			}
			await this.manager.initialize(config);
		});
	}

	createBashOperations(execution: SandboxCommandExecution): BashOperations {
		return {
			exec: (command, cwd, options) =>
				this.runCommand(execution, {
					command,
					cwd,
					timeout: options.timeout,
					signal: options.signal,
					onData: options.onData,
				}),
		};
	}

	runCommand(
		execution: SandboxCommandExecution,
		options: Omit<SandboxedCommandOptions, "env" | "sandboxConfig">,
	): Promise<SandboxedCommandResult> {
		return withSandboxManagerLease(this.manager, async () => {
			await this.prepare(execution.config);
			return runSandboxedCommand(this.manager, {
				...options,
				env: sandboxCommandEnv(execution),
				sandboxConfig: execution.config,
			});
		});
	}
}

function killSandboxedChild(child: ReturnType<typeof spawn>) {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

export async function runSandboxedCommand(
	sandboxManager: SandboxManagerLike,
	{
		command,
		cwd,
		env,
		timeout,
		signal,
		onData,
		onStdoutData,
		onStderrData,
		stdinMode,
		onSpawn,
		sandboxConfig,
	}: SandboxedCommandOptions,
): Promise<SandboxedCommandResult> {
	const sandboxEnv = getSandboxCacheEnv(cwd, env);
	const effectiveTmpDir = sandboxEnv.TMPDIR;
	if (effectiveTmpDir) fs.mkdirSync(effectiveTmpDir, { recursive: true });

	const previousTmpDir = process.env.TMPDIR;
	const previousClaudeTmpDir = process.env.CLAUDE_TMPDIR;
	let wrappedCommand: string;
	try {
		// sandbox-runtime currently bakes TMPDIR into the generated wrapper by
		// reading process.env.CLAUDE_TMPDIR during wrapWithSandbox(). Keep that
		// upstream compatibility variable private to this call; the spawned
		// command receives Pi's normal TMPDIR instead.
		if (sandboxEnv.TMPDIR) process.env.TMPDIR = sandboxEnv.TMPDIR;
		if (effectiveTmpDir) process.env.CLAUDE_TMPDIR = effectiveTmpDir;
		wrappedCommand = await sandboxManager.wrapWithSandbox(command, undefined, sandboxConfig, signal);
	} finally {
		if (previousTmpDir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpDir;
		if (previousClaudeTmpDir === undefined) delete process.env.CLAUDE_TMPDIR;
		else process.env.CLAUDE_TMPDIR = previousClaudeTmpDir;
	}

	return new Promise((resolve, reject) => {
		const child = spawn("bash", ["-c", wrappedCommand], {
			cwd,
			env: sandboxEnv,
			detached: true,
			stdio: [stdinMode ?? "ignore", "pipe", "pipe"],
		});

		onSpawn?.(child);

		let timedOut = false;
		let timeoutHandle: NodeJS.Timeout | undefined;

		if (timeout !== undefined && timeout > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				killSandboxedChild(child);
			}, timeout * 1000);
		}

		child.stdout?.on("data", (chunk) => {
			onStdoutData?.(chunk);
			onData?.(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			onStderrData?.(chunk);
			onData?.(chunk);
		});

		child.on("error", (err) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			reject(err);
		});

		const onAbort = () => killSandboxedChild(child);
		signal?.addEventListener("abort", onAbort, { once: true });

		child.on("close", (code) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			signal?.removeEventListener("abort", onAbort);

			if (signal?.aborted) reject(new Error("aborted"));
			else if (timedOut) reject(new Error(`timeout:${timeout}`));
			else resolve({ exitCode: code });
		});
	});
}

export function createSandboxedBashOps(
	sandboxManager: SandboxManagerLike,
	runtimeTmpDir?: string,
	sandboxEnv?: NodeJS.ProcessEnv,
	sandboxConfig?: SandboxRuntimeConfigLike,
): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			return runSandboxedCommand(sandboxManager, {
				command,
				cwd,
				env: runtimeTmpDir
					? {
							...(sandboxEnv ?? {}),
							TMPDIR: runtimeTmpDir,
						}
					: sandboxEnv,
				timeout,
				signal,
				onData,
				sandboxConfig,
			});
		},
	};
}
