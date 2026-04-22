/**
 * Permissions Extension
 *
 * A configurable, rule-based permission system for controlling tool access.
 * Supports default rules, per-agent profile overrides, and an external-path
 * policy that restricts file operations to the current project directory.
 *
 * Config file locations (both are merged; project-local wins on conflict):
 *   ~/.pi/agent/permissions.jsonc     — global
 *   .pi/permissions.jsonc             — project-local
 *
 * Agent name resolution (first match wins):
 *   1. PI_AGENT_NAME environment variable
 *   2. --agent-name CLI flag
 *   3. Falls back to "default" profile
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
 *     //   "allow"  — no restriction (default)
 *     //   "ask"    — prompt when path is outside cwd
 *     //   "block"  — block when path is outside cwd
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
 *   tool               — tool name or "*" for any tool
 *   match              — optional matcher for command/path target:
 *                        - advanced: regex (if regex metacharacters are present)
 *                        - bash shorthand: "rg" (word boundary), "rg *" (prefix)
 *                        - non-bash shorthand: case-insensitive substring
 *   action             — "allow" | "block" | "ask"
 *   reason             — optional human-readable string for prompts/notifications
 *   externalPathAction — "inherit" (default) | "allow" | "ask" | "block"
 *                        Overrides the global externalPath policy for this rule.
 *                        Only meaningful for structured filesystem tools when
 *                        action is "allow". Bash ignores this for now.
 *
 * Rules are evaluated in order; the first matching rule wins.
 * If no rule matches, the externalPath policy is checked for structured
 * filesystem tools, then the call is allowed.
 *
 * Per-agent profiles:
 *   inherit      — true (default): agent rules are prepended to default rules
 *                  false: agent rules completely replace default rules
 *   externalPath — overrides the default externalPath policy for this agent
 *                  (structured filesystem tools only)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createBashTool, getAgentDir } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key, Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	activePolicy,
	loadConfig,
	mergeDefaultConfig,
	readJsonFile,
	resolveProtectedResources,
} from "./config";
import {
	approvalsCoverBash,
	approvalsCoverPaths,
	dedupeApprovals,
	formatApprovalScope,
	getApprovalsSettings,
	pruneExpiredApprovals,
} from "./approvals";
import {
	asPermissionToolInput,
	asPermissionToolName,
	canonicalizePath,
	getCommandInput,
	getExternalPaths,
	getMatchTarget,
	matchRule,
	isPathOutsideCwd,
} from "./matching";
import {
	detectDangerousBashPattern,
	hasComplexBashSyntax,
	isAllowedBashCompound,
	sandboxFallbackModeForPolicy,
} from "./shell-policy";
import {
	compileSandboxConfig,
	createSandboxedBashOps,
	getEffectiveSandboxTmpDir,
	getSandboxTmpDirMode,
} from "./sandbox";
import {
	dedupeStrings,
	type ApprovalFile,
	type ApprovalRecord,
	type PermissionToolInput,
	type PermissionToolName,
	type PermissionsConfig,
	type SandboxManagerLike,
	type SandboxRuntimeConfigLike,
} from "./shared";
export type { AgentProfile, ExternalPathPolicy, PermissionMode, PermissionsConfig, Rule } from "./shared";

// ─── Agent name detection ─────────────────────────────────────────────────────

function detectAgentName(pi: ExtensionAPI): string {
	if (process.env.PI_AGENT_NAME) return process.env.PI_AGENT_NAME;
	const flagValue = pi.getFlag("agent-name");
	if (typeof flagValue === "string" && flagValue.length > 0) return flagValue;
	return "default";
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
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
	let sandboxManager: SandboxManagerLike | undefined;
	let sandboxAvailable = false;
	let sandboxEnabled = false;
	let sandboxReason = "inactive";
	let sandboxMode: "normal" | "ask-all-bash" | "block-all-bash" = "normal";
	let sandboxConfig: SandboxRuntimeConfigLike | undefined;
	let sandboxTmpDir: string | undefined;
	let sandboxTmpDirEphemeral = false;

	pi.registerTool({
		...bashToolTemplate,
		label: "bash",
		async execute(id, params, signal, onUpdate, ctx) {
			const localBash = createBashTool(ctx.cwd);
			if (!sandboxEnabled || !sandboxAvailable || !sandboxManager) {
				return localBash.execute(id, params, signal, onUpdate, ctx);
			}
			const sandboxedBash = createBashTool(ctx.cwd, {
				operations: createSandboxedBashOps(sandboxManager),
			});
			return sandboxedBash.execute(id, params, signal, onUpdate, ctx);
		},
	});

	let config: PermissionsConfig = {};
	let agentName = "default";
	let approvalsSettings = getApprovalsSettings(config);
	let persistentApprovals: ApprovalRecord[] = [];

	const sessionAllows = new Set<string>();
	const sessionPathApprovals: ApprovalRecord[] = [];
	const sessionBashApprovals: ApprovalRecord[] = [];
	const approvalsFile = path.join(getAgentDir(), "permissions-approvals.json");

	const loadApprovals = () => {
		const parsed = readJsonFile(approvalsFile) as ApprovalFile | undefined;
		const loaded = parsed?.approvals ?? [];
		persistentApprovals = dedupeApprovals(pruneExpiredApprovals(loaded, approvalsSettings));
	};

	const saveApprovals = () => {
		const data: ApprovalFile = { approvals: dedupeApprovals(pruneExpiredApprovals(persistentApprovals, approvalsSettings)) };
		fs.writeFileSync(approvalsFile, JSON.stringify(data, null, 2) + "\n", "utf-8");
	};

	const reload = (cwd: string) => {
		config = loadConfig(cwd);
		agentName = detectAgentName(pi);
		approvalsSettings = getApprovalsSettings(config);
		loadApprovals();
	};

	async function initializeSandbox(ctx: ExtensionContext) {
		sandboxEnabled = false;
		sandboxMode = "normal";
		sandboxReason = "inactive";
		sandboxConfig = undefined;

		const policy = activePolicy(config, agentName);
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
		// Override sandbox-runtime's /tmp/claude fallback with a pi-branded temp dir.
		process.env.CLAUDE_TMPDIR = effectiveTmpDir;
		process.env.TMPDIR = effectiveTmpDir;
		const compiled = compileSandboxConfig(policy, ctx.cwd, config.sandbox, effectiveTmpDir);
		sandboxConfig = compiled.config;

		if ((pi.getFlag("no-sandbox") as boolean) === true) {
			sandboxReason = "disabled by --no-sandbox";
			sandboxMode = sandboxFallbackModeForPolicy(policy.mode);
			return;
		}

		if (!compiled.enabled) {
			sandboxReason = compiled.reason;
			return;
		}

		if (process.platform !== "darwin" && process.platform !== "linux") {
			sandboxReason = `unsupported platform: ${process.platform}`;
			sandboxMode = sandboxFallbackModeForPolicy(policy.mode);
			return;
		}

		try {
			const mod = await import("@anthropic-ai/sandbox-runtime");
			sandboxManager = mod.SandboxManager;
			sandboxAvailable = true;
		} catch {
			sandboxAvailable = false;
			sandboxReason = "backend not installed";
			sandboxMode = sandboxFallbackModeForPolicy(policy.mode);
			if (ctx.hasUI) {
				ctx.ui.notify("Bash sandbox unavailable: install dependencies in ~/.pi/agent/extensions/permissions/", "warning");
			}
			return;
		}

		try {
			await sandboxManager.initialize(compiled.config);
			sandboxEnabled = true;
			sandboxMode = "normal";
			sandboxReason = compiled.reason;
			if (ctx.hasUI) {
				ctx.ui.notify(`Bash sandbox active (${compiled.reason})`, "info");
			}
		} catch (err) {
			sandboxEnabled = false;
			sandboxMode = sandboxFallbackModeForPolicy(policy.mode);
			sandboxReason = `init failed: ${err instanceof Error ? err.message : String(err)}`;
			if (ctx.hasUI) {
				ctx.ui.notify(`Bash sandbox failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		sessionAllows.clear();
		sessionPathApprovals.length = 0;
		sessionBashApprovals.length = 0;
		sandboxTmpDir = undefined;
		sandboxTmpDirEphemeral = false;
		reload(ctx.cwd);
		await initializeSandbox(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reload(ctx.cwd);
		await initializeSandbox(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (sandboxEnabled && sandboxAvailable && sandboxManager) {
			try {
				await sandboxManager.reset();
			} catch {
				// ignore cleanup errors
			}
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
		sandboxEnabled = false;
		sandboxConfig = undefined;
	});

	// ── Ask helper ────────────────────────────────────────────────────────────

	async function askPermission(
		toolName: PermissionToolName,
		input: PermissionToolInput,
		note: string | undefined,
		projectRoot: string,
		ctx: ExtensionContext,
	): Promise<{ block: boolean; reason: string } | undefined> {
		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Requires confirmation for ${toolName} but no UI is available (profile: ${agentName})`,
			};
		}

		const target = getMatchTarget(toolName, input);
		const preview = target ? (target.length > 100 ? `${target.slice(0, 100)}…` : target) : undefined;

		const lines = [`Tool:    ${toolName}`];
		if (preview) lines.push(`Details: ${preview}`);
		if (note)    lines.push(`Note:    ${note}`);
		lines.push(`Profile: ${agentName}`);

		if (toolName === "bash") {
			const command = getCommandInput(input) ?? "";
			const tokens = command.trim().split(/\s+/).filter(Boolean);
			const prefixCandidates: string[] = [];
			if (tokens[0]) prefixCandidates.push(tokens[0]);
			if (tokens[0] && tokens[1] && !tokens[1].startsWith("-")) prefixCandidates.push(`${tokens[0]} ${tokens[1]}`);
			const uniquePrefixCandidates = dedupeStrings(prefixCandidates);

			const bashLines = [
				`Command: ${command.length > 120 ? `${command.slice(0, 120)}…` : command}`,
				`Profile: ${agentName}`,
			];
			if (note) bashLines.push(`Note: ${note}`);
			if (uniquePrefixCandidates.length > 0) {
				bashLines.push(`Prefix options: ${uniquePrefixCandidates.map((p) => `${p} *`).join(" | ")}`);
			}

			const prefixOptionToValue = new Map<string, string>();
			for (const candidate of uniquePrefixCandidates) {
				prefixOptionToValue.set(`Allow prefix for this session (${candidate} *)`, candidate);
			}
			const allowExactLabel = "Allow exact command for this session";
			const options = ["Allow once", allowExactLabel, ...prefixOptionToValue.keys(), "Block"];
			const choice = await ctx.ui.select(`⚠️  Permission required\n\n${bashLines.join("\n")}`, options);

			if (choice === "Block" || choice === undefined) {
				return { block: true, reason: "Blocked by user" };
			}

			if (choice === allowExactLabel) {
				sessionBashApprovals.push({
					tool: "bash",
					scopeType: "bash-exact",
					scopeValue: command,
					projectRoot: approvalsSettings.scopeByProject ? projectRoot : undefined,
					agentName: approvalsSettings.scopeByAgent ? agentName : undefined,
					createdAt: Date.now(),
				});
				ctx.ui.notify(`✓ Bash session rule added: bash-exact:${command}`, "info");
			}

			const selectedPrefix = typeof choice === "string" ? prefixOptionToValue.get(choice) : undefined;
			if (selectedPrefix) {
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

			return undefined;
		}

		const choice = await ctx.ui.select(`⚠️  Permission required\n\n${lines.join("\n")}`, [
			"Allow once",
			"Allow tool for this session",
			"Block",
		]);

		if (choice === "Block" || choice === undefined) {
			return { block: true, reason: "Blocked by user" };
		}

		if (choice === "Allow tool for this session") {
			sessionAllows.add(toolName);
			ctx.ui.notify(`✓ ${toolName} allowed for the rest of this session`, "info");
		}

		return undefined;
	}

	// ── External path gate ────────────────────────────────────────────────────

	async function applyExternalPathPolicy(
		policy: "ask" | "block",
		toolName: PermissionToolName,
		input: PermissionToolInput,
		externalPaths: string[],
		projectRoot: string,
		ctx: ExtensionContext,
	): Promise<{ block: boolean; reason: string } | undefined> {
		if (policy === "block") {
			const preview = externalPaths[0] ?? getMatchTarget(toolName, input);
			const reason = `Path is outside the current project${preview ? `: ${preview}` : ""}`;
			if (ctx.hasUI) ctx.ui.notify(`🚫 ${reason}`, "warning");
			return { block: true, reason };
		}

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Path is outside the current project and no UI is available (profile: ${agentName})`,
			};
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

		const choice = await ctx.ui.select(`⚠️  External path permission required\n\n${lines.join("\n")}`, [
			"Allow once",
			"Allow path for this session",
			"Allow path permanently",
			"Block",
		]);

		if (choice === "Block" || choice === undefined) {
			return { block: true, reason: "Blocked by user" };
		}

		if (choice === "Allow path for this session") {
			sessionPathApprovals.push(
				...externalPaths.map((p) => ({
					tool: toolName,
					scopeType: "path-prefix" as const,
					scopeValue: p,
					projectRoot: approvalsSettings.scopeByProject ? projectRoot : undefined,
					agentName: approvalsSettings.scopeByAgent ? agentName : undefined,
					createdAt: Date.now(),
				})),
			);
			ctx.ui.notify(`✓ Approved ${externalPaths.length} external path(s) for this session`, "info");
		}

		if (choice === "Allow path permanently") {
			persistentApprovals = dedupeApprovals([
				...persistentApprovals,
				...externalPaths.map((p) => ({
					tool: toolName,
					scopeType: "path-prefix" as const,
					scopeValue: p,
					projectRoot: approvalsSettings.scopeByProject ? projectRoot : undefined,
					agentName: approvalsSettings.scopeByAgent ? agentName : undefined,
					createdAt: Date.now(),
				})),
			]);
			saveApprovals();
			ctx.ui.notify(`✓ Saved ${externalPaths.length} external path approval(s)`, "info");
		}

		return undefined;
	}

	// ── Main gate ─────────────────────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		const input = asPermissionToolInput(event.input);
		const toolName = asPermissionToolName(event.toolName);
		const policy = activePolicy(config, agentName);
		const projectRoot = canonicalizePath(ctx.cwd);

		if (toolName === "bash") {
			const command = getCommandInput(input) ?? "";
			const effectiveApprovals = [...persistentApprovals, ...sessionBashApprovals];
			if (approvalsCoverBash(effectiveApprovals, command, projectRoot, agentName, approvalsSettings)) {
				return undefined;
			}
			if (sandboxMode === "block-all-bash") {
				return { block: true, reason: `Bash blocked: sandbox unavailable in ${policy.mode} mode` };
			}
			if (sandboxMode === "ask-all-bash") {
				return askPermission(toolName, input, "Sandbox unavailable: confirmation required for all bash commands", projectRoot, ctx);
			}
			const dangerousReason = detectDangerousBashPattern(command);
			if (dangerousReason) {
				return askPermission(toolName, input, dangerousReason, projectRoot, ctx);
			}
		} else if (sessionAllows.has(toolName)) {
			return undefined;
		}

		const rule = policy.rules.length > 0 ? matchRule(policy.rules, toolName, input) : undefined;

		if (rule) {
			if (rule.action === "block") {
				const reason = rule.reason ?? `Blocked by permissions policy (profile: ${agentName})`;
				if (ctx.hasUI) ctx.ui.notify(`🚫 ${toolName}: ${reason}`, "warning");
				return { block: true, reason };
			}

			if (rule.action === "ask") {
				return askPermission(toolName, input, rule.reason, projectRoot, ctx);
			}

			// action === "allow" — still check external path unless opted out
			if (rule.action === "allow") {
				if (toolName === "bash") {
					const command = getCommandInput(input) ?? "";
					if (!isAllowedBashCompound(command, policy.rules) && hasComplexBashSyntax(command)) {
						return askPermission(toolName, input, "Complex shell command requires confirmation", projectRoot, ctx);
					}
				}

				const epa = rule.externalPathAction ?? "inherit";
				if (epa === "allow") return undefined; // explicit bypass

				const externalPolicy = epa === "inherit" ? policy.externalPath : epa;
				const externalPaths = externalPolicy === "allow" ? [] : getExternalPaths(toolName, input, ctx.cwd);
				if (externalPolicy !== "allow" && externalPaths.length > 0) {
					const effectiveApprovals = [...persistentApprovals, ...sessionPathApprovals];
					if (!approvalsCoverPaths(effectiveApprovals, toolName, externalPaths, projectRoot, agentName, approvalsSettings)) {
						return applyExternalPathPolicy(externalPolicy, toolName, input, externalPaths, projectRoot, ctx);
					}
				}
				return undefined;
			}
		}

		// No rule matched — check external path policy
		if (policy.externalPath !== "allow") {
			const externalPaths = getExternalPaths(toolName, input, ctx.cwd);
			if (externalPaths.length > 0) {
				const effectiveApprovals = [...persistentApprovals, ...sessionPathApprovals];
				if (!approvalsCoverPaths(effectiveApprovals, toolName, externalPaths, projectRoot, agentName, approvalsSettings)) {
					return applyExternalPathPolicy(policy.externalPath, toolName, input, externalPaths, projectRoot, ctx);
				}
			}
		}

		return undefined;
	});

	// ── /permissions command ──────────────────────────────────────────────────

	pi.registerCommand("permissions", {
		description: "Show active permission rules for the current agent profile",
		handler: async (_args, ctx) => {
			const policy = activePolicy(config, agentName);
			const rules = policy.rules;
			const externalPath = policy.externalPath;
			const mode = policy.mode;
			const protectedResources = policy.protectedResources;
			const profileLabel = agentName === "default" ? "default" : agentName;
			const hasAgentOverride = agentName !== "default" && config.agents?.[agentName] !== undefined;
			const isFullOverride = hasAgentOverride && config.agents![agentName].inherit === false;
			const sandboxStatus = sandboxEnabled ? "active" : sandboxReason;
			const bashExecutionMode = sandboxEnabled ? "sandboxed" : sandboxMode === "normal" ? "local" : `local (${sandboxMode})`;

			if (!ctx.hasUI) {
				const summary = rules.map((r) => `[${r.action}] ${r.tool}${r.match ? ` /${r.match}/` : ""}`).join(", ");
				ctx.ui.notify(
					`Permissions (${profileLabel}): mode=${mode}, ${summary || "none"}, externalPath: ${externalPath}, protected: read=${protectedResources.denyRead.length}/write=${protectedResources.denyWrite.length}, sandbox: ${sandboxStatus}, bashMode: ${bashExecutionMode}, approvals: ${sessionPathApprovals.length + sessionBashApprovals.length} session/${persistentApprovals.length} saved`,
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

				// Mode + external path policy
				lines.push("");
				lines.push(`  ${theme.fg("muted", "Mode:           ")}${theme.fg("accent", mode)}`);
				const epColor = externalPath === "block" ? "error" : externalPath === "ask" ? "warning" : "dim";
				lines.push(`  ${theme.fg("muted", "External path:  ")}${theme.fg(epColor, externalPath)}${theme.fg("dim", " (structured tools)")}`);
				lines.push(`  ${theme.fg("muted", "Bash sandbox:   ")}${theme.fg(sandboxEnabled ? "success" : "dim", sandboxStatus)}`);
				lines.push(`  ${theme.fg("muted", "Bash exec mode: ")}${theme.fg(sandboxEnabled ? "success" : "warning", bashExecutionMode)}`);
				lines.push(`  ${theme.fg("muted", "Sandbox TMPDIR: ")}${theme.fg("dim", sandboxTmpDir ?? getEffectiveSandboxTmpDir(ctx.cwd, config.sandbox))}${theme.fg("dim", sandboxTmpDirEphemeral ? " (session)" : " (shared)")}`);
				lines.push(`  ${theme.fg("muted", "Protected read: ")}${theme.fg("warning", `${protectedResources.denyRead.length}`)}`);
				for (const pattern of protectedResources.denyRead.slice(0, 4)) {
					lines.push(`  ${theme.fg("dim", "  ↳ ")}${theme.fg("dim", pattern)}`);
				}
				if (protectedResources.denyRead.length > 4) {
					lines.push(`  ${theme.fg("dim", `  ... ${protectedResources.denyRead.length - 4} more`)}`);
				}
				lines.push(`  ${theme.fg("muted", "Protected write:")}${theme.fg("warning", ` ${protectedResources.denyWrite.length}`)}`);
				for (const pattern of protectedResources.denyWrite.slice(0, 4)) {
					lines.push(`  ${theme.fg("dim", "  ↳ ")}${theme.fg("dim", pattern)}`);
				}
				if (protectedResources.denyWrite.length > 4) {
					lines.push(`  ${theme.fg("dim", `  ... ${protectedResources.denyWrite.length - 4} more`)}`);
				}
				const pr = config.protectedResources ?? {};
				const builtinsState = (pr.enabled ?? true) ? ((pr.defaults ?? true) ? "on" : "off") : "disabled";
				lines.push(`  ${theme.fg("muted", "Protected built-ins:")}${theme.fg("accent", ` ${builtinsState}`)}`);
				lines.push(`  ${theme.fg("muted", "Overrides:      ")}${theme.fg("dim", `+read=${(pr.addDenyRead ?? []).length} +write=${(pr.addDenyWrite ?? []).length} -read=${(pr.unprotectRead ?? []).length} -write=${(pr.unprotectWrite ?? []).length}`)}`);
				if (sandboxConfig?.filesystem) {
					const fsCfg = sandboxConfig.filesystem;
					lines.push(`  ${theme.fg("muted", "  denyRead:     ")}${theme.fg("dim", (fsCfg.denyRead ?? []).join(", ") || "(none)")}`);
					if ((fsCfg.allowRead ?? []).length > 0) {
						lines.push(`  ${theme.fg("muted", "  allowRead:    ")}${theme.fg("dim", fsCfg.allowRead!.join(", "))}`);
					}
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
						lines.push(
							`  ${theme.fg("muted", "  unix sockets: ")}${theme.fg("dim", netCfg.allowAllUnixSockets ? "all" : (netCfg.allowUnixSockets ?? []).join(", "))}`,
						);
					}
				}

				// Rules table
				lines.push("");
				if (rules.length === 0) {
					lines.push(`  ${theme.fg("dim", "No rules configured.")}`);
				} else {
					const actionColor = (a: Rule["action"]) =>
						a === "allow" ? "success" : a === "block" ? "error" : "warning";
					const actionIcon  = (a: Rule["action"]) =>
						a === "allow" ? "✓" : a === "block" ? "✗" : "?";

					const truncate = (s: string, max: number) => {
						if (max <= 1) return s.slice(0, Math.max(0, max));
						return s.length > max ? `${s.slice(0, max - 1)}…` : s;
					};
					const wrap = (s: string, max: number) => {
						if (max <= 1 || s.length <= max) return [s];
						const parts: string[] = [];
						for (let i = 0; i < s.length; i += max) parts.push(s.slice(i, i + max));
						return parts;
					};
					const toolW  = Math.min(18, Math.max(4, ...rules.map((r) => r.tool.length)));
					const matchW = Math.min(48, Math.max(5, ...rules.map((r) => (r.match ? r.match.length + 2 : 1))));
					const actionW = 10;
					const extW = 10;
					const reasonW = 40;

					lines.push(
						`  ${theme.fg("dim", pad("TOOL", toolW + 2))}` +
						`${theme.fg("dim", pad("MATCH", matchW + 2))}` +
						`${theme.fg("dim", pad("ACTION", actionW))}` +
						`${theme.fg("dim", pad("EXT PATH", extW + 2))}` +
						`${theme.fg("dim", "REASON")}`,
					);
					lines.push(`  ${theme.fg("borderMuted", "─".repeat(toolW + matchW + actionW + extW + reasonW + 10))}`);

					for (const rule of rules) {
						const toolRaw = truncate(rule.tool, toolW);
						const matchSource = rule.match ? `/${rule.match}/` : "-";
						const matchParts = wrap(matchSource, matchW);
						const actionRaw = truncate(`${actionIcon(rule.action)} ${rule.action}`, actionW - 1);
						const epa = rule.externalPathAction ?? "inherit";
						const reasonRaw = truncate(rule.reason ?? "-", reasonW);

						const tool = theme.fg("text", pad(toolRaw, toolW + 2));
						const action = theme.fg(actionColor(rule.action), pad(actionRaw, actionW));
						const epaColor = epa === "allow" ? "success" : epa === "block" ? "error" : epa === "ask" ? "warning" : "dim";
						const epaStr = theme.fg(epaColor, pad(truncate(epa, extW), extW + 2));
						const reason = theme.fg("dim", reasonRaw);
						lines.push(`  ${tool}${theme.fg("muted", pad(matchParts[0], matchW + 2))}${action}${epaStr}${reason}`);

						for (const continuation of matchParts.slice(1)) {
							const emptyTool = pad("", toolW + 2);
							const emptyAction = pad("", actionW);
							const emptyExt = pad("", extW + 2);
							lines.push(
								`  ${theme.fg("dim", emptyTool)}${theme.fg("dim", pad(`↳ ${continuation}`, matchW + 2))}${theme.fg("dim", emptyAction)}${theme.fg("dim", emptyExt)}`,
							);
						}
					}
					lines.push(`  ${theme.fg("dim", "(Long MATCH values wrap to continuation lines)")}`);
				}

				lines.push("");
				lines.push(`  ${theme.fg("dim", "Press Escape to close")}`);
				lines.push("");

				const text = new Text(lines.join("\n"), 0, 0);
				return {
					render:      (w: number) => text.render(w),
					invalidate:  () => text.invalidate(),
					handleInput: (data: string) => { if (matchesKey(data, Key.escape)) done(); },
				};
			});
		},
	});

	pi.registerCommand("permissions-approvals", {
		description: "Show scoped session/saved permission approvals",
		handler: async (_args, ctx) => {
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
		},
	});

	pi.registerCommand("permissions-reset", {
		description: "Reset permission approvals (session|saved|project|agent|all)",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim().toLowerCase();
			const projectRoot = canonicalizePath(ctx.cwd);
			const resetSession = trimmed === "" || trimmed === "session" || trimmed === "all";
			const resetSaved = trimmed === "saved" || trimmed === "all";
			const resetProject = trimmed === "project";
			const resetAgent = trimmed === "agent";

			if (!resetSession && !resetSaved && !resetProject && !resetAgent) {
				ctx.ui.notify("Usage: /permissions-reset [session|saved|project|agent|all]", "warning");
				return;
			}

			if (resetSession) {
				sessionAllows.clear();
				sessionPathApprovals.length = 0;
				sessionBashApprovals.length = 0;
			}

			if (resetSaved) {
				persistentApprovals = [];
				saveApprovals();
			}

			if (resetProject) {
				sessionPathApprovals.splice(0, sessionPathApprovals.length, ...sessionPathApprovals.filter((a) => a.projectRoot !== projectRoot));
				sessionBashApprovals.splice(0, sessionBashApprovals.length, ...sessionBashApprovals.filter((a) => a.projectRoot !== projectRoot));
				persistentApprovals = persistentApprovals.filter((a) => a.projectRoot !== projectRoot);
				saveApprovals();
			}

			if (resetAgent) {
				sessionPathApprovals.splice(0, sessionPathApprovals.length, ...sessionPathApprovals.filter((a) => a.agentName !== agentName));
				sessionBashApprovals.splice(0, sessionBashApprovals.length, ...sessionBashApprovals.filter((a) => a.agentName !== agentName));
				persistentApprovals = persistentApprovals.filter((a) => a.agentName !== agentName);
				saveApprovals();
			}

			const parts: string[] = [];
			if (resetSession) parts.push("session approvals cleared");
			if (resetSaved) parts.push("saved approvals cleared");
			if (resetProject) parts.push(`project approvals cleared (${projectRoot})`);
			if (resetAgent) parts.push(`agent approvals cleared (${agentName})`);
			ctx.ui.notify(`Permissions reset: ${parts.join(", ")}`, "info");
		},
	});

	pi.registerCommand("permissions-mode", {
		description: "Show the active permission mode",
		handler: async (_args, ctx) => {
			const policy = activePolicy(config, agentName);
			ctx.ui.notify(`Active permission mode: ${policy.mode}`, "info");
		},
	});
}

