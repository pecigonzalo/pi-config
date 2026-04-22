import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { BashOperations } from "@mariozechner/pi-coding-agent";
import {
	type EffectivePolicy,
	type PermissionMode,
	type SandboxManagerLike,
	type SandboxRuntimeConfigLike,
	type SandboxSettings,
	dedupeStrings,
} from "./shared";
import { resolveToken } from "./matching";

export function getEffectiveSandboxTmpDir(cwd: string, overrides: SandboxSettings | undefined): string {
	const configured = overrides?.tmpDir ?? process.env.PI_SANDBOX_TMPDIR ?? process.env.CLAUDE_TMPDIR;
	if (configured && configured.trim().length > 0) return resolveToken(configured, cwd);
	return path.join(os.tmpdir(), "pi");
}

export function getSandboxTmpDirMode(overrides: SandboxSettings | undefined): "shared" | "session" {
	return overrides?.tmpDirMode ?? "session";
}

function getCompatWritePaths(): string[] {
	return dedupeStrings([os.tmpdir(), "/tmp", "/private/tmp"]);
}

export function compileSandboxConfig(
	policy: EffectivePolicy,
	cwd: string,
	overrides: SandboxSettings | undefined,
	runtimeTmpDir?: string,
): { enabled: boolean; config: SandboxRuntimeConfigLike; reason: string } {
	const modeDefaults: Record<PermissionMode, { enabled: boolean; network: boolean; allowWrite: string[] }> = {
		plan: { enabled: true, network: false, allowWrite: [] },
		"workspace-write": { enabled: true, network: true, allowWrite: [cwd] },
		"full-access": { enabled: false, network: true, allowWrite: [cwd] },
	};

	const modeDefault = modeDefaults[policy.mode];
	const enabled = overrides?.enabled ?? modeDefault.enabled;
	const networkEnabled = overrides?.network ?? modeDefault.network;
	const effectiveTmpDir = runtimeTmpDir ?? getEffectiveSandboxTmpDir(cwd, overrides);
	const compatWritePaths = (overrides?.compatWritePaths ?? true) ? getCompatWritePaths() : [];
	const defaultAllowWrite = dedupeStrings([...modeDefault.allowWrite, ...compatWritePaths, effectiveTmpDir]);
	const allowWrite = dedupeStrings([...(overrides?.allowWrite ?? defaultAllowWrite), ...compatWritePaths, effectiveTmpDir]);
	const denyRead = dedupeStrings([...(policy.protectedResources.denyRead ?? []), ...(overrides?.denyRead ?? [])]);
	const denyWrite = dedupeStrings([...(policy.protectedResources.denyWrite ?? []), ...(overrides?.denyWrite ?? [])]);
	const socketSet = new Set<string>(overrides?.allowUnixSockets ?? []);
	if (overrides?.allowSshAuthSock && process.env.SSH_AUTH_SOCK) socketSet.add(process.env.SSH_AUTH_SOCK);
	const allowUnixSockets = [...socketSet];
	const allowAllUnixSockets = overrides?.allowAllUnixSockets ?? false;
	const explicitAllowedDomains = overrides?.allowedDomains;
	const explicitDeniedDomains = overrides?.deniedDomains;
	const hasExplicitDomainPolicy = explicitAllowedDomains !== undefined || explicitDeniedDomains !== undefined;

	const networkConfig = !networkEnabled
		? {
				allowedDomains: [],
				deniedDomains: [],
				allowUnixSockets: allowUnixSockets.length > 0 ? allowUnixSockets : undefined,
				allowAllUnixSockets: allowAllUnixSockets || undefined,
			}
		: hasExplicitDomainPolicy
			? {
					allowedDomains: dedupeStrings(explicitAllowedDomains ?? []),
					deniedDomains: dedupeStrings(explicitDeniedDomains ?? []),
					allowUnixSockets: allowUnixSockets.length > 0 ? allowUnixSockets : undefined,
					allowAllUnixSockets: allowAllUnixSockets || undefined,
				}
			: {
					allowUnixSockets: allowUnixSockets.length > 0 ? allowUnixSockets : undefined,
					allowAllUnixSockets: allowAllUnixSockets || undefined,
				};

	return {
		enabled,
		reason: enabled ? `mode=${policy.mode}, tmpDir=${effectiveTmpDir}` : `disabled by mode=${policy.mode}`,
		config: {
			network: networkConfig,
			filesystem: {
				denyRead,
				allowWrite,
				denyWrite,
			},
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
	}: SandboxedCommandOptions,
): Promise<SandboxedCommandResult> {
	const wrappedCommand = await sandboxManager.wrapWithSandbox(command);

	return new Promise((resolve, reject) => {
		const child = spawn("bash", ["-c", wrappedCommand], {
			cwd,
			env,
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

export function createSandboxedBashOps(sandboxManager: SandboxManagerLike): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			return runSandboxedCommand(sandboxManager, {
				command,
				cwd,
				timeout,
				signal,
				onData,
			});
		},
	};
}
