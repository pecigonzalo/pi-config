import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
	type EffectivePolicy,
	type PermissionMode,
	type SandboxManagerLike,
	type SandboxRuntimeConfigLike,
	type SandboxSettings,
	dedupeStrings,
} from "./shared";
import { resolveToken } from "./matching";
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
	return dedupeStrings([REAL_SYSTEM_TMPDIR, os.tmpdir(), "/tmp", "/private/tmp"]);
}

let darwinUserCacheDir: string | undefined;
let darwinUserCacheDirLoaded = false;
let goBuildCacheDir: string | undefined;
let goBuildCacheDirLoaded = false;

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

function getGoBuildCacheDir(): string | undefined {
	if (process.env.GOCACHE !== undefined && process.env.GOCACHE.trim().length > 0) {
		return normalizeCacheDir(process.env.GOCACHE);
	}
	if (goBuildCacheDirLoaded) return goBuildCacheDir;
	goBuildCacheDirLoaded = true;
	try {
		const resolved = execFileSync("go", ["env", "GOCACHE"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		goBuildCacheDir = normalizeCacheDir(resolved);
	} catch {
		goBuildCacheDir = undefined;
	}
	return goBuildCacheDir;
}

function getPlatformCacheWritePaths(): string[] {
	const darwinCacheDir = getDarwinUserCacheDir();
	const darwinLibraryCacheDir = process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches") : undefined;
	const goCacheDir = getGoBuildCacheDir();
	return dedupeStrings([darwinCacheDir, darwinLibraryCacheDir, goCacheDir].filter((value): value is string => value !== undefined));
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

function summarizeSandboxHintItems(values: string[] | undefined, cwd?: string, maxItems = SANDBOX_HINT_MAX_ITEMS): string {
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
	const domainsBlocked = Array.isArray(allowedDomains)
		&& allowedDomains.length === 0
		&& Array.isArray(deniedDomains)
		&& deniedDomains.length === 0;
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
		lines.push(`- Prefer temporary/cache writes under TMPDIR=${formatSandboxHintPath(options.tmpDir, options.cwd)}.`);
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

function gitRevParse(cwd: string, arg: string): string | undefined {
	try {
		const value = execFileSync("git", ["rev-parse", arg], {
			cwd,
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
	return dedupeStrings(getGitMetadataWritePaths(cwd).flatMap((metadataPath) => [
		path.join(metadataPath, "hooks"),
		path.join(metadataPath, "hooks", "**"),
		path.join(metadataPath, "config"),
	]));
}

export function getWorkspaceWritePaths(cwd: string): string[] {
	return dedupeStrings([
		...existingPathAliases(cwd),
		...getGitMetadataWritePaths(cwd),
	]);
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

function getSandboxCacheEnv(cwd: string, env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
	const overrides = env ?? {};
	const mergedEnv: NodeJS.ProcessEnv = { ...DEFAULT_SANDBOX_ENV, ...process.env, ...overrides };
	if (!mergedEnv.GIT_SSH_COMMAND?.trim()) mergedEnv.GIT_SSH_COMMAND = DEFAULT_SANDBOX_ENV.GIT_SSH_COMMAND;
	const effectiveTmpDir = (overrides.TMPDIR && overrides.TMPDIR.trim().length > 0)
		? resolveToken(overrides.TMPDIR, cwd)
		: getEffectiveSandboxTmpDir(cwd, undefined);
	const xdgCacheHome = overrides.XDG_CACHE_HOME ?? path.join(effectiveTmpDir, "xdg-cache");
	const xdgStateHome = overrides.XDG_STATE_HOME ?? path.join(effectiveTmpDir, "xdg-state");
	const npmCache = overrides.NPM_CONFIG_CACHE ?? overrides.npm_config_cache ?? path.join(effectiveTmpDir, "npm-cache");
	const goPath = overrides.GOPATH ?? path.join(effectiveTmpDir, "go");
	const goModCache = overrides.GOMODCACHE ?? path.join(goPath, "pkg", "mod");

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
		GOCACHE: overrides.GOCACHE ?? path.join(effectiveTmpDir, "go-build-cache"),
		GOPATH: goPath,
		GOMODCACHE: goModCache,
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
	const modeDefaults: Record<PermissionMode, SandboxModeDefault> = {
		plan: { enabled: true, network: false, allowWrite: [] },
		"workspace-write": { enabled: true, network: true, allowWrite: workspaceWritePaths },
		"full-access": { enabled: false, network: true, allowWrite: workspaceWritePaths },
	};
	return modeDefaults[policy.mode];
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
	const dockerBuildxWritePaths = policy.mode === "plan" ? [] : getDockerBuildxWritePaths(cwd, overrides);
	const defaultAllowWrite = dedupeStrings([
		...modeDefault.allowWrite,
		...compatWritePaths,
		...platformCachePaths,
		...dockerBuildxWritePaths,
		effectiveTmpDir,
	]);
	const configuredAllowWrite = overrides?.allowWrite
		? resolveSandboxPathTokens(overrides.allowWrite, cwd)
		: defaultAllowWrite;
	const allowWrite = dedupeStrings([
		...configuredAllowWrite,
		...compatWritePaths,
		...platformCachePaths,
		...dockerBuildxWritePaths,
		effectiveTmpDir,
	]);
	const protectedDenyRead = getProtectedSandboxDenyPaths(policy.protectedResources.denyRead, "read", cwd);
	const protectedDenyWrite = getProtectedSandboxDenyPaths(policy.protectedResources.denyWrite, "write", cwd);
	const denyRead = dedupeStrings([
		...protectedDenyRead.paths,
		...resolveSandboxPathTokens(overrides?.denyRead ?? [], cwd),
	]);
	const denyWrite = dedupeStrings([
		...protectedDenyWrite.paths,
		...resolveSandboxPathTokens(overrides?.denyWrite ?? [], cwd),
	]);
	const warnings = dedupeStrings([
		...protectedDenyRead.unmappedPatterns.map((pattern) => formatUnmappedProtectedPatternWarning("read", pattern)),
		...protectedDenyWrite.unmappedPatterns.map((pattern) => formatUnmappedProtectedPatternWarning("write", pattern)),
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
	const socketSet = new Set<string>(overrides?.allowUnixSockets ?? []);
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
	sandboxEnv?: Record<string, string>,
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
