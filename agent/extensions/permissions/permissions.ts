/**
 * Permissions Extension
 *
 * A configurable, rule-based permission system for controlling tool access.
 * Supports default rules, per-agent profile overrides, and an external-path
 * policy that restricts file operations to the current project directory.
 *
 * Config file locations (both are merged; project-local wins on conflict):
 *   ~/.pi/agent/permissions.jsonc    : global
 *   .pi/permissions.jsonc            : project-local
 *
 * Agent name resolution (first match wins):
 *   1. PI_AGENT_NAME environment variable
 *   2. --agent-name CLI flag
 *   3. Runtime-selected main-session agent
 *   4. Falls back to "default" profile
 *
 * To wire up with the task extension, set PI_AGENT_NAME in the spawn env:
 *   proc = spawn(cmd, args, { env: { ...process.env, PI_AGENT_NAME: agent.name } })
 *
 * Config format:
 * {
 *   "default": {
 *     "rules": [
 *       // action: what to do when this rule matches
 *       // externalPathAction: override the global externalPath policy for a
 *       //   structured filesystem rule. "inherit" (default) defers to the
 *       //   global policy; "allow" skips the external-path check entirely.
 *       { "tool": "read",  "match": "\\.env$", "action": "block", "reason": "Protected" },
 *       { "tool": "write", "match": "\\.env$", "action": "block", "reason": "Protected" },
 *       { "tool": "read",  "match": "\\.env\\.example$", "action": "allow", "externalPathAction": "allow" }
 *     ],
 *     // What to do when a structured filesystem tool (read/write/edit/grep/find/ls)
 *     // targets a path outside the current working directory.
 *     // Bash is intentionally excluded here: shell path extraction is too fragile
 *     // for reliable enforcement and should be handled by an OS sandbox backend.
 *     // Explicit "allow" rules with externalPathAction: "allow" bypass this.
 *     //   "allow" : no restriction (default)
 *     //   "ask"   : prompt when path is outside cwd
 *     //   "block" : block when path is outside cwd
 *     "externalPath": "ask"
 *   },
 *   "agents": {
 *     "reviewer": {
 *       "inherit": false,
 *       "rules": [...],
 *       "externalPath": "block"
 *     }
 *   }
 * }
 *
 * Rule fields:
 *   tool              : tool name or "*" for any tool
 *   match             : optional matcher for command/path target:
 *                        - advanced: regex (if regex metacharacters are present)
 *                        - bash shorthand: "rg" (word boundary), "rg *" (prefix)
 *                        - non-bash shorthand: case-insensitive substring
 *   action            : "allow" | "block" | "ask"
 *   reason            : optional human-readable string for prompts/notifications
 *   externalPathAction: "inherit" (default) | "allow" | "ask" | "block"
 *                        Overrides the global externalPath policy for this rule.
 *                        Only meaningful for structured filesystem tools when
 *                        action is "allow". Bash ignores this for now.
 *
 * Rules are evaluated in order; the first matching rule wins.
 * If no rule matches, the externalPath policy is checked for structured
 * filesystem tools, then the call is allowed.
 *
 * Per-agent profiles:
 *   inherit     : true (default): agent rules are prepended to default rules
 *                  false: agent rules completely replace default rules
 *   externalPath: overrides the default externalPath policy for this agent
 *                  (structured filesystem tools only)
 */

import type { BashOperations, ExtensionAPI, ExtensionContext, UserBashEventResult } from "@earendil-works/pi-coding-agent";
import { createBashTool, createLocalBashOperations, getAgentDir } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	activePolicy,
	loadConfig,
	mergeDefaultConfig,
	readJsonFile,
	resolveProtectedResources,
} from "./config";
import { writeApprovalFileAtomic } from "./approval-store";
import {
	approvalsCoverBash,
	approvalsCoverPaths,
	approvalsCoverTool,
	dedupeApprovals,
	extractApprovalRecords,
	formatApprovalScope,
	getApprovalsSettings,
	pruneExpiredApprovals,
} from "./approvals";
import {
	asPermissionToolInput,
	asPermissionToolName,
	canonicalizePath,
	canonicalizePathToken,
	getCommandInput,
	getExternalPaths,
	getFilesystemApprovalTargets,
	getMatchTarget,
	getPathInput,
	matchRule,
	isPathOutsideCwd,
} from "./matching";
import {
	canAutoApproveParsedBash,
	detectDangerousBashPattern,
	getFirstUnapprovedParsedCommand,
	isAllParsedCommandsAllowed,
	sandboxFallbackModeForPolicy,
} from "./shell-policy";
import {
	isTreeSitterAvailable,
	parseBashCommand,
	type ParsedBash,
	type ParsedCommand,
} from "./shell-parse";
import {
	compileSandboxConfig,
	formatSandboxPromptHint,
	getEffectiveSandboxTmpDir,
	getSandboxTmpDirMode,
	isSandboxWriteAllowedForPath,
	matchSandboxBypassCommand,
	SandboxRuntimeAdapter,
} from "./sandbox";
import {
	runSandboxedCommandAfterHealthCheck,
	SandboxHealthMonitor,
} from "./sandbox-lifecycle";
import { formatPermissionPreview } from "./preview";
import {
	dedupeStrings,
	isFilesystemToolName,
	type ApprovalRecord,
	type PermissionMode,
	type PermissionToolInput,
	type PermissionToolName,
	type PermissionsConfig,
	type Rule,
	type SandboxRuntimeConfigLike,
} from "./shared";
export type { AgentProfile, ExternalPathPolicy, PermissionMode, PermissionsConfig, Rule } from "./shared";

type PermissionDecision =
	| { action: "allow" }
	| { action: "block"; reason: string };

const ALLOW_PERMISSION: PermissionDecision = { action: "allow" };

function blockPermission(reason: string): PermissionDecision {
	return { action: "block", reason };
}

function toToolCallResult(decision: PermissionDecision): { block: true; reason: string } | undefined {
	return decision.action === "block"
		? { block: true, reason: decision.reason }
		: undefined;
}

// ─── Agent name detection ─────────────────────────────────────────────────────

function detectAgentName(pi: ExtensionAPI): string {
	if (process.env.PI_AGENT_NAME) return process.env.PI_AGENT_NAME;
	const flagValue = pi.getFlag("agent-name");
	if (typeof flagValue === "string" && flagValue.length > 0) return flagValue;
	return "default";
}

function detectProfileName(pi: ExtensionAPI): string | undefined {
	if (process.env.PI_PROFILE_NAME) return process.env.PI_PROFILE_NAME;
	const flagValue = pi.getFlag("profile-name");
	if (typeof flagValue === "string" && flagValue.length > 0) return flagValue;
	return undefined;
}

function sanitizeMcpPathSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "session";
}

function getMcpDaemonDir(cwd: string, sessionId: string | undefined): string {
	return path.join(path.resolve(cwd), ".pi", "mcporter-daemon", sanitizeMcpPathSegment(sessionId ?? "session"));
}

function applyMcpEnvironment(cwd: string, sessionId?: string): void {
	const daemonDir = getMcpDaemonDir(cwd, sessionId);
	fs.mkdirSync(daemonDir, { recursive: true });
	process.env.MCPORTER_DAEMON_DIR = daemonDir;
}

// ─── Extension ────────────────────────────────────────────────────────────────

export const PERMISSIONS_COMPLETIONS = [
	{ value: "help",      label: "help: show usage" },
	{ value: "approvals", label: "approvals: show session approvals" },
	{ value: "reset",     label: "reset: reset approvals/rules" },
	{ value: "mode",      label: "mode: show permission mode" },
	{ value: "sandbox",   label: "sandbox: show or manage sandbox (status|probe|repair|enable|disable)" },
] as const;

export interface PermissionsExtensionDependencies {
	writeApprovalFile?: typeof writeApprovalFileAtomic;
}

export default function (pi: ExtensionAPI, dependencies: PermissionsExtensionDependencies = {}) {
	const writeApprovalFile = dependencies.writeApprovalFile ?? writeApprovalFileAtomic;
	pi.registerFlag("agent-name", {
		description: "Agent profile name to use for permissions (overrides PI_AGENT_NAME env var)",
		type: "string",
		default: "",
	});
	pi.registerFlag("no-sandbox", {
		description: "Disable bash sandboxing even if the sandbox backend is installed",
		type: "boolean",
		default: false,
	});

	const bashToolTemplate = createBashTool(process.cwd());
	let sandboxRuntime: SandboxRuntimeAdapter | undefined;
	let treeSitterReady = false;
	type SandboxBashFallbackMode = "normal" | "ask-all-bash" | "block-all-bash";
	type SandboxExecution = {
		cwd: string;
		policyMode: PermissionMode;
		enabled: boolean;
		config: SandboxRuntimeConfigLike;
		configKey: string;
		reason: string;
		tmpDir: string;
		env?: Record<string, string>;
		warnings: string[];
		fallbackMode: SandboxBashFallbackMode;
		bypassCommands: string[];
	};
	type SandboxState =
		| { kind: "inactive"; reason: string; fallbackMode: SandboxBashFallbackMode; execution?: SandboxExecution }
		| { kind: "active"; reason: string; execution: SandboxExecution }
		| { kind: "disabled"; reason: string; fallbackMode: SandboxBashFallbackMode; execution?: SandboxExecution }
		| { kind: "unavailable"; reason: string; fallbackMode: SandboxBashFallbackMode; execution: SandboxExecution }
		| { kind: "failed"; reason: string; fallbackMode: SandboxBashFallbackMode; execution: SandboxExecution };
	const SANDBOX_RESUME_IDLE_PROBE_MS = 5 * 60 * 1000;
	let sandboxState: SandboxState = { kind: "inactive", reason: "inactive", fallbackMode: "normal" };
	let sandboxLifecycleGeneration = 0;
	let sandboxDisabledForSession = false;
	let sandboxTmpDir: string | undefined;
	let sandboxTmpDirEphemeral = false;
	const sandboxHealthMonitor = new SandboxHealthMonitor(SANDBOX_RESUME_IDLE_PROBE_MS);

	const clearSandboxEnv = () => {
		delete process.env.PI_SANDBOX_ACTIVE;
		delete process.env.PI_SANDBOX_REASON;
		delete process.env.PI_SANDBOX_TMPDIR;
	};

	const setSandboxEnv = (reason: string, tmpDir: string | undefined) => {
		process.env.PI_SANDBOX_ACTIVE = "1";
		process.env.PI_SANDBOX_REASON = reason;
		if (tmpDir) process.env.PI_SANDBOX_TMPDIR = tmpDir;
		else delete process.env.PI_SANDBOX_TMPDIR;
	};

	function activeSandboxState(): Extract<SandboxState, { kind: "active" }> | undefined {
		return sandboxState.kind === "active" ? sandboxState : undefined;
	}

	function sandboxStatusText(): string {
		return sandboxState.kind === "active" ? "active" : sandboxState.reason;
	}

	function sandboxFallbackMode(): SandboxBashFallbackMode {
		return sandboxState.kind === "active" ? "normal" : sandboxState.fallbackMode;
	}

	function sandboxBashExecutionMode(): string {
		if (sandboxState.kind === "active") return "sandboxed";
		return sandboxState.fallbackMode === "normal" ? "local" : `local (${sandboxState.fallbackMode})`;
	}

	function sandboxPromptConfig(): SandboxRuntimeConfigLike | undefined {
		return sandboxState.execution?.config;
	}

	function formatRuleMatch(rule: Rule): string {
		if (rule.match === undefined) return "-";
		const patterns = Array.isArray(rule.match) ? rule.match : [rule.match];
		return patterns.map((pattern) => `/${pattern}/`).join(" | ");
	}

	function sandboxBypassReasonForRule(rule: Rule, detail?: string): string {
		const ruleText = rule.match ? `sandbox=false rule ${formatRuleMatch(rule)}` : "sandbox=false catch-all rule";
		return detail ? `${ruleText} (${detail})` : ruleText;
	}

	async function sandboxBypassMatch(command: string, execution: SandboxExecution): Promise<string | undefined> {
		const policy = activePolicy(config, agentName, profileName);
		const rule = matchRule(policy.rules, "bash", { command });
		if (rule?.sandbox === false && rule.action !== "block") {
			return sandboxBypassReasonForRule(rule);
		}

		if (treeSitterReady) {
			try {
				const parsed = await parseBashCommand(command);
				for (const parsedCommand of parsed.commands) {
					const parsedRule = matchRule(policy.rules, "bash", { command: parsedCommand.source });
					if (parsedRule?.sandbox === false && parsedRule.action !== "block") {
						return sandboxBypassReasonForRule(parsedRule, "matched shell segment");
					}
				}
			} catch {
				// Keep the existing whole-command matching behavior if parsing fails.
			}
		}

		return matchSandboxBypassCommand(command, execution.bypassCommands);
	}

	function notifySandboxBypass(ctx: ExtensionContext, match: string) {
		if (!ctx.hasUI) return;
		ctx.ui.notify(`Bash sandbox bypassed for command matching: ${match}`, "warning");
	}

	let ensureSandboxHealthyAfterIdle: (ctx: ExtensionContext, execution: SandboxExecution, runtime: SandboxRuntimeAdapter, signal?: AbortSignal) => Promise<void> = async () => {};

	pi.registerTool({
		...bashToolTemplate,
		label: "bash",
		async execute(id, params, signal, onUpdate, ctx) {
			const localBash = createBashTool(ctx.cwd);
			let active = activeSandboxState();
			if (!active || active.execution.cwd !== ctx.cwd) {
				await initializeSandbox(ctx);
				active = activeSandboxState();
			}
			if (!active || !sandboxRuntime) {
				return localBash.execute(id, params, signal, onUpdate);
			}
			const lifecycleGeneration = sandboxLifecycleGeneration;
			const bypassMatch = await sandboxBypassMatch(params.command, active.execution);
			if (bypassMatch) {
				notifySandboxBypass(ctx, bypassMatch);
				return localBash.execute(id, params, signal, onUpdate);
			}
			const healthRuntime = sandboxRuntime;
			const healthExecution = active.execution;
			return runSandboxedCommandAfterHealthCheck({
				healthMonitor: sandboxHealthMonitor,
				ensureHealthy: (signal) => ensureSandboxHealthyAfterIdle(ctx, healthExecution, healthRuntime, signal),
				signal,
				execute: () => {
					const currentActive = activeSandboxState();
					const currentRuntime = sandboxRuntime;
					if (
						!currentActive
						|| !currentRuntime
						|| sandboxLifecycleGeneration !== lifecycleGeneration
					) {
						throw new Error("Bash sandbox changed or became unavailable before command execution; blocked local fallback");
					}
					const sandboxedBash = createBashTool(ctx.cwd, {
						operations: currentRuntime.createBashOperations(currentActive.execution),
					});
					return sandboxedBash.execute(id, params, signal, onUpdate);
				},
			});
		},
	});

	let config: PermissionsConfig = {};
	let agentName = "default";
	let profileName: string | undefined;
	let approvalsSettings = getApprovalsSettings(config);
	let persistentApprovals: ApprovalRecord[] = [];

	const sessionAllows = new Set<string>();
	const sessionPathApprovals: ApprovalRecord[] = [];
	const sessionBashApprovals: ApprovalRecord[] = [];
	const approvalsFile = path.join(getAgentDir(), "permissions-approvals.json");

	const warnPermissionIssue = (ctx: ExtensionContext | undefined, message: string) => {
		if (ctx?.hasUI) {
			ctx.ui.notify(`Permissions warning: ${message}`, "warning");
			return;
		}
		console.warn(`[permissions] ${message}`);
	};

	const loadApprovals = (ctx?: ExtensionContext) => {
		const parsed = readJsonFile(approvalsFile, {
			onWarning: (message) => warnPermissionIssue(ctx, message),
		});
		const loaded = extractApprovalRecords(
			parsed,
			(message) => warnPermissionIssue(ctx, message),
			approvalsFile,
		);
		persistentApprovals = dedupeApprovals(pruneExpiredApprovals(loaded, approvalsSettings));
	};

	const saveApprovals = (ctx?: ExtensionContext): boolean => {
		const data = { approvals: dedupeApprovals(pruneExpiredApprovals(persistentApprovals, approvalsSettings)) };
		try {
			writeApprovalFile(approvalsFile, data);
			return true;
		} catch (error) {
			warnPermissionIssue(ctx, `Failed to save approvals at ${approvalsFile}: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	};

	const reload = (ctx: ExtensionContext) => {
		config = loadConfig(ctx.cwd, {
			onWarning: (message) => warnPermissionIssue(ctx, message),
		});
		agentName = detectAgentName(pi);
		profileName = detectProfileName(pi);
		approvalsSettings = getApprovalsSettings(config);
		loadApprovals(ctx);
	};

	const createPathApproval = (toolName: PermissionToolName, scopeValue: string, projectRoot: string): ApprovalRecord => ({
		tool: toolName,
		scopeType: "path-prefix",
		scopeValue,
		projectRoot: approvalsSettings.scopeByProject ? projectRoot : undefined,
		agentName: approvalsSettings.scopeByAgent ? agentName : undefined,
		createdAt: Date.now(),
	});

	const addSessionPathApprovals = (toolName: PermissionToolName, scopeValues: string[], projectRoot: string) => {
		sessionPathApprovals.push(...dedupeStrings(scopeValues).map((scopeValue) => createPathApproval(toolName, scopeValue, projectRoot)));
	};

	const savePathApprovals = (toolName: PermissionToolName, scopeValues: string[], projectRoot: string, ctx: ExtensionContext): boolean => {
		const previousApprovals = persistentApprovals;
		persistentApprovals = dedupeApprovals([
			...persistentApprovals,
			...dedupeStrings(scopeValues).map((scopeValue) => createPathApproval(toolName, scopeValue, projectRoot)),
		]);
		if (saveApprovals(ctx)) return true;
		persistentApprovals = previousApprovals;
		return false;
	};

	async function resetSandboxRuntime(ctx?: ExtensionContext, reason?: string) {
		if (!sandboxRuntime) return;
		try {
			await sandboxRuntime.reset();
		} catch (err) {
			if (ctx) {
				const suffix = reason ? ` ${reason}` : "";
				warnPermissionIssue(ctx, `Sandbox reset failed${suffix}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	function buildSandboxExecution(ctx: ExtensionContext): SandboxExecution {
		const policy = activePolicy(config, agentName, profileName);
		const tmpDirBase = getEffectiveSandboxTmpDir(ctx.cwd, config.sandbox);
		const tmpDirMode = getSandboxTmpDirMode(config.sandbox);
		let effectiveTmpDir = tmpDirBase;
		try {
			fs.mkdirSync(tmpDirBase, { recursive: true });
			if (tmpDirMode === "session") {
				if (!sandboxTmpDir || !sandboxTmpDirEphemeral) {
					sandboxTmpDir = fs.mkdtempSync(path.join(tmpDirBase, "session-"));
					sandboxTmpDirEphemeral = true;
				}
				effectiveTmpDir = sandboxTmpDir;
			} else {
				sandboxTmpDir = tmpDirBase;
				sandboxTmpDirEphemeral = false;
				effectiveTmpDir = tmpDirBase;
			}
		} catch {
			// best-effort; sandbox init will fail later if unusable
			effectiveTmpDir = tmpDirBase;
			sandboxTmpDir = effectiveTmpDir;
			sandboxTmpDirEphemeral = false;
		}
		const compiled = compileSandboxConfig(policy, ctx.cwd, config.sandbox, effectiveTmpDir);
		return {
			cwd: ctx.cwd,
			policyMode: policy.mode,
			enabled: compiled.enabled,
			config: compiled.config,
			configKey: JSON.stringify(compiled.config),
			reason: compiled.reason,
			tmpDir: effectiveTmpDir,
			env: config.sandbox?.env,
			warnings: compiled.warnings,
			fallbackMode: sandboxFallbackModeForPolicy(policy.mode),
			bypassCommands: config.sandbox?.bypassCommands ?? [],
		};
	}

	async function initializeSandbox(ctx: ExtensionContext) {
		sandboxState = { kind: "inactive", reason: "inactive", fallbackMode: "normal" };
		clearSandboxEnv();

		const execution = buildSandboxExecution(ctx);
		if (ctx.hasUI && execution.warnings.length > 0) {
			ctx.ui.notify(execution.warnings.join("\n"), "warning");
		}

		if ((pi.getFlag("no-sandbox") as boolean) === true) {
			await resetSandboxRuntime(ctx, "after --no-sandbox");
			sandboxState = {
				kind: "disabled",
				reason: "disabled by --no-sandbox",
				fallbackMode: execution.fallbackMode,
				execution,
			};
			return;
		}

		if (sandboxDisabledForSession) {
			await resetSandboxRuntime(ctx, "after /permissions sandbox disable");
			sandboxState = {
				kind: "disabled",
				reason: "disabled by /permissions sandbox disable",
				fallbackMode: execution.fallbackMode,
				execution,
			};
			return;
		}

		if (!execution.enabled) {
			await resetSandboxRuntime(ctx, "after sandbox disabled by config");
			sandboxState = {
				kind: "disabled",
				reason: execution.reason,
				fallbackMode: execution.fallbackMode,
				execution,
			};
			return;
		}

		if (process.platform !== "darwin" && process.platform !== "linux") {
			await resetSandboxRuntime(ctx, "after unsupported platform detection");
			sandboxState = {
				kind: "unavailable",
				reason: `unsupported platform: ${process.platform}`,
				fallbackMode: execution.fallbackMode,
				execution,
			};
			return;
		}

		try {
			const mod = await import("@anthropic-ai/sandbox-runtime");
			if (!sandboxRuntime || sandboxRuntime.manager !== mod.SandboxManager) {
				sandboxRuntime = new SandboxRuntimeAdapter(mod.SandboxManager);
			}
		} catch {
			await resetSandboxRuntime(ctx, "after backend import failure");
			sandboxState = {
				kind: "unavailable",
				reason: "backend not installed",
				fallbackMode: execution.fallbackMode,
				execution,
			};
			if (ctx.hasUI) {
				ctx.ui.notify("Bash sandbox unavailable: install dependencies in ~/.pi/agent/extensions/permissions/", "warning");
			}
			return;
		}

		try {
			if (!sandboxRuntime) throw new Error("Sandbox runtime unavailable after backend import");
			await sandboxRuntime.initialize(execution.config, execution.configKey, {
				onResetError: (err) => warnPermissionIssue(ctx, `Sandbox reset failed before reinitializing: ${err instanceof Error ? err.message : String(err)}`),
			});
			sandboxState = { kind: "active", reason: execution.reason, execution };
			setSandboxEnv(execution.reason, execution.tmpDir);
			if (ctx.hasUI) {
				ctx.ui.notify(`Bash sandbox active (${execution.reason})`, "info");
			}
		} catch (err) {
			await resetSandboxRuntime(ctx, "after failed initialization");
			sandboxState = {
				kind: "failed",
				reason: `init failed: ${err instanceof Error ? err.message : String(err)}`,
				fallbackMode: execution.fallbackMode,
				execution,
			};
			if (ctx.hasUI) {
				ctx.ui.notify(`Bash sandbox failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		}
	}

	async function disableSandboxForSession(ctx: ExtensionContext) {
		sandboxDisabledForSession = true;
		if (sandboxState.kind === "active" && sandboxRuntime) {
			await resetSandboxRuntime(ctx, "while disabling");
		}

		const execution = buildSandboxExecution(ctx);
		sandboxState = {
			kind: "disabled",
			reason: "disabled by /permissions sandbox disable",
			fallbackMode: execution.fallbackMode,
			execution,
		};
		clearSandboxEnv();
	}

	async function enableSandboxForSession(ctx: ExtensionContext) {
		sandboxDisabledForSession = false;
		if (sandboxState.kind === "active" && sandboxRuntime) {
			await resetSandboxRuntime(ctx, "while re-enabling");
		}

		await initializeSandbox(ctx);
	}

	function shellQuote(value: string): string {
		return `'${value.replace(/'/g, "'\\''")}'`;
	}

	type SandboxProbeResult = {
		ok: boolean;
		message: string;
		level: "info" | "warning" | "error";
		tmpDirOk?: boolean;
		cwdWriteExpected?: boolean;
		cwdWriteOk?: boolean;
	};

	type SandboxWriteProbeResult = {
		ok: boolean;
		message: string;
	};

	function throwIfAborted(signal: AbortSignal | undefined): void {
		if (signal?.aborted) throw new Error("aborted");
	}

	async function runSandboxWriteProbe(
		runtime: SandboxRuntimeAdapter,
		execution: SandboxExecution,
		targetPath: string,
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<SandboxWriteProbeResult> {
		throwIfAborted(signal);
		const probePath = path.join(targetPath, `.pi-sandbox-write-probe-${process.pid}-${Date.now()}`);
		const quotedProbePath = shellQuote(probePath);
		const output: string[] = [];
		try {
			const result = await runtime.runCommand(execution, {
				command: `printf '%s\\n' probe > ${quotedProbePath} && test -f ${quotedProbePath} && rm -f ${quotedProbePath}`,
				cwd: ctx.cwd,
				timeout: 10,
				signal,
				onData: (chunk) => output.push(chunk.toString("utf8")),
			});
			if (result.exitCode === 0) return { ok: true, message: "passed" };

			const details = output.join("").trim();
			return {
				ok: false,
				message: `failed with exit code ${result.exitCode ?? "unknown"}${details ? `: ${details}` : ""}`,
			};
		} catch (err) {
			throwIfAborted(signal);
			return {
				ok: false,
				message: `failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		} finally {
			try {
				fs.rmSync(probePath, { force: true });
			} catch {
				// ignore cleanup errors; the sandbox may have blocked creation
			}
		}
	}

	async function runSandboxProbe(
		ctx: ExtensionContext,
		execution: SandboxExecution | undefined = activeSandboxState()?.execution,
		runtime: SandboxRuntimeAdapter | undefined = sandboxRuntime,
		options: { includeCwdWrite?: boolean; signal?: AbortSignal } = {},
	): Promise<SandboxProbeResult> {
		throwIfAborted(options.signal);
		if (sandboxState.kind !== "active" || !runtime || !execution) {
			return {
				ok: false,
				message: `Bash sandbox probe skipped: sandbox is not active (${sandboxStatusText()})`,
				level: "warning",
			};
		}

		try {
			fs.mkdirSync(execution.tmpDir, { recursive: true });
		} catch (err) {
			return {
				ok: false,
				message: `Bash sandbox probe failed: cannot prepare TMPDIR ${execution.tmpDir}: ${err instanceof Error ? err.message : String(err)}`,
				level: "error",
				tmpDirOk: false,
			};
		}

		const tmpDirProbe = await runSandboxWriteProbe(runtime, execution, execution.tmpDir, ctx, options.signal);
		if (!tmpDirProbe.ok) {
			return {
				ok: false,
				message: `Bash sandbox probe failed: TMPDIR write check ${tmpDirProbe.message}`,
				level: "error",
				tmpDirOk: false,
			};
		}

		if (!options.includeCwdWrite) {
			return {
				ok: true,
				message: `Bash sandbox probe passed: TMPDIR writes are allowed in ${execution.tmpDir}`,
				level: "info",
				tmpDirOk: true,
			};
		}

		const policyAllowsCwdWrites = execution.policyMode !== "plan";
		const cwdWriteExpected = policyAllowsCwdWrites && isSandboxWriteAllowedForPath(execution.config, ctx.cwd);
		if (!cwdWriteExpected) {
			const reason = policyAllowsCwdWrites ? "sandbox config does not allow writes" : "active policy does not allow writes";
			return {
				ok: true,
				message: `Bash sandbox probe passed: TMPDIR writes are allowed in ${execution.tmpDir}; workspace write check skipped because ${reason} in ${ctx.cwd}`,
				level: "info",
				tmpDirOk: true,
				cwdWriteExpected,
			};
		}

		const cwdProbe = await runSandboxWriteProbe(runtime, execution, ctx.cwd, ctx, options.signal);
		return {
			ok: cwdProbe.ok,
			message: cwdProbe.ok
				? `Bash sandbox probe passed: TMPDIR writes are allowed in ${execution.tmpDir}; workspace writes are allowed in ${ctx.cwd}`
				: `Bash sandbox probe failed: TMPDIR write check passed, but workspace write check ${cwdProbe.message}`,
			level: cwdProbe.ok ? "info" : "error",
			tmpDirOk: true,
			cwdWriteExpected,
			cwdWriteOk: cwdProbe.ok,
		};
	}

	async function probeSandbox(ctx: ExtensionContext, options: { includeCwdWrite?: boolean } = {}) {
		const result = await runSandboxProbe(ctx, undefined, undefined, options);
		ctx.ui.notify(result.message, result.level);
	}

	async function repairSandboxRuntime(ctx: ExtensionContext, options: { reloadConfig?: boolean; signal?: AbortSignal } = {}): Promise<SandboxProbeResult> {
		throwIfAborted(options.signal);
		if (options.reloadConfig) reload(ctx);
		await resetSandboxRuntime(ctx, "while repairing");
		throwIfAborted(options.signal);
		await initializeSandbox(ctx);
		return runSandboxProbe(ctx, undefined, undefined, { signal: options.signal });
	}

	async function repairSandbox(ctx: ExtensionContext) {
		const result = await repairSandboxRuntime(ctx, { reloadConfig: true });
		if (result.ok) {
			ctx.ui.notify(`Bash sandbox repair completed. ${result.message}`, "info");
			return;
		}
		ctx.ui.notify(`Bash sandbox repair did not restore a healthy sandbox. ${result.message}`, result.level);
	}

	ensureSandboxHealthyAfterIdle = async (ctx: ExtensionContext, execution: SandboxExecution, runtime: SandboxRuntimeAdapter, signal?: AbortSignal) => {
		throwIfAborted(signal);
		if (sandboxState.kind !== "active") return;
		const now = Date.now();
		const idleMs = sandboxHealthMonitor.idleMs(now);
		if (!sandboxHealthMonitor.shouldProbe(now)) return;

		const probe = await runSandboxProbe(ctx, execution, runtime, { signal });
		if (probe.ok) return;

		ctx.ui.notify(`Bash sandbox health probe failed after ${Math.round(idleMs / 1000)}s idle; repairing sandbox runtime. ${probe.message}`, "warning");
		const repair = await repairSandboxRuntime(ctx, { signal });
		if (repair.ok) {
			ctx.ui.notify(`Bash sandbox automatic repair completed. ${repair.message}`, "info");
			return;
		}

		throw new Error(`Bash sandbox automatic repair failed. ${repair.message}`);
	};

	pi.on("session_start", async (_event, ctx) => {
		sandboxLifecycleGeneration++;
		sessionAllows.clear();
		sessionPathApprovals.length = 0;
		sessionBashApprovals.length = 0;
		sandboxDisabledForSession = false;
		sandboxHealthMonitor.reset();
		sandboxTmpDir = undefined;
		sandboxTmpDirEphemeral = false;
		reload(ctx);
		treeSitterReady = await isTreeSitterAvailable();
		if (ctx.hasUI) {
			if (treeSitterReady) ctx.ui.notify("Shell parser active: tree-sitter", "info");
			else ctx.ui.notify("Shell parser unavailable: falling back to simple whole-command bash approvals", "warning");
		}
		await initializeSandbox(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		sandboxLifecycleGeneration++;
		sandboxHealthMonitor.reset();
		reload(ctx);
		treeSitterReady = await isTreeSitterAvailable();
		await initializeSandbox(ctx);
	});

	pi.on("session_shutdown", async () => {
		sandboxLifecycleGeneration++;
		const shouldResetSandbox = sandboxState.kind === "active" && sandboxRuntime !== undefined;
		sandboxState = { kind: "inactive", reason: "inactive", fallbackMode: "normal" };
		clearSandboxEnv();
		if (shouldResetSandbox) {
			await resetSandboxRuntime();
		}
		if (sandboxTmpDirEphemeral && sandboxTmpDir) {
			try {
				fs.rmSync(sandboxTmpDir, { recursive: true, force: true });
			} catch {
				// ignore cleanup errors
			}
		}
		sandboxTmpDir = undefined;
		sandboxTmpDirEphemeral = false;
		sandboxDisabledForSession = false;
		sandboxHealthMonitor.reset();
	});

	pi.on("before_agent_start", (event, ctx) => {
		const active = activeSandboxState();
		if (!active) return;

		const hint = formatSandboxPromptHint(active.execution.config, {
			reason: active.reason,
			tmpDir: active.execution.tmpDir,
			cwd: ctx.cwd,
		});

		return {
			systemPrompt: `${event.systemPrompt}\n\n${hint}`,
		};
	});

	// ── Ask helper ────────────────────────────────────────────────────────────

	const allowOnceOption = "Allow once";
	const blockOption = "Block";
	const blockAndSteerOption = "Block and steer agent";

	async function promptForBlockReason(ctx: ExtensionContext): Promise<string | undefined> {
		const message = await ctx.ui.input(
			"Reject permission request",
			"Optional: tell the agent what to do instead",
		);
		return message?.trim() || undefined;
	}

	async function resolveApprovalChoice(
		choice: string | undefined,
		allowChoices: readonly string[],
		ctx: ExtensionContext,
		reason = "Blocked by user",
	): Promise<PermissionDecision> {
		if (choice === blockAndSteerOption) {
			const steeringReason = await promptForBlockReason(ctx);
			return blockPermission(steeringReason ?? reason);
		}
		if (choice !== undefined && allowChoices.includes(choice)) return ALLOW_PERMISSION;
		return blockPermission(reason);
	}

	async function askPermission(
		toolName: PermissionToolName,
		input: PermissionToolInput,
		note: string | undefined,
		projectRoot: string,
		ctx: ExtensionContext,
		bashFocusCommand?: string,
		parsedFocusCommand?: ParsedCommand,
	): Promise<PermissionDecision> {
		if (!ctx.hasUI) {
			return blockPermission(
				`Requires confirmation for ${toolName} but no UI is available (profile: ${agentName})`,
			);
		}

		const target = getMatchTarget(toolName, input);

		const lines = [`Tool:    ${toolName}`];
		const detailLines: string[] = [];
		if (target) detailLines.push(`Details: ${target}`);
		if (note) detailLines.push(`Note:    ${note}`);
		if (detailLines.length > 0) lines.push(formatPermissionPreview(detailLines.join("\n")));
		lines.push(`Profile: ${agentName}`);

		if (toolName === "bash") {
			const command = getCommandInput(input) ?? "";
			const approvalTarget = bashFocusCommand?.trim() ? bashFocusCommand.trim() : command;
			// Use tree-sitter arity-based prefix when available, fall back to simple first-word
			const uniquePrefixCandidates = parsedFocusCommand
				? dedupeStrings([parsedFocusCommand.prefixTokens.join(" ")].filter(Boolean))
				: dedupeStrings([approvalTarget.trim().split(/\s+/)[0]].filter((value): value is string => Boolean(value)));
			const segmentNote = approvalTarget !== command ? `Unapproved shell segment: ${approvalTarget}` : undefined;
			const displayNote = note && note !== segmentNote ? note : undefined;

			const bashLines = [
				"Full command:",
				formatPermissionPreview(command, { preserveEnd: true }),
			];
			if (approvalTarget !== command) {
				bashLines.push("Approval target:", formatPermissionPreview(approvalTarget, { preserveEnd: true }));
			}
			if (displayNote) bashLines.push("Note:", formatPermissionPreview(displayNote));
			bashLines.push(`Profile: ${agentName}`);

			const prefixSessionToValue = new Map<string, string>();
			const prefixPermanentToValue = new Map<string, string>();
			for (const [index, candidate] of uniquePrefixCandidates.entries()) {
				const candidateNumber = index + 1;
				bashLines.push(
					`Prefix candidate ${candidateNumber}:`,
					formatPermissionPreview(`${candidate} *`, { maxLines: 4, maxChars: 240, preserveEnd: true }),
				);
				prefixSessionToValue.set(`Allow prefix ${candidateNumber} for this session`, candidate);
				prefixPermanentToValue.set(`Save prefix ${candidateNumber} permanently`, candidate);
			}
			const prefixOptionToValue = new Map([...prefixSessionToValue, ...prefixPermanentToValue]);
			const allowExactLabel = approvalTarget === command
				? "Allow exact Full command for this session"
				: "Allow exact Approval target for this session";
			const saveExactLabel = approvalTarget === command
				? "Save exact Full command permanently"
				: "Save exact Approval target permanently";
			const allowChoices = [
				allowOnceOption,
				allowExactLabel,
				saveExactLabel,
				...prefixSessionToValue.keys(),
				...prefixPermanentToValue.keys(),
			];
			const options = [...allowChoices, blockAndSteerOption, blockOption];
			const choice = await ctx.ui.select(`⚠️  Permission required\n\n${bashLines.join("\n")}`, options);

			const decision = await resolveApprovalChoice(choice, allowChoices, ctx);
			if (decision.action === "block") return decision;

			if (choice === allowExactLabel) {
				sessionBashApprovals.push({
					tool: "bash",
					scopeType: "bash-exact",
					scopeValue: approvalTarget,
					projectRoot: approvalsSettings.scopeByProject ? projectRoot : undefined,
					agentName: approvalsSettings.scopeByAgent ? agentName : undefined,
					createdAt: Date.now(),
				});
				ctx.ui.notify(`✓ Bash session rule added: bash-exact:${approvalTarget}`, "info");
			}

			if (choice === saveExactLabel) {
				const previousApprovals = persistentApprovals;
				persistentApprovals = dedupeApprovals([
					...persistentApprovals,
					{
						tool: "bash",
						scopeType: "bash-exact",
						scopeValue: approvalTarget,
						projectRoot: approvalsSettings.scopeByProject ? projectRoot : undefined,
						agentName: approvalsSettings.scopeByAgent ? agentName : undefined,
						createdAt: Date.now(),
					},
				]);
				if (saveApprovals(ctx)) {
					ctx.ui.notify(`✓ Bash command saved permanently: bash-exact:${approvalTarget}`, "info");
				} else {
					persistentApprovals = previousApprovals;
				}
			}

			const selectedPrefix = typeof choice === "string" ? prefixOptionToValue.get(choice) : undefined;
			if (selectedPrefix) {
				const isPermanent = prefixPermanentToValue.has(choice as string);
				if (isPermanent) {
					const previousApprovals = persistentApprovals;
					persistentApprovals = dedupeApprovals([
						...persistentApprovals,
						{
							tool: "bash",
							scopeType: "bash-prefix",
							scopeValue: selectedPrefix,
							projectRoot: approvalsSettings.scopeByProject ? projectRoot : undefined,
							agentName: approvalsSettings.scopeByAgent ? agentName : undefined,
							createdAt: Date.now(),
						},
					]);
					if (saveApprovals(ctx)) {
						ctx.ui.notify(`✓ Bash prefix saved permanently: bash-prefix:${selectedPrefix} (matches: ${selectedPrefix} *)`, "info");
					} else {
						persistentApprovals = previousApprovals;
					}
				} else {
					sessionBashApprovals.push({
						tool: "bash",
						scopeType: "bash-prefix",
						scopeValue: selectedPrefix,
						projectRoot: approvalsSettings.scopeByProject ? projectRoot : undefined,
						agentName: approvalsSettings.scopeByAgent ? agentName : undefined,
						createdAt: Date.now(),
					});
					ctx.ui.notify(`✓ Bash session rule added: bash-prefix:${selectedPrefix} (matches: ${selectedPrefix} *)`, "info");
				}
			}

			return decision;
		}

		const approvalTargets = isFilesystemToolName(toolName)
			? (() => {
				const rawPath = getPathInput(input);
				return rawPath ? getFilesystemApprovalTargets(rawPath, ctx.cwd) : undefined;
			})()
			: undefined;
		const allowTargetSessionLabel = approvalTargets
			? `Allow ${approvalTargets.targetKind} for this session (${approvalTargets.targetPath})`
			: undefined;
		const allowTargetPermanentLabel = approvalTargets
			? `Allow ${approvalTargets.targetKind} permanently (${approvalTargets.targetPath})`
			: undefined;
		const allowParentFolderSessionLabel = approvalTargets?.parentFolderPath
			? `Allow parent folder for this session (${approvalTargets.parentFolderPath})`
			: undefined;
		const allowParentFolderPermanentLabel = approvalTargets?.parentFolderPath
			? `Allow parent folder permanently (${approvalTargets.parentFolderPath})`
			: undefined;
		const allowGitRepoSessionLabel = approvalTargets?.gitRepoPath
			? `Allow git repo for this session (${approvalTargets.gitRepoPath})`
			: undefined;
		const allowGitRepoPermanentLabel = approvalTargets?.gitRepoPath
			? `Allow git repo permanently (${approvalTargets.gitRepoPath})`
			: undefined;

		const allowChoices = [
			allowOnceOption,
			"Allow tool for this session",
			"Allow tool permanently",
			...(allowTargetSessionLabel ? [allowTargetSessionLabel] : []),
			...(allowTargetPermanentLabel ? [allowTargetPermanentLabel] : []),
			...(allowParentFolderSessionLabel ? [allowParentFolderSessionLabel] : []),
			...(allowParentFolderPermanentLabel ? [allowParentFolderPermanentLabel] : []),
			...(allowGitRepoSessionLabel ? [allowGitRepoSessionLabel] : []),
			...(allowGitRepoPermanentLabel ? [allowGitRepoPermanentLabel] : []),
		];
		const options = [...allowChoices, blockAndSteerOption, blockOption];

		const choice = await ctx.ui.select(`⚠️  Permission required\n\n${lines.join("\n")}`, options);

		const decision = await resolveApprovalChoice(choice, allowChoices, ctx);
		if (decision.action === "block") return decision;

		if (choice === "Allow tool for this session") {
			sessionAllows.add(toolName);
			ctx.ui.notify(`✓ ${toolName} allowed for the rest of this session`, "info");
		}

		if (choice === "Allow tool permanently") {
			const previousApprovals = persistentApprovals;
			persistentApprovals = dedupeApprovals([
				...persistentApprovals,
				{
					tool: toolName,
					scopeType: "tool",
					scopeValue: toolName,
					projectRoot: approvalsSettings.scopeByProject ? projectRoot : undefined,
					agentName: approvalsSettings.scopeByAgent ? agentName : undefined,
					createdAt: Date.now(),
				},
			]);
			if (saveApprovals(ctx)) {
				ctx.ui.notify(`✓ ${toolName} allowed permanently`, "info");
			} else {
				persistentApprovals = previousApprovals;
			}
		}

		if (approvalTargets && choice === allowTargetSessionLabel) {
			addSessionPathApprovals(toolName, [approvalTargets.targetPath], projectRoot);
			ctx.ui.notify(`✓ ${approvalTargets.targetKind === "folder" ? "Folder" : "File"} approved for this session: ${approvalTargets.targetPath}`, "info");
		}

		if (approvalTargets && choice === allowTargetPermanentLabel) {
			if (savePathApprovals(toolName, [approvalTargets.targetPath], projectRoot, ctx))
				ctx.ui.notify(`✓ ${approvalTargets.targetKind === "folder" ? "Folder" : "File"} approved permanently: ${approvalTargets.targetPath}`, "info");
		}

		if (approvalTargets?.parentFolderPath && choice === allowParentFolderSessionLabel) {
			addSessionPathApprovals(toolName, [approvalTargets.parentFolderPath], projectRoot);
			ctx.ui.notify(`✓ Parent folder approved for this session: ${approvalTargets.parentFolderPath}`, "info");
		}

		if (approvalTargets?.parentFolderPath && choice === allowParentFolderPermanentLabel) {
			if (savePathApprovals(toolName, [approvalTargets.parentFolderPath], projectRoot, ctx))
				ctx.ui.notify(`✓ Parent folder approved permanently: ${approvalTargets.parentFolderPath}`, "info");
		}

		if (approvalTargets?.gitRepoPath && choice === allowGitRepoSessionLabel) {
			addSessionPathApprovals(toolName, [approvalTargets.gitRepoPath], projectRoot);
			ctx.ui.notify(`✓ Git repo approved for this session: ${approvalTargets.gitRepoPath}`, "info");
		}

		if (approvalTargets?.gitRepoPath && choice === allowGitRepoPermanentLabel) {
			if (savePathApprovals(toolName, [approvalTargets.gitRepoPath], projectRoot, ctx))
				ctx.ui.notify(`✓ Git repo approved permanently: ${approvalTargets.gitRepoPath}`, "info");
		}

		return decision;
	}

	// ── External path gate ────────────────────────────────────────────────────

	async function applyExternalPathPolicy(
		policy: "ask" | "block",
		toolName: PermissionToolName,
		input: PermissionToolInput,
		externalPaths: string[],
		projectRoot: string,
		ctx: ExtensionContext,
	): Promise<PermissionDecision> {
		if (policy === "block") {
			const preview = externalPaths[0] ?? getMatchTarget(toolName, input);
			const reason = `Path is outside the current project${preview ? `: ${preview}` : ""}`;
			if (ctx.hasUI) ctx.ui.notify(`🚫 ${reason}`, "warning");
			return blockPermission(reason);
		}

		if (!ctx.hasUI) {
			return blockPermission(
				`Path is outside the current project and no UI is available (profile: ${agentName})`,
			);
		}

		const shown = externalPaths.slice(0, 3);
		const more = externalPaths.length > shown.length ? `\n  ... +${externalPaths.length - shown.length} more` : "";
		const lines = [
			`Tool:    ${toolName}`,
			`Profile: ${agentName}`,
			"Paths:",
			...shown.map((p) => `  ${p}`),
		];
		if (more) lines.push(more.trimStart());

		const approvalTargets = externalPaths.length === 1 && externalPaths[0] !== undefined
			? getFilesystemApprovalTargets(externalPaths[0], ctx.cwd)
			: undefined;
		const allowPathSessionLabel = approvalTargets
			? `Allow ${approvalTargets.targetKind} for this session (${approvalTargets.targetPath})`
			: "Allow path for this session";
		const allowPathPermanentLabel = approvalTargets
			? `Allow ${approvalTargets.targetKind} permanently (${approvalTargets.targetPath})`
			: "Allow path permanently";
		const allowParentFolderSessionLabel = approvalTargets?.parentFolderPath
			? `Allow parent folder for this session (${approvalTargets.parentFolderPath})`
			: undefined;
		const allowParentFolderPermanentLabel = approvalTargets?.parentFolderPath
			? `Allow parent folder permanently (${approvalTargets.parentFolderPath})`
			: undefined;
		const allowGitRepoSessionLabel = approvalTargets?.gitRepoPath
			? `Allow git repo for this session (${approvalTargets.gitRepoPath})`
			: undefined;
		const allowGitRepoPermanentLabel = approvalTargets?.gitRepoPath
			? `Allow git repo permanently (${approvalTargets.gitRepoPath})`
			: undefined;

		const allowChoices = [
			allowOnceOption,
			allowPathSessionLabel,
			allowPathPermanentLabel,
			...(allowParentFolderSessionLabel ? [allowParentFolderSessionLabel] : []),
			...(allowParentFolderPermanentLabel ? [allowParentFolderPermanentLabel] : []),
			...(allowGitRepoSessionLabel ? [allowGitRepoSessionLabel] : []),
			...(allowGitRepoPermanentLabel ? [allowGitRepoPermanentLabel] : []),
		];
		const choice = await ctx.ui.select(
			`⚠️  External path permission required\n\n${lines.join("\n")}`,
			[...allowChoices, blockAndSteerOption, blockOption],
		);

		const decision = await resolveApprovalChoice(choice, allowChoices, ctx);
		if (decision.action === "block") return decision;

		if (choice === allowPathSessionLabel) {
			addSessionPathApprovals(toolName, approvalTargets ? [approvalTargets.targetPath] : externalPaths, projectRoot);
			ctx.ui.notify(
				approvalTargets
					? `✓ ${approvalTargets.targetKind === "folder" ? "Folder" : "File"} approved for this session: ${approvalTargets.targetPath}`
					: `✓ Approved ${externalPaths.length} external path(s) for this session`,
				"info",
			);
		}

		if (choice === allowPathPermanentLabel && savePathApprovals(
			toolName,
			approvalTargets ? [approvalTargets.targetPath] : externalPaths,
			projectRoot,
			ctx,
		)) {
			ctx.ui.notify(
				approvalTargets
					? `✓ ${approvalTargets.targetKind === "folder" ? "Folder" : "File"} approved permanently: ${approvalTargets.targetPath}`
					: `✓ Saved ${externalPaths.length} external path approval(s)`,
				"info",
			);
		}

		if (approvalTargets?.parentFolderPath && choice === allowParentFolderSessionLabel) {
			addSessionPathApprovals(toolName, [approvalTargets.parentFolderPath], projectRoot);
			ctx.ui.notify(`✓ Parent folder approved for this session: ${approvalTargets.parentFolderPath}`, "info");
		}

		if (approvalTargets?.parentFolderPath && choice === allowParentFolderPermanentLabel) {
			if (savePathApprovals(toolName, [approvalTargets.parentFolderPath], projectRoot, ctx))
				ctx.ui.notify(`✓ Parent folder approved permanently: ${approvalTargets.parentFolderPath}`, "info");
		}

		if (approvalTargets?.gitRepoPath && choice === allowGitRepoSessionLabel) {
			addSessionPathApprovals(toolName, [approvalTargets.gitRepoPath], projectRoot);
			ctx.ui.notify(`✓ Git repo approved for this session: ${approvalTargets.gitRepoPath}`, "info");
		}

		if (approvalTargets?.gitRepoPath && choice === allowGitRepoPermanentLabel) {
			if (savePathApprovals(toolName, [approvalTargets.gitRepoPath], projectRoot, ctx))
				ctx.ui.notify(`✓ Git repo approved permanently: ${approvalTargets.gitRepoPath}`, "info");
		}

		return decision;
	}

	async function checkBashPermission(
		command: string,
		input: PermissionToolInput,
		projectRoot: string,
		ctx: ExtensionContext,
	): Promise<PermissionDecision> {
		const policy = activePolicy(config, agentName, profileName);
		const bashApprovals = [...persistentApprovals, ...sessionBashApprovals];
		if (approvalsCoverBash(bashApprovals, command, projectRoot, agentName, approvalsSettings)) {
			return ALLOW_PERMISSION;
		}
		const isApprovedBashSegment = (candidate: string) =>
			approvalsCoverBash(bashApprovals, candidate, projectRoot, agentName, approvalsSettings);

		let parsedBash: ParsedBash | undefined;
		if (treeSitterReady) {
			try {
				parsedBash = await parseBashCommand(command);
			} catch {
				// tree-sitter failed; parsedBash stays undefined → simple fallback
			}
		}

		const fallbackMode = sandboxFallbackMode();
		if (fallbackMode === "block-all-bash") {
			return blockPermission(`Bash blocked: sandbox unavailable in ${policy.mode} mode`);
		}
		if (fallbackMode === "ask-all-bash") {
			return askPermission("bash", input, "Sandbox unavailable: confirmation required for all bash commands", projectRoot, ctx);
		}
		const dangerousReason = parsedBash ? undefined : detectDangerousBashPattern(command);
		if (dangerousReason) {
			return askPermission("bash", input, dangerousReason, projectRoot, ctx);
		}

		if (parsedBash && canAutoApproveParsedBash(parsedBash, policy.rules, isApprovedBashSegment)) {
			return ALLOW_PERMISSION;
		}

		const getUnapprovedBashSegment = (): { segment?: string; parsed?: ParsedCommand } => {
			if (parsedBash) {
				const unapproved = getFirstUnapprovedParsedCommand(parsedBash, policy.rules, isApprovedBashSegment);
				if (unapproved) return { segment: unapproved.source, parsed: unapproved };
				return {};
			}
			return { segment: command };
		};

		const rule = policy.rules.length > 0 ? matchRule(policy.rules, "bash", input) : undefined;
		if (!rule) return ALLOW_PERMISSION;

		if (rule.action === "block") {
			const reason = rule.reason ?? `Blocked by permissions policy (profile: ${agentName})`;
			if (ctx.hasUI) ctx.ui.notify(`🚫 bash: ${reason}`, "warning");
			return blockPermission(reason);
		}

		if (rule.action === "ask") {
			if (parsedBash && canAutoApproveParsedBash(parsedBash, policy.rules, isApprovedBashSegment)) {
				return ALLOW_PERMISSION;
			}
			const { segment: unapprovedSegment, parsed: unapprovedParsed } = getUnapprovedBashSegment();
			const note = rule.reason ?? (unapprovedSegment ? `Unapproved shell segment: ${unapprovedSegment}` : undefined);
			return askPermission("bash", input, note, projectRoot, ctx, unapprovedSegment, unapprovedParsed);
		}

		if (rule.action === "allow" && parsedBash) {
			if (parsedBash.isComplex || !isAllParsedCommandsAllowed(parsedBash, policy.rules, isApprovedBashSegment)) {
				const { segment: unapprovedSegment, parsed: unapprovedParsed } = getUnapprovedBashSegment();
				const note = unapprovedSegment
					? `Unapproved shell segment: ${unapprovedSegment}`
					: parsedBash.isComplex ? "Complex shell command requires confirmation" : undefined;
				if (note) {
					return askPermission("bash", input, note, projectRoot, ctx, unapprovedSegment, unapprovedParsed);
				}
			}
		}

		return ALLOW_PERMISSION;
	}

	function blockedUserBashResult(reason: string): UserBashEventResult {
		return {
			result: {
				output: `Blocked by permissions: ${reason}\n`,
				exitCode: 1,
				cancelled: false,
				truncated: false,
			},
		};
	}

	async function getUserBashOperations(ctx: ExtensionContext): Promise<BashOperations | undefined> {
		let active = activeSandboxState();
		if (!active || active.execution.cwd !== ctx.cwd) {
			await initializeSandbox(ctx);
			active = activeSandboxState();
		}
		if (!active || !sandboxRuntime) return undefined;

		return {
			exec: async (command, cwd, options) => {
				const healthRuntime = sandboxRuntime;
				const healthExecution = active?.execution;
				if (!healthRuntime || !healthExecution) {
					throw new Error("Bash sandbox changed or became unavailable before command execution; blocked local fallback");
				}
				const bypassMatch = await sandboxBypassMatch(command, healthExecution);
				if (bypassMatch) {
					notifySandboxBypass(ctx, bypassMatch);
					return createLocalBashOperations().exec(command, cwd, options);
				}
				const lifecycleGeneration = sandboxLifecycleGeneration;
				return runSandboxedCommandAfterHealthCheck({
					healthMonitor: sandboxHealthMonitor,
					ensureHealthy: (signal) => ensureSandboxHealthyAfterIdle(ctx, healthExecution, healthRuntime, signal),
					signal: options.signal,
					execute: () => {
						const currentActive = activeSandboxState();
						const currentRuntime = sandboxRuntime;
						if (
							!currentActive
							|| !currentRuntime
							|| sandboxLifecycleGeneration !== lifecycleGeneration
						) {
							throw new Error("Bash sandbox changed or became unavailable before command execution; blocked local fallback");
						}
						return currentRuntime.createBashOperations(currentActive.execution).exec(command, cwd, options);
					},
				});
			},
		};
	}

	async function checkToolPermission(
		toolName: PermissionToolName,
		input: PermissionToolInput,
		projectRoot: string,
		ctx: ExtensionContext,
	): Promise<PermissionDecision> {
		const policy = activePolicy(config, agentName, profileName);

		let bashApprovals: ApprovalRecord[] = [];
		let isApprovedBashSegment: ((candidate: string) => boolean) | undefined;
		let parsedBash: ParsedBash | undefined;

		if (toolName === "bash") {
			return checkBashPermission(getCommandInput(input) ?? "", input, projectRoot, ctx);
		} else if (sessionAllows.has(toolName)) {
			return ALLOW_PERMISSION;
		} else if (approvalsCoverTool(persistentApprovals, toolName, projectRoot, agentName, approvalsSettings)) {
			return ALLOW_PERMISSION;
		}

		const getUnapprovedBashSegment = (): { segment?: string; parsed?: ParsedCommand } => {
			if (toolName !== "bash") return {};
			if (parsedBash) {
				const unapproved = getFirstUnapprovedParsedCommand(parsedBash, policy.rules, isApprovedBashSegment);
				if (unapproved) return { segment: unapproved.source, parsed: unapproved };
				return {};
			}
			// No tree-sitter: can't decompose, return the whole command as the segment
			const command = getCommandInput(input) ?? "";
			return { segment: command };
		};

		const rule = policy.rules.length > 0 ? matchRule(policy.rules, toolName, input) : undefined;

		if (rule) {
			if (rule.action === "block") {
				const reason = rule.reason ?? `Blocked by permissions policy (profile: ${agentName})`;
				if (ctx.hasUI) ctx.ui.notify(`🚫 ${toolName}: ${reason}`, "warning");
				return blockPermission(reason);
			}

			if (rule.action === "ask") {
				if (toolName === "bash") {
					// If tree-sitter confirms all simple commands are allowed, skip.
					if (parsedBash && canAutoApproveParsedBash(parsedBash, policy.rules, isApprovedBashSegment)) {
						return ALLOW_PERMISSION;
					}
					const { segment: unapprovedSegment, parsed: unapprovedParsed } = getUnapprovedBashSegment();
					const note = rule.reason ?? (unapprovedSegment ? `Unapproved shell segment: ${unapprovedSegment}` : undefined);
					return askPermission(toolName, input, note, projectRoot, ctx, unapprovedSegment, unapprovedParsed);
				}
				// For filesystem tools, check if an existing folder/path approval already covers this path
				if (isFilesystemToolName(toolName)) {
					const rawPath = getPathInput(input);
					if (rawPath) {
						const canonPath = canonicalizePathToken(rawPath, ctx.cwd);
						const effectiveApprovals = [...persistentApprovals, ...sessionPathApprovals];
						if (approvalsCoverPaths(effectiveApprovals, toolName, [canonPath], projectRoot, agentName, approvalsSettings)) {
							return ALLOW_PERMISSION;
						}
					}
				}
				return askPermission(toolName, input, rule.reason, projectRoot, ctx);
			}

			// action === "allow": still check external path unless opted out
			if (rule.action === "allow") {
				if (toolName === "bash") {
					if (parsedBash) {
						// Ask if complex or any command isn't allowed
						if (parsedBash.isComplex || !isAllParsedCommandsAllowed(parsedBash, policy.rules, isApprovedBashSegment)) {
							const { segment: unapprovedSegment, parsed: unapprovedParsed } = getUnapprovedBashSegment();
							const note = unapprovedSegment
								? `Unapproved shell segment: ${unapprovedSegment}`
								: parsedBash.isComplex ? "Complex shell command requires confirmation" : undefined;
							if (note) return askPermission(toolName, input, note, projectRoot, ctx, unapprovedSegment, unapprovedParsed);
						}
					}
					// No tree-sitter: rule already matched "allow", let it through
				}

				const epa = rule.externalPathAction ?? "inherit";
				if (epa === "allow") return ALLOW_PERMISSION; // explicit bypass

				const externalPolicy = epa === "inherit" ? policy.externalPath : epa;
				const externalPaths = externalPolicy === "allow" ? [] : getExternalPaths(toolName, input, ctx.cwd);
				if (externalPolicy !== "allow" && externalPaths.length > 0) {
					const effectiveApprovals = [...persistentApprovals, ...sessionPathApprovals];
					if (!approvalsCoverPaths(effectiveApprovals, toolName, externalPaths, projectRoot, agentName, approvalsSettings)) {
						return applyExternalPathPolicy(externalPolicy, toolName, input, externalPaths, projectRoot, ctx);
					}
				}
				return ALLOW_PERMISSION;
			}
		}

		// No rule matched: check external path policy
		if (policy.externalPath !== "allow") {
			const externalPaths = getExternalPaths(toolName, input, ctx.cwd);
			if (externalPaths.length > 0) {
				const effectiveApprovals = [...persistentApprovals, ...sessionPathApprovals];
				if (!approvalsCoverPaths(effectiveApprovals, toolName, externalPaths, projectRoot, agentName, approvalsSettings)) {
					return applyExternalPathPolicy(policy.externalPath, toolName, input, externalPaths, projectRoot, ctx);
				}
			}
		}

		return ALLOW_PERMISSION;
	}

	// ── Main gate ─────────────────────────────────────────────────────────────

	pi.on("user_bash", async (event, ctx) => {
		applyMcpEnvironment(ctx.cwd, ctx.sessionManager?.getSessionId?.());
		agentName = detectAgentName(pi);
		profileName = detectProfileName(pi);
		const input: PermissionToolInput = { command: event.command };
		const projectRoot = canonicalizePath(ctx.cwd);
		const decision = await checkBashPermission(event.command, input, projectRoot, ctx);
		if (decision.action === "block") return blockedUserBashResult(decision.reason);
		const operations = await getUserBashOperations(ctx);
		return operations ? { operations } : undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		agentName = detectAgentName(pi);
		profileName = detectProfileName(pi);
		const input = asPermissionToolInput(event.input);
		const toolName = asPermissionToolName(event.toolName);
		const projectRoot = canonicalizePath(ctx.cwd);
		const decision = await checkToolPermission(toolName, input, projectRoot, ctx);
		return toToolCallResult(decision);
	});

	// ── /permissions command ──────────────────────────────────────────────────

	pi.registerCommand("permissions", {
		description: "Show permission summary and subcommands (/permissions help)",
		getArgumentCompletions: (prefix) =>
			PERMISSIONS_COMPLETIONS.filter((s) => s.value.startsWith(prefix.trim())),
		handler: async (args, ctx) => {
			agentName = detectAgentName(pi);
			profileName = detectProfileName(pi);
			const normalizedArgs = (args || "").trim().toLowerCase().replace(/\s+/g, " ");
			const [subcommand = "", ...subcommandRest] = normalizedArgs ? normalizedArgs.split(" ") : [""];
			const subcommandArgs = subcommandRest.join(" ");

			if (subcommand === "help") {
				ctx.ui.notify("Usage: /permissions [verbose|approvals|reset [session|saved|project|agent|all]|mode|sandbox [status|probe [workspace]|repair|enable|disable]]", "info");
				return;
			}

			if (subcommand === "approvals" || subcommand === "approval") {
				await showPermissionApprovals(ctx);
				return;
			}

			if (subcommand === "reset") {
				resetPermissions(subcommandArgs, ctx);
				return;
			}

			if (subcommand === "mode") {
				showPermissionsMode(ctx);
				return;
			}

			if (normalizedArgs === "sandbox disable" || normalizedArgs === "sandbox off") {
				await disableSandboxForSession(ctx);
				ctx.ui.notify(`Bash sandbox disabled for this session; bash exec mode: ${sandboxBashExecutionMode()}`, "warning");
				return;
			}

			if (normalizedArgs === "sandbox enable" || normalizedArgs === "sandbox on") {
				await enableSandboxForSession(ctx);
				const sandboxActive = sandboxState.kind === "active";
				ctx.ui.notify(`Bash sandbox: ${sandboxStatusText()}; bash exec mode: ${sandboxBashExecutionMode()}`, sandboxActive ? "info" : "warning");
				return;
			}

			if (subcommand === "sandbox" && subcommandRest[0] === "probe") {
				const probeScope = subcommandRest[1] ?? "";
				if (probeScope === "") {
					await probeSandbox(ctx);
					return;
				}
				if (["workspace", "cwd", "write", "all"].includes(probeScope)) {
					await probeSandbox(ctx, { includeCwdWrite: true });
					return;
				}
				ctx.ui.notify("Usage: /permissions sandbox probe [workspace]", "warning");
				return;
			}

			if (normalizedArgs === "sandbox repair") {
				await repairSandbox(ctx);
				return;
			}

			if (normalizedArgs === "sandbox" || normalizedArgs === "sandbox status") {
				ctx.ui.notify(`Bash sandbox: ${sandboxStatusText()}; bash exec mode: ${sandboxBashExecutionMode()}`, "info");
				return;
			}

			const policy = activePolicy(config, agentName, profileName);
			const rules = policy.rules;
			const externalPath = policy.externalPath;
			const mode = policy.mode;
			const protectedResources = policy.protectedResources;
			const profileLabel = profileName ? `${agentName} / ${profileName}` : agentName === "default" ? "default" : agentName;
			const agentOverride = agentName !== "default" ? config.agents?.[agentName] : undefined;
			const hasAgentOverride = agentOverride !== undefined;
			const isFullOverride = agentOverride?.inherit === false;
			const sandboxActive = sandboxState.kind === "active";
			const sandboxStatus = sandboxStatusText();
			const bashExecutionMode = sandboxBashExecutionMode();
			const sandboxConfig = sandboxPromptConfig();
			const shellParserStatus = treeSitterReady ? "tree-sitter (active)" : "simple fallback";
			const verbose = /^(verbose|full|debug|all)$/i.test((args || "").trim());
			const sessionApprovalCount = sessionPathApprovals.length + sessionBashApprovals.length;
			const actionCounts = {
				allow: rules.filter((r) => r.action === "allow").length,
				ask: rules.filter((r) => r.action === "ask").length,
				block: rules.filter((r) => r.action === "block").length,
			};
			const toolCounts = new Map<string, number>();
			for (const rule of rules) toolCounts.set(rule.tool, (toolCounts.get(rule.tool) ?? 0) + 1);
			const topTools = [...toolCounts.entries()]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.slice(0, 6)
				.map(([tool, count]) => `${tool}:${count}`)
				.join(", ");
			const sampleRules = rules.slice(0, 5).map((r) => `[${r.action}] ${r.tool}${r.match ? ` ${formatRuleMatch(r)}` : ""}`);

			if (!ctx.hasUI) {
				ctx.ui.notify(
					verbose
						? `Permissions (${profileLabel}): mode=${mode}, rules=${rules.length} (allow=${actionCounts.allow} ask=${actionCounts.ask} block=${actionCounts.block}), externalPath=${externalPath}, sandbox=${sandboxStatus}, bashMode=${bashExecutionMode}, shellParser=${shellParserStatus}, protected=read:${protectedResources.denyRead.length}/write:${protectedResources.denyWrite.length}, approvals=${sessionApprovalCount} session/${persistentApprovals.length} saved, sampleRules=${sampleRules.join("; ") || "none"}`
						: `Permissions (${profileLabel}): mode=${mode}, externalPath=${externalPath}, sandbox=${sandboxStatus}, bashMode=${bashExecutionMode}, shellParser=${shellParserStatus}, rules=${rules.length} (allow=${actionCounts.allow} ask=${actionCounts.ask} block=${actionCounts.block}), approvals=${sessionApprovalCount} session/${persistentApprovals.length} saved`,
					"info",
				);
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				const lines: string[] = [];
				const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));

				lines.push("");
				lines.push(
					`  ${theme.fg("accent", "Permissions")}  ${theme.fg("muted", "profile: ")}${theme.fg("toolTitle", profileLabel)}` +
					(hasAgentOverride ? theme.fg("dim", isFullOverride ? " (override)" : " (+ defaults)") : ""),
				);

				if (!verbose) {
					const epColor = externalPath === "block" ? "error" : externalPath === "ask" ? "warning" : "dim";
					lines.push("");
					lines.push(`  ${theme.fg("muted", "Mode:         ")}${theme.fg("accent", mode)}`);
					lines.push(`  ${theme.fg("muted", "External path:")}${theme.fg(epColor, ` ${externalPath}`)}${theme.fg("dim", " (structured tools)")}`);
					lines.push(`  ${theme.fg("muted", "Bash sandbox: ")}${theme.fg(sandboxActive ? "success" : "dim", sandboxStatus)}`);
					lines.push(`  ${theme.fg("muted", "Bash exec:    ")}${theme.fg(sandboxActive ? "success" : "warning", bashExecutionMode)}`);
					lines.push(`  ${theme.fg("muted", "Shell parser: ")}${theme.fg(treeSitterReady ? "success" : "warning", shellParserStatus)}${!treeSitterReady ? theme.fg("dim", ": whole-command approvals only") : ""}`);
					lines.push(`  ${theme.fg("muted", "Approvals:    ")}${theme.fg("warning", `${sessionApprovalCount} session`)}${theme.fg("dim", ", ")}${theme.fg("accent", `${persistentApprovals.length} saved`)}`);
					if (sessionAllows.size > 0) {
						lines.push(`  ${theme.fg("muted", "Session tools:")}${theme.fg("dim", ` ${[...sessionAllows].join(", ")}`)}`);
					}
					lines.push("");
					lines.push(`  ${theme.fg("muted", "Rules:        ")}${theme.fg("text", `${rules.length} total`)} ${theme.fg("success", `allow=${actionCounts.allow}`)} ${theme.fg("warning", `ask=${actionCounts.ask}`)} ${theme.fg("error", `block=${actionCounts.block}`)}`);
					if (topTools) lines.push(`  ${theme.fg("muted", "Top tools:    ")}${theme.fg("dim", topTools)}`);
					const firstSampleRule = sampleRules[0];
					if (firstSampleRule !== undefined) {
						lines.push(`  ${theme.fg("muted", "Examples:     ")}${theme.fg("dim", firstSampleRule)}`);
						for (const sample of sampleRules.slice(1)) {
							lines.push(`  ${theme.fg("dim", "              ")}${theme.fg("dim", sample)}`);
						}
					}
					lines.push("");
					lines.push(`  ${theme.fg("muted", "Protected:    ")}${theme.fg("warning", `read=${protectedResources.denyRead.length} write=${protectedResources.denyWrite.length}`)}`);
					lines.push(`  ${theme.fg("muted", "More:         ")}${theme.fg("dim", "/permissions verbose  •  /permissions approvals  •  /permissions reset  •  /permissions sandbox probe|repair|enable|disable")}`);
					lines.push("");
					lines.push(`  ${theme.fg("dim", "Press Escape to close")}`);
					lines.push("");
				} else {
					// Verbose view (previous detailed output)
					if (sessionAllows.size > 0) {
						lines.push("");
						lines.push(`  ${theme.fg("warning", "Session tool allows:")} ${theme.fg("dim", [...sessionAllows].join(", "))}`);
					}
					if (sessionBashApprovals.length > 0) {
						lines.push("");
						lines.push(`  ${theme.fg("warning", "Session bash approvals:")} ${theme.fg("dim", `${sessionBashApprovals.length}`)}`);
					}

					if (sessionPathApprovals.length > 0 || persistentApprovals.length > 0) {
						lines.push("");
						lines.push(
							`  ${theme.fg("muted", "Path approvals:   ")}` +
							`${theme.fg("warning", `${sessionPathApprovals.length} session`)}` +
							`${theme.fg("dim", ", ")}` +
							`${theme.fg("accent", `${persistentApprovals.length} saved`)}`,
						);
						for (const approval of persistentApprovals.slice(0, 5)) {
							const scope = formatApprovalScope(approval);
							const scopeSuffix = [
								approval.projectRoot ? `project=${approval.projectRoot}` : undefined,
								approval.agentName ? `agent=${approval.agentName}` : undefined,
							].filter(Boolean).join(" ");
							lines.push(
								`  ${theme.fg("dim", "  ↳ ")}${theme.fg("muted", approval.tool)} ${theme.fg("dim", scope)}${scopeSuffix ? " " + theme.fg("muted", `[${scopeSuffix}]`) : ""}`,
							);
						}
						if (persistentApprovals.length > 5) {
							lines.push(`  ${theme.fg("dim", `  ... ${persistentApprovals.length - 5} more saved approvals`)}`);
						}
					}

					lines.push("");
					lines.push(`  ${theme.fg("muted", "Mode:           ")}${theme.fg("accent", mode)}`);
					const epColor = externalPath === "block" ? "error" : externalPath === "ask" ? "warning" : "dim";
					lines.push(`  ${theme.fg("muted", "External path:  ")}${theme.fg(epColor, externalPath)}${theme.fg("dim", " (structured tools)")}`);
					lines.push(`  ${theme.fg("muted", "Bash sandbox:   ")}${theme.fg(sandboxActive ? "success" : "dim", sandboxStatus)}`);
					lines.push(`  ${theme.fg("muted", "Bash exec mode: ")}${theme.fg(sandboxActive ? "success" : "warning", bashExecutionMode)}`);
					lines.push(`  ${theme.fg("muted", "Shell parser:   ")}${theme.fg(treeSitterReady ? "success" : "warning", shellParserStatus)}${!treeSitterReady ? theme.fg("dim", ": whole-command approvals only") : ""}`);
					lines.push(`  ${theme.fg("muted", "Sandbox TMPDIR: ")}${theme.fg("dim", sandboxTmpDir ?? getEffectiveSandboxTmpDir(ctx.cwd, config.sandbox))}${theme.fg("dim", sandboxTmpDirEphemeral ? " (session)" : " (shared)")}`);
					lines.push(`  ${theme.fg("muted", "Protected read: ")}${theme.fg("warning", `${protectedResources.denyRead.length}`)}`);
					for (const pattern of protectedResources.denyRead.slice(0, 4)) lines.push(`  ${theme.fg("dim", "  ↳ ")}${theme.fg("dim", pattern)}`);
					if (protectedResources.denyRead.length > 4) lines.push(`  ${theme.fg("dim", `  ... ${protectedResources.denyRead.length - 4} more`)}`);
					lines.push(`  ${theme.fg("muted", "Protected write:")}${theme.fg("warning", ` ${protectedResources.denyWrite.length}`)}`);
					for (const pattern of protectedResources.denyWrite.slice(0, 4)) lines.push(`  ${theme.fg("dim", "  ↳ ")}${theme.fg("dim", pattern)}`);
					if (protectedResources.denyWrite.length > 4) lines.push(`  ${theme.fg("dim", `  ... ${protectedResources.denyWrite.length - 4} more`)}`);
					const pr = config.protectedResources ?? {};
					const builtinsState = (pr.enabled ?? true) ? ((pr.defaults ?? true) ? "on" : "off") : "disabled";
					lines.push(`  ${theme.fg("muted", "Protected built-ins:")}${theme.fg("accent", ` ${builtinsState}`)}`);
					lines.push(`  ${theme.fg("muted", "Overrides:      ")}${theme.fg("dim", `+read=${(pr.addDenyRead ?? []).length} +write=${(pr.addDenyWrite ?? []).length} -read=${(pr.unprotectRead ?? []).length} -write=${(pr.unprotectWrite ?? []).length}`)}`);
					if (sandboxConfig?.filesystem) {
						const fsCfg = sandboxConfig.filesystem;
						lines.push(`  ${theme.fg("muted", "  denyRead:     ")}${theme.fg("dim", (fsCfg.denyRead ?? []).join(", ") || "(none)")}`);
						if ((fsCfg.allowRead ?? []).length > 0) lines.push(`  ${theme.fg("muted", "  allowRead:    ")}${theme.fg("dim", fsCfg.allowRead!.join(", "))}`);
						lines.push(`  ${theme.fg("muted", "  allowWrite:   ")}${theme.fg("dim", (fsCfg.allowWrite ?? []).join(", ") || "(none)")}`);
						lines.push(`  ${theme.fg("muted", "  denyWrite:    ")}${theme.fg("dim", (fsCfg.denyWrite ?? []).join(", ") || "(none)")}`);
					}
					if (sandboxConfig?.network) {
						const netCfg = sandboxConfig.network;
						const unrestricted = netCfg.allowedDomains === undefined && netCfg.deniedDomains === undefined;
						const allowLabel = unrestricted ? "* (unrestricted)" : (netCfg.allowedDomains ?? []).join(", ") || "(none)";
						const denyLabel = unrestricted ? "(none)" : (netCfg.deniedDomains ?? []).join(", ") || "(none)";
						lines.push(`  ${theme.fg("muted", "  network:      ")}${theme.fg("dim", `allow=${allowLabel} deny=${denyLabel}`)}`);
						if ((netCfg.allowUnixSockets ?? []).length > 0 || netCfg.allowAllUnixSockets) {
							lines.push(`  ${theme.fg("muted", "  unix sockets: ")}${theme.fg("dim", netCfg.allowAllUnixSockets ? "all" : (netCfg.allowUnixSockets ?? []).join(", "))}`);
						}
					}

					lines.push("");
					if (rules.length === 0) {
						lines.push(`  ${theme.fg("dim", "No rules configured.")}`);
					} else {
						const actionColor = (a: Rule["action"]) => a === "allow" ? "success" : a === "block" ? "error" : "warning";
						const actionIcon  = (a: Rule["action"]) => a === "allow" ? "✓" : a === "block" ? "✗" : "?";
						const truncate = (s: string, max: number) => max <= 1 ? s.slice(0, Math.max(0, max)) : (s.length > max ? `${s.slice(0, max - 1)}…` : s);
						const wrap = (s: string, max: number) => {
							if (max <= 1 || s.length <= max) return [s];
							const parts: string[] = [];
							for (let i = 0; i < s.length; i += max) parts.push(s.slice(i, i + max));
							return parts;
						};
						const toolW  = Math.min(18, Math.max(4, ...rules.map((r) => r.tool.length)));
						const matchW = Math.min(48, Math.max(5, ...rules.map((r) => formatRuleMatch(r).length)));
						const actionW = 10;
						const extW = 10;
						const sandboxW = 10;
						const reasonW = 40;

						lines.push(
							`  ${theme.fg("dim", pad("TOOL", toolW + 2))}` +
							`${theme.fg("dim", pad("MATCH", matchW + 2))}` +
							`${theme.fg("dim", pad("ACTION", actionW))}` +
							`${theme.fg("dim", pad("EXT PATH", extW + 2))}` +
							`${theme.fg("dim", pad("SANDBOX", sandboxW + 2))}` +
							`${theme.fg("dim", "REASON")}`,
						);
						lines.push(`  ${theme.fg("borderMuted", "─".repeat(toolW + matchW + actionW + extW + sandboxW + reasonW + 12))}`);

						for (const rule of rules) {
							const toolRaw = truncate(rule.tool, toolW);
							const matchSource = formatRuleMatch(rule);
							const matchParts = wrap(matchSource, matchW);
							const actionRaw = truncate(`${actionIcon(rule.action)} ${rule.action}`, actionW - 1);
							const epa = rule.externalPathAction ?? "inherit";
							const sandboxRaw = rule.tool === "bash"
								? rule.sandbox === false ? "off" : rule.sandbox === true ? "on" : "inherit"
								: "-";
							const reasonRaw = truncate(rule.reason ?? "-", reasonW);
							const tool = theme.fg("text", pad(toolRaw, toolW + 2));
							const action = theme.fg(actionColor(rule.action), pad(actionRaw, actionW));
							const epaColor = epa === "allow" ? "success" : epa === "block" ? "error" : epa === "ask" ? "warning" : "dim";
							const sandboxColor = sandboxRaw === "off" ? "warning" : sandboxRaw === "on" ? "success" : "dim";
							const epaStr = theme.fg(epaColor, pad(truncate(epa, extW), extW + 2));
							const sandboxStr = theme.fg(sandboxColor, pad(truncate(sandboxRaw, sandboxW), sandboxW + 2));
							const reason = theme.fg("dim", reasonRaw);
							lines.push(`  ${tool}${theme.fg("muted", pad(matchParts[0] ?? "", matchW + 2))}${action}${epaStr}${sandboxStr}${reason}`);
							for (const continuation of matchParts.slice(1)) {
								const emptyTool = pad("", toolW + 2);
								const emptyAction = pad("", actionW);
								const emptyExt = pad("", extW + 2);
								const emptySandbox = pad("", sandboxW + 2);
								lines.push(`  ${theme.fg("dim", emptyTool)}${theme.fg("dim", pad(`↳ ${continuation}`, matchW + 2))}${theme.fg("dim", emptyAction)}${theme.fg("dim", emptyExt)}${theme.fg("dim", emptySandbox)}`);
							}
						}
						lines.push(`  ${theme.fg("dim", "(Long MATCH values wrap to continuation lines)")}`);
					}

					lines.push("");
					lines.push(`  ${theme.fg("dim", "Use /permissions for the compact summary")}`);
					lines.push(`  ${theme.fg("dim", "Press Escape to close")}`);
					lines.push("");
				}

				const text = new Text(lines.join("\n"), 0, 0);
				return {
					render: (w: number) => text.render(w),
					invalidate: () => text.invalidate(),
					handleInput: (data: string) => { if (matchesKey(data, Key.escape)) done(); },
				};
			});
		},
	});

	async function showPermissionApprovals(ctx: ExtensionContext) {
		agentName = detectAgentName(pi);
		const projectRoot = canonicalizePath(ctx.cwd);
		const scopedSaved = persistentApprovals.filter((a) => {
			if (approvalsSettings.scopeByProject && a.projectRoot !== projectRoot) return false;
			if (approvalsSettings.scopeByAgent && a.agentName !== agentName) return false;
			return true;
		});
		const scopedSession = [...sessionPathApprovals, ...sessionBashApprovals].filter((a) => {
			if (approvalsSettings.scopeByProject && a.projectRoot !== projectRoot) return false;
			if (approvalsSettings.scopeByAgent && a.agentName !== agentName) return false;
			return true;
		});
		const format = (a: ApprovalRecord) => `${a.tool}:${formatApprovalScope(a)}`;

		if (!ctx.hasUI) {
			ctx.ui.notify(
				`Approvals (project=${projectRoot}, agent=${agentName}): session=${scopedSession.length}, saved=${scopedSaved.length}`,
				"info",
			);
			return;
		}

		await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
			const lines: string[] = [];
			lines.push("");
			lines.push(`  ${theme.fg("accent", "Permission Approvals")}`);
			lines.push(`  ${theme.fg("muted", "Project:")} ${theme.fg("dim", projectRoot)}`);
			lines.push(`  ${theme.fg("muted", "Agent:  ")} ${theme.fg("dim", agentName)}`);
			lines.push("");
			lines.push(`  ${theme.fg("warning", `Session approvals (${scopedSession.length})`)}`);
			for (const approval of scopedSession.slice(0, 10)) lines.push(`  ${theme.fg("dim", "  ↳ ")}${theme.fg("dim", format(approval))}`);
			if (scopedSession.length > 10) lines.push(`  ${theme.fg("dim", `  ... ${scopedSession.length - 10} more`)}`);
			lines.push("");
			lines.push(`  ${theme.fg("accent", `Saved approvals (${scopedSaved.length})`)}`);
			for (const approval of scopedSaved.slice(0, 10)) lines.push(`  ${theme.fg("dim", "  ↳ ")}${theme.fg("dim", format(approval))}`);
			if (scopedSaved.length > 10) lines.push(`  ${theme.fg("dim", `  ... ${scopedSaved.length - 10} more`)}`);
			lines.push("");
			lines.push(`  ${theme.fg("dim", "Press Escape to close")}`);
			lines.push("");

			const text = new Text(lines.join("\n"), 0, 0);
			return {
				render: (w: number) => text.render(w),
				invalidate: () => text.invalidate(),
				handleInput: (data: string) => { if (matchesKey(data, Key.escape)) done(); },
			};
		});
	}

	function resetPermissions(args: string | undefined, ctx: ExtensionContext) {
		agentName = detectAgentName(pi);
		const trimmed = (args || "").trim().toLowerCase();
		const projectRoot = canonicalizePath(ctx.cwd);
		const resetSession = trimmed === "" || trimmed === "session" || trimmed === "all";
		const resetSaved = trimmed === "saved" || trimmed === "all";
		const resetProject = trimmed === "project";
		const resetAgent = trimmed === "agent";

		if (!resetSession && !resetSaved && !resetProject && !resetAgent) {
			ctx.ui.notify("Usage: /permissions reset [session|saved|project|agent|all]", "warning");
			return;
		}

		if (resetSession) {
			sessionAllows.clear();
			sessionPathApprovals.length = 0;
			sessionBashApprovals.length = 0;
		}

		const previousApprovals = persistentApprovals;
		if (resetSaved) persistentApprovals = [];

		if (resetProject) {
			sessionPathApprovals.splice(0, sessionPathApprovals.length, ...sessionPathApprovals.filter((a) => a.projectRoot !== projectRoot));
			sessionBashApprovals.splice(0, sessionBashApprovals.length, ...sessionBashApprovals.filter((a) => a.projectRoot !== projectRoot));
			persistentApprovals = persistentApprovals.filter((a) => a.projectRoot !== projectRoot);
		}

		if (resetAgent) {
			sessionPathApprovals.splice(0, sessionPathApprovals.length, ...sessionPathApprovals.filter((a) => a.agentName !== agentName));
			sessionBashApprovals.splice(0, sessionBashApprovals.length, ...sessionBashApprovals.filter((a) => a.agentName !== agentName));
			persistentApprovals = persistentApprovals.filter((a) => a.agentName !== agentName);
		}

		const resetPersistent = resetSaved || resetProject || resetAgent;
		const saved = !resetPersistent || saveApprovals(ctx);
		if (!saved) persistentApprovals = previousApprovals;

		const parts: string[] = [];
		if (resetSession) parts.push("session approvals cleared");
		if (saved && resetSaved) parts.push("saved approvals cleared");
		if (resetProject) parts.push(`project session approvals cleared (${projectRoot})`);
		if (saved && resetProject) parts.push(`project saved approvals cleared (${projectRoot})`);
		if (resetAgent) parts.push(`agent session approvals cleared (${agentName})`);
		if (saved && resetAgent) parts.push(`agent saved approvals cleared (${agentName})`);
		if (parts.length > 0) ctx.ui.notify(`Permissions reset: ${parts.join(", ")}`, "info");
	}

	function showPermissionsMode(ctx: ExtensionContext) {
		agentName = detectAgentName(pi);
		profileName = detectProfileName(pi);
		const policy = activePolicy(config, agentName, profileName);
		ctx.ui.notify(`Active permission mode: ${policy.mode}`, "info");
	}
}

