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
 * To wire up with the subagent extension, set PI_AGENT_NAME in the spawn env:
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
 *   match              — optional regex; for bash matches the command string,
 *                        for other tools matches the path argument
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

import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, BashOperations } from "@mariozechner/pi-coding-agent";
import { createBashTool, getAgentDir } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key, Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PermissionMode = "plan" | "workspace-write" | "full-access";
export type ExternalPathPolicy = "allow" | "ask" | "block";

export interface Rule {
	/** Tool name to match, or "*" for any tool. */
	tool: string;
	/**
	 * Optional regex pattern. For "bash" matched against the command string.
	 * For "write", "edit", "read", "grep", "find", "ls" matched against the path.
	 * Omit to match all invocations of the tool.
	 */
	match?: string;
	/** What to do when this rule matches. */
	action: "allow" | "block" | "ask";
	/** Human-readable reason shown in prompts and block notifications. */
	reason?: string;
	/**
	 * Overrides the global externalPath policy for this specific rule.
	 * Only meaningful when action is "allow".
	 *   "inherit" (default) — defer to the global externalPath setting
	 *   "allow"             — skip the external-path check (e.g. build tools)
	 *   "ask"               — ask even if the global policy is "allow"
	 *   "block"             — block even if the global policy is "allow"
	 */
	externalPathAction?: "inherit" | "allow" | "ask" | "block";
}

export interface AgentProfile {
	/**
	 * If true (default), these rules are prepended to the default rules.
	 * If false, these rules completely replace the default rules.
	 */
	inherit?: boolean;
	/** Optional named mode preset for this agent profile. */
	mode?: PermissionMode;
	rules?: Rule[];
	/** Overrides the default externalPath policy for this agent. */
	externalPath?: ExternalPathPolicy;
}

export interface PermissionsConfig {
	default?: {
		/** Optional named mode preset. Defaults to "workspace-write". */
		mode?: PermissionMode;
		rules?: Rule[];
		/**
		 * What to do when a structured filesystem tool targets a path outside the
		 * current working directory. Rules with externalPathAction: "allow"
		 * bypass this. If omitted, the selected mode supplies the default.
		 */
		externalPath?: ExternalPathPolicy;
	};
	agents?: Record<string, AgentProfile>;
	sandbox?: SandboxSettings;
	approvals?: ApprovalsSettings;
	protectedResources?: ProtectedResourcesSettings;
}

interface EffectivePolicy {
	mode: PermissionMode;
	rules: Rule[];
	externalPath: ExternalPathPolicy;
	protectedResources: ResolvedProtectedResources;
}

interface ProtectedResourcesSettings {
	enabled?: boolean;
	defaults?: boolean;
	addDenyRead?: string[];
	addDenyWrite?: string[];
	unprotectRead?: string[];
	unprotectWrite?: string[];
}

interface ResolvedProtectedResources {
	denyRead: string[];
	denyWrite: string[];
}

interface ApprovalsSettings {
	scopeByProject?: boolean;
	scopeByAgent?: boolean;
	maxAgeDays?: number;
}

interface ApprovalRecord {
	tool: string;
	scopeType: "path-prefix" | "tool" | "bash-exact" | "bash-prefix";
	scopeValue: string;
	projectRoot?: string;
	agentName?: string;
	createdAt: number;
}

interface ApprovalFile {
	approvals: ApprovalRecord[];
}

interface SandboxSettings {
	enabled?: boolean;
	network?: boolean;
	allowSshAuthSock?: boolean;
	allowUnixSockets?: string[];
	allowAllUnixSockets?: boolean;
	allowWrite?: string[];
	denyRead?: string[];
	denyWrite?: string[];
}

interface SandboxRuntimeConfigLike {
	network?: {
		allowedDomains?: string[];
		deniedDomains?: string[];
		allowUnixSockets?: string[];
		allowAllUnixSockets?: boolean;
	};
	filesystem?: {
		denyRead?: string[];
		allowRead?: string[];
		allowWrite?: string[];
		denyWrite?: string[];
	};
}

// ─── Tools that operate on filesystem paths ───────────────────────────────────

const FILESYSTEM_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

// ─── Config loading ───────────────────────────────────────────────────────────

function parseJsonc(text: string): unknown {
	let noComments = "";
	let inString = false;
	let stringQuote = "";
	let escaping = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];

		if (inString) {
			noComments += ch;
			if (escaping) {
				escaping = false;
			} else if (ch === "\\") {
				escaping = true;
			} else if (ch === stringQuote) {
				inString = false;
				stringQuote = "";
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			inString = true;
			stringQuote = ch;
			noComments += ch;
			continue;
		}

		if (ch === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			if (i < text.length) noComments += "\n";
			continue;
		}

		if (ch === "/" && next === "*") {
			i += 2;
			while (i < text.length - 1 && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i++;
			continue;
		}

		noComments += ch;
	}

	let cleaned = "";
	inString = false;
	stringQuote = "";
	escaping = false;

	for (let i = 0; i < noComments.length; i++) {
		const ch = noComments[i];

		if (inString) {
			cleaned += ch;
			if (escaping) {
				escaping = false;
			} else if (ch === "\\") {
				escaping = true;
			} else if (ch === stringQuote) {
				inString = false;
				stringQuote = "";
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			inString = true;
			stringQuote = ch;
			cleaned += ch;
			continue;
		}

		if (ch === ",") {
			let j = i + 1;
			while (j < noComments.length && /\s/.test(noComments[j])) j++;
			if (j < noComments.length && (noComments[j] === "}" || noComments[j] === "]")) {
				continue;
			}
		}

		cleaned += ch;
	}

	return JSON.parse(cleaned);
}

/** Reads a .json or .jsonc file with support for comments and trailing commas. */
function readJsonFile(filePath: string): unknown | undefined {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return parseJsonc(raw);
	} catch {
		return undefined;
	}
}

function mergeDefaultConfig(
	globalDefault: PermissionsConfig["default"] | undefined,
	projectDefault: PermissionsConfig["default"] | undefined,
): PermissionsConfig["default"] | undefined {
	if (!globalDefault && !projectDefault) return undefined;
	return {
		mode: projectDefault?.mode ?? globalDefault?.mode,
		externalPath: projectDefault?.externalPath ?? globalDefault?.externalPath,
		rules: [...(projectDefault?.rules ?? []), ...(globalDefault?.rules ?? [])],
	};
}

function loadConfig(cwd: string): PermissionsConfig {
	const globalPath = path.join(getAgentDir(), "permissions.jsonc");
	const projectPath = path.join(cwd, ".pi", "permissions.jsonc");

	const global = readJsonFile(globalPath) as PermissionsConfig | undefined;
	const project = readJsonFile(projectPath) as PermissionsConfig | undefined;

	return {
		default: mergeDefaultConfig(global?.default, project?.default),
		agents: {
			...(global?.agents ?? {}),
			...(project?.agents ?? {}),
		},
		sandbox: {
			...(global?.sandbox ?? {}),
			...(project?.sandbox ?? {}),
		},
		approvals: {
			...(global?.approvals ?? {}),
			...(project?.approvals ?? {}),
		},
		protectedResources: {
			...(global?.protectedResources ?? {}),
			...(project?.protectedResources ?? {}),
		},
	};
}

// ─── Rule evaluation ──────────────────────────────────────────────────────────

/** Returns the string to match patterns against for a given tool call. */
function getMatchTarget(toolName: string, input: Record<string, unknown>): string | undefined {
	switch (toolName) {
		case "bash":
			return input.command as string | undefined;
		case "write":
		case "edit":
		case "read":
		case "grep":
		case "find":
		case "ls":
			return input.path as string | undefined;
		default:
			return undefined;
	}
}

/** Returns the first rule that matches, or undefined if none match. */
function matchRule(rules: Rule[], toolName: string, input: Record<string, unknown>): Rule | undefined {
	const target = getMatchTarget(toolName, input);

	for (const rule of rules) {
		if (rule.tool !== "*" && rule.tool !== toolName) continue;

		if (rule.match !== undefined) {
			if (target === undefined) continue;
			try {
				if (!new RegExp(rule.match, "i").test(target)) continue;
			} catch {
				continue;
			}
		}

		return rule;
	}

	return undefined;
}

const BUILTIN_PROTECTED_DENY_READ = [
	"\\.env(\\..+)?$",
	"\\.(pem|key|p12|pfx|crt|ca-bundle)$",
	"(^|[/])(\\.aws[/]|\\.ssh[/]|\\.gnupg[/])",
];

const BUILTIN_PROTECTED_DENY_WRITE = [
	"\\.env(\\..+)?$",
	"\\.(pem|key|p12|pfx|crt|ca-bundle)$",
	"(^|[/])\\.git/(hooks/|config$)",
	"(^|[/])(\\.bashrc|\\.bash_profile|\\.zshrc|\\.zprofile|\\.profile)$",
	"(^|[/])\\.(gitconfig|gitmodules|ripgreprc|mcp\\.json)$",
	"(^|[/])(\\.vscode/|\\.idea/)",
	"(^|[/])\\.claude/(commands/|agents/)",
];

function dedupeStrings(items: string[]): string[] {
	return [...new Set(items)];
}

function resolveProtectedResources(config: PermissionsConfig): ResolvedProtectedResources {
	const settings = config.protectedResources ?? {};
	const enabled = settings.enabled ?? true;
	if (!enabled) return { denyRead: [], denyWrite: [] };

	const useDefaults = settings.defaults ?? true;
	const denyReadSource = [
		...(useDefaults ? BUILTIN_PROTECTED_DENY_READ : []),
		...(settings.addDenyRead ?? []),
	];
	const denyWriteSource = [
		...(useDefaults ? BUILTIN_PROTECTED_DENY_WRITE : []),
		...(settings.addDenyWrite ?? []),
	];
	const unprotectRead = new Set(settings.unprotectRead ?? []);
	const unprotectWrite = new Set(settings.unprotectWrite ?? []);

	return {
		denyRead: dedupeStrings(denyReadSource.filter((r) => !unprotectRead.has(r))),
		denyWrite: dedupeStrings(denyWriteSource.filter((r) => !unprotectWrite.has(r))),
	};
}

function compileProtectedRules(protectedResources: ResolvedProtectedResources): Rule[] {
	const rules: Rule[] = [];
	for (const match of protectedResources.denyRead) {
		rules.push({ tool: "read", match, action: "block", reason: "Blocked by protected resource policy" });
	}
	for (const match of protectedResources.denyWrite) {
		rules.push({ tool: "write", match, action: "block", reason: "Blocked by protected resource policy" });
		rules.push({ tool: "edit", match, action: "block", reason: "Blocked by protected resource policy" });
	}
	return rules;
}

function compileModeDefaults(mode: PermissionMode): { rules: Rule[]; externalPath: ExternalPathPolicy } {
	switch (mode) {
		case "plan":
			return {
				externalPath: "block",
				rules: [
					{ tool: "write", action: "block", reason: "Plan mode is read-only" },
					{ tool: "edit", action: "block", reason: "Plan mode is read-only" },
					{ tool: "bash", action: "ask", reason: "Plan mode requires confirmation for shell commands" },
				],
			};
		case "full-access":
			return {
				externalPath: "allow",
				rules: [],
			};
		case "workspace-write":
		default:
			return {
				externalPath: "ask",
				rules: [
					{
						tool: "bash",
						action: "ask",
						reason: "Workspace-write mode requires confirmation for shell commands unless explicitly allowed",
					},
				],
			};
	}
}

/** Returns the effective mode/rules/externalPath bundle for the given agent. */
function activePolicy(config: PermissionsConfig, agentName: string): EffectivePolicy {
	const protectedResources = resolveProtectedResources(config);
	const protectedRules = compileProtectedRules(protectedResources);
	const defaultMode = config.default?.mode ?? "workspace-write";
	const defaultCompiled = compileModeDefaults(defaultMode);
	const defaultRules = [...protectedRules, ...(config.default?.rules ?? []), ...defaultCompiled.rules];
	const defaultExternalPath = config.default?.externalPath ?? defaultCompiled.externalPath;

	if (agentName === "default" || !config.agents?.[agentName]) {
		return {
			mode: defaultMode,
			rules: defaultRules,
			externalPath: defaultExternalPath,
			protectedResources,
		};
	}

	const profile = config.agents[agentName];
	const profileMode = profile.mode ?? defaultMode;
	const profileCompiled = compileModeDefaults(profileMode);
	const profileExternalPath = profile.externalPath ?? (profile.mode ? profileCompiled.externalPath : defaultExternalPath);
	const profileRules = [...(profile.rules ?? [])];

	if (profile.inherit === false) {
		return {
			mode: profileMode,
			rules: [...protectedRules, ...profileRules, ...profileCompiled.rules],
			externalPath: profileExternalPath,
			protectedResources,
		};
	}

	return {
		mode: profileMode,
		rules: [...protectedRules, ...profileRules, ...(config.default?.rules ?? []), ...(profile.mode ? profileCompiled.rules : defaultCompiled.rules)],
		externalPath: profileExternalPath,
		protectedResources,
	};
}

function compileSandboxConfig(
	policy: EffectivePolicy,
	cwd: string,
	overrides: SandboxSettings | undefined,
): { enabled: boolean; config: SandboxRuntimeConfigLike; reason: string } {
	const modeDefaults: Record<PermissionMode, { enabled: boolean; network: boolean; allowWrite: string[] }> = {
		"plan": { enabled: true, network: false, allowWrite: [] },
		"workspace-write": { enabled: true, network: true, allowWrite: [cwd, "/tmp"] },
		"full-access": { enabled: false, network: true, allowWrite: [cwd, "/tmp"] },
	};

	const modeDefault = modeDefaults[policy.mode];
	const enabled = overrides?.enabled ?? modeDefault.enabled;
	const networkEnabled = overrides?.network ?? modeDefault.network;
	const allowWrite = overrides?.allowWrite ?? modeDefault.allowWrite;
	const denyRead = dedupeStrings([...(policy.protectedResources.denyRead ?? []), ...(overrides?.denyRead ?? [])]);
	const denyWrite = dedupeStrings([...(policy.protectedResources.denyWrite ?? []), ...(overrides?.denyWrite ?? [])]);
	const socketSet = new Set<string>(overrides?.allowUnixSockets ?? []);
	if (overrides?.allowSshAuthSock && process.env.SSH_AUTH_SOCK) socketSet.add(process.env.SSH_AUTH_SOCK);
	const allowUnixSockets = [...socketSet];
	const allowAllUnixSockets = overrides?.allowAllUnixSockets ?? false;

	return {
		enabled,
		reason: enabled ? `mode=${policy.mode}` : `disabled by mode=${policy.mode}`,
		config: {
			network: networkEnabled
				? {
					allowedDomains: ["*"],
					deniedDomains: [],
					allowUnixSockets: allowUnixSockets.length > 0 ? allowUnixSockets : undefined,
					allowAllUnixSockets: allowAllUnixSockets || undefined,
				}
				: {
					allowedDomains: [],
					deniedDomains: ["*"],
					allowUnixSockets: allowUnixSockets.length > 0 ? allowUnixSockets : undefined,
					allowAllUnixSockets: allowAllUnixSockets || undefined,
				},
			filesystem: {
				denyRead,
				allowWrite,
				denyWrite,
			},
		},
	};
}

function createSandboxedBashOps(SandboxManager: any): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

			return new Promise((resolve, reject) => {
				const child = spawn("bash", ["-c", wrappedCommand], {
					cwd,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;

				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch {
								child.kill("SIGKILL");
							}
						}
					}, timeout * 1000);
				}

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					reject(err);
				});

				const onAbort = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				};

				signal?.addEventListener("abort", onAbort, { once: true });

				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);

					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			});
		},
	};
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

/** Resolves a path token, expanding a leading ~ and stripping pi's leading @. */
function resolveToken(token: string, cwd: string): string {
	const clean = token.replace(/^@/, "");
	if (clean.startsWith("~/") || clean === "~") {
		return path.join(os.homedir(), clean.slice(1));
	}
	return path.resolve(cwd, clean);
}

function canonicalizePath(inputPath: string): string {
	try {
		return fs.realpathSync.native(inputPath);
	} catch {
		return inputPath;
	}
}

function canonicalizePathToken(token: string, cwd: string): string {
	const abs = resolveToken(token, cwd);
	try {
		return fs.realpathSync.native(abs);
	} catch {
		const parent = path.dirname(abs);
		const base = path.basename(abs);
		try {
			return path.join(fs.realpathSync.native(parent), base);
		} catch {
			return abs;
		}
	}
}

/** Returns true if the given path token resolves outside cwd (canonical, symlink-safe when possible). */
function isPathOutsideCwd(rawPath: string, cwd: string): boolean {
	const target = canonicalizePathToken(rawPath, cwd);
	const root = canonicalizePath(cwd);
	const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
	return target !== root && !target.startsWith(normalizedRoot);
}

/**
 * Returns canonical absolute paths referenced by a structured filesystem tool
 * that are outside cwd. Bash is intentionally excluded: shell parsing is too
 * fragile for reliable security enforcement. Use a sandbox backend for bash.
 */
function getExternalPaths(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
	if (!FILESYSTEM_TOOLS.has(toolName)) return [];

	const target = getMatchTarget(toolName, input);
	if (!target || !isPathOutsideCwd(target, cwd)) return [];
	return [canonicalizePathToken(target, cwd)];
}

function pathMatchesPrefix(target: string, prefix: string): boolean {
	if (target === prefix) return true;
	const normalizedPrefix = prefix.endsWith(path.sep) ? prefix : prefix + path.sep;
	return target.startsWith(normalizedPrefix);
}

function getApprovalsSettings(config: PermissionsConfig): Required<Pick<ApprovalsSettings, "scopeByProject" | "scopeByAgent">> & Pick<ApprovalsSettings, "maxAgeDays"> {
	return {
		scopeByProject: config.approvals?.scopeByProject ?? true,
		scopeByAgent: config.approvals?.scopeByAgent ?? true,
		maxAgeDays: config.approvals?.maxAgeDays,
	};
}

function approvalScopeMatch(
	approval: ApprovalRecord,
	toolName: string,
	targetPath: string,
	projectRoot: string,
	agentName: string,
	settings: ReturnType<typeof getApprovalsSettings>,
): boolean {
	if (approval.tool !== toolName && approval.tool !== "*") return false;
	if (settings.scopeByProject && approval.projectRoot !== projectRoot) return false;
	if (settings.scopeByAgent && approval.agentName !== agentName) return false;
	if (approval.scopeType !== "path-prefix") return false;
	return pathMatchesPrefix(targetPath, approval.scopeValue);
}

function approvalsCoverPaths(
	approvals: ApprovalRecord[],
	toolName: string,
	paths: string[],
	projectRoot: string,
	agentName: string,
	settings: ReturnType<typeof getApprovalsSettings>,
): boolean {
	if (paths.length === 0) return true;
	return paths.every((p) => approvals.some((a) => approvalScopeMatch(a, toolName, p, projectRoot, agentName, settings)));
}

function dedupeApprovals(approvals: ApprovalRecord[]): ApprovalRecord[] {
	const seen = new Set<string>();
	const result: ApprovalRecord[] = [];
	for (const a of approvals) {
		const key = `${a.tool}::${a.scopeType}::${a.scopeValue}::${a.projectRoot ?? "*"}::${a.agentName ?? "*"}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(a);
	}
	return result;
}

function pruneExpiredApprovals(
	approvals: ApprovalRecord[],
	settings: ReturnType<typeof getApprovalsSettings>,
	now = Date.now(),
): ApprovalRecord[] {
	if (!settings.maxAgeDays || settings.maxAgeDays <= 0) return approvals;
	const maxAgeMs = settings.maxAgeDays * 24 * 60 * 60 * 1000;
	return approvals.filter((a) => now - a.createdAt <= maxAgeMs);
}

function isComplexBashCommand(command: string): boolean {
	// Detect shell chaining, redirection, substitution, and control flow.
	return /(^|[^\\])(?:&&|\|\||[;|<>]|\$\(|`|\n|\bif\b|\bfor\b|\bwhile\b|\bcase\b)/.test(command);
}

function getBashCommandPrefix(command: string): string | undefined {
	const trimmed = command.trim();
	if (!trimmed) return undefined;
	const m = trimmed.match(/^([^\s;|&<>`$()]+(?:\s+[^\s;|&<>`$()]+)?)/);
	return m?.[1]?.trim();
}

function bashApprovalMatches(
	approval: ApprovalRecord,
	command: string,
	projectRoot: string,
	agentName: string,
	settings: ReturnType<typeof getApprovalsSettings>,
): boolean {
	if (approval.tool !== "bash" && approval.tool !== "*") return false;
	if (settings.scopeByProject && approval.projectRoot !== projectRoot) return false;
	if (settings.scopeByAgent && approval.agentName !== agentName) return false;
	if (approval.scopeType === "bash-exact") return approval.scopeValue === command;
	if (approval.scopeType === "bash-prefix") return command.startsWith(approval.scopeValue);
	return false;
}

function approvalsCoverBash(
	approvals: ApprovalRecord[],
	command: string,
	projectRoot: string,
	agentName: string,
	settings: ReturnType<typeof getApprovalsSettings>,
): boolean {
	if (!command.trim()) return false;
	return approvals.some((a) => bashApprovalMatches(a, command, projectRoot, agentName, settings));
}

function detectDangerousBashPattern(command: string): string | undefined {
	const checks: Array<{ re: RegExp; reason: string }> = [
		{ re: /\brm\b/i, reason: "Deletes files" },
		{ re: /\bmv\b/i, reason: "Moves or renames" },
		{ re: /\bsudo\b/i, reason: "Elevated privileges" },
		{ re: /\b(chmod|chown)\b/i, reason: "Changes permissions or ownership" },
		{ re: /\bkill\b/i, reason: "Terminates processes" },
		{ re: /\bcurl\b.+(-X\s*(POST|PUT|DELETE|PATCH)|--request\s+(POST|PUT|DELETE|PATCH))/i, reason: "HTTP write operation" },
	];
	for (const check of checks) {
		if (check.re.test(command)) return check.reason;
	}
	return undefined;
}

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
	let sandboxManager: any;
	let sandboxAvailable = false;
	let sandboxEnabled = false;
	let sandboxReason = "inactive";
	let sandboxMode: "normal" | "ask-all-bash" | "block-all-bash" = "normal";
	let sandboxConfig: SandboxRuntimeConfigLike | undefined;

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
		const compiled = compileSandboxConfig(policy, ctx.cwd, config.sandbox);
		sandboxConfig = compiled.config;

		if ((pi.getFlag("no-sandbox") as boolean) === true) {
			sandboxReason = "disabled by --no-sandbox";
			sandboxMode = policy.mode === "plan" ? "block-all-bash" : policy.mode === "workspace-write" ? "ask-all-bash" : "normal";
			return;
		}

		if (!compiled.enabled) {
			sandboxReason = compiled.reason;
			return;
		}

		if (process.platform !== "darwin" && process.platform !== "linux") {
			sandboxReason = `unsupported platform: ${process.platform}`;
			sandboxMode = policy.mode === "plan" ? "block-all-bash" : policy.mode === "workspace-write" ? "ask-all-bash" : "normal";
			return;
		}

		try {
			const mod = await import("@anthropic-ai/sandbox-runtime");
			sandboxManager = mod.SandboxManager;
			sandboxAvailable = true;
		} catch {
			sandboxAvailable = false;
			sandboxReason = "backend not installed";
			sandboxMode = policy.mode === "plan" ? "block-all-bash" : policy.mode === "workspace-write" ? "ask-all-bash" : "normal";
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
			sandboxMode = policy.mode === "plan" ? "block-all-bash" : policy.mode === "workspace-write" ? "ask-all-bash" : "normal";
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
		sandboxEnabled = false;
		sandboxConfig = undefined;
	});

	// ── Ask helper ────────────────────────────────────────────────────────────

	async function askPermission(
		toolName: string,
		input: Record<string, unknown>,
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
			const command = typeof input.command === "string" ? input.command : "";
			const prefix = getBashCommandPrefix(command);
			const options = ["Allow once", "Allow exact command for this session", ...(prefix ? ["Allow command prefix for this session"] : []), "Block"];
			const choice = await ctx.ui.select(`⚠️  Permission required\n\n${lines.join("\n")}`, options);

			if (choice === "Block" || choice === undefined) {
				return { block: true, reason: "Blocked by user" };
			}

			if (choice === "Allow exact command for this session") {
				sessionBashApprovals.push({
					tool: "bash",
					scopeType: "bash-exact",
					scopeValue: command,
					projectRoot: approvalsSettings.scopeByProject ? projectRoot : undefined,
					agentName: approvalsSettings.scopeByAgent ? agentName : undefined,
					createdAt: Date.now(),
				});
				ctx.ui.notify("✓ Bash exact command allowed for this session", "info");
			}

			if (choice === "Allow command prefix for this session" && prefix) {
				sessionBashApprovals.push({
					tool: "bash",
					scopeType: "bash-prefix",
					scopeValue: prefix,
					projectRoot: approvalsSettings.scopeByProject ? projectRoot : undefined,
					agentName: approvalsSettings.scopeByAgent ? agentName : undefined,
					createdAt: Date.now(),
				});
				ctx.ui.notify(`✓ Bash prefix allowed for this session: ${prefix}`, "info");
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
		toolName: string,
		input: Record<string, unknown>,
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
		const input = event.input as Record<string, unknown>;
		const policy = activePolicy(config, agentName);
		const projectRoot = canonicalizePath(ctx.cwd);

		if (event.toolName === "bash") {
			const command = typeof input.command === "string" ? input.command : "";
			const effectiveApprovals = [...persistentApprovals, ...sessionBashApprovals];
			if (approvalsCoverBash(effectiveApprovals, command, projectRoot, agentName, approvalsSettings)) {
				return undefined;
			}
			if (sandboxMode === "block-all-bash") {
				return { block: true, reason: `Bash blocked: sandbox unavailable in ${policy.mode} mode` };
			}
			if (sandboxMode === "ask-all-bash") {
				return askPermission(event.toolName, input, "Sandbox unavailable: confirmation required for all bash commands", projectRoot, ctx);
			}
			const dangerousReason = detectDangerousBashPattern(command);
			if (dangerousReason) {
				return askPermission(event.toolName, input, dangerousReason, projectRoot, ctx);
			}
		} else if (sessionAllows.has(event.toolName)) {
			return undefined;
		}

		const rule = policy.rules.length > 0 ? matchRule(policy.rules, event.toolName, input) : undefined;

		if (rule) {
			if (rule.action === "block") {
				const reason = rule.reason ?? `Blocked by permissions policy (profile: ${agentName})`;
				if (ctx.hasUI) ctx.ui.notify(`🚫 ${event.toolName}: ${reason}`, "warning");
				return { block: true, reason };
			}

			if (rule.action === "ask") {
				return askPermission(event.toolName, input, rule.reason, projectRoot, ctx);
			}

			// action === "allow" — still check external path unless opted out
			if (rule.action === "allow") {
				if (event.toolName === "bash") {
					const command = typeof input.command === "string" ? input.command : "";
					if (isComplexBashCommand(command)) {
						return askPermission(event.toolName, input, "Complex shell command requires confirmation", projectRoot, ctx);
					}
				}

				const epa = rule.externalPathAction ?? "inherit";
				if (epa === "allow") return undefined; // explicit bypass

				const externalPolicy = epa === "inherit" ? policy.externalPath : epa;
				const externalPaths = externalPolicy === "allow" ? [] : getExternalPaths(event.toolName, input, ctx.cwd);
				if (externalPolicy !== "allow" && externalPaths.length > 0) {
					const effectiveApprovals = [...persistentApprovals, ...sessionPathApprovals];
					if (!approvalsCoverPaths(effectiveApprovals, event.toolName, externalPaths, projectRoot, agentName, approvalsSettings)) {
						return applyExternalPathPolicy(externalPolicy, event.toolName, input, externalPaths, projectRoot, ctx);
					}
				}
				return undefined;
			}
		}

		// No rule matched — check external path policy
		if (policy.externalPath !== "allow") {
			const externalPaths = getExternalPaths(event.toolName, input, ctx.cwd);
			if (externalPaths.length > 0) {
				const effectiveApprovals = [...persistentApprovals, ...sessionPathApprovals];
				if (!approvalsCoverPaths(effectiveApprovals, event.toolName, externalPaths, projectRoot, agentName, approvalsSettings)) {
					return applyExternalPathPolicy(policy.externalPath, event.toolName, input, externalPaths, projectRoot, ctx);
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
						const scope = approval.scopeType === "path-prefix" ? approval.scopeValue : `${approval.scopeType}:${approval.scopeValue}`;
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
					lines.push(`  ${theme.fg("muted", "  network:      ")}${theme.fg("dim", `allow=${(netCfg.allowedDomains ?? []).join(", ") || "(none)"} deny=${(netCfg.deniedDomains ?? []).join(", ") || "(none)"}`)}`);
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

					const toolW  = Math.max(4, ...rules.map((r) => r.tool.length));
					const matchW = Math.max(5, ...rules.map((r) => (r.match ? r.match.length + 2 : 1)));

					lines.push(
						`  ${theme.fg("dim", pad("TOOL", toolW + 2))}` +
						`${theme.fg("dim", pad("MATCH", matchW + 2))}` +
						`${theme.fg("dim", pad("ACTION", 10))}` +
						`${theme.fg("dim", "EXT PATH")}`,
					);
					lines.push(`  ${theme.fg("borderMuted", "─".repeat(toolW + matchW + 28))}`);

					for (const rule of rules) {
						const tool    = theme.fg("text",  pad(rule.tool, toolW + 2));
						const matchStr = rule.match ? `/${rule.match}/` : "-";
						const match   = theme.fg("muted", pad(matchStr, matchW + 2));
						const action  = theme.fg(actionColor(rule.action), pad(`${actionIcon(rule.action)} ${rule.action}`, 10));
						const epa     = rule.externalPathAction ?? "inherit";
						const epaColor = epa === "allow" ? "success" : epa === "block" ? "error" : epa === "ask" ? "warning" : "dim";
						const epaStr  = theme.fg(epaColor, epa);
						const reason  = rule.reason ? theme.fg("dim", `  — ${rule.reason}`) : "";
						lines.push(`  ${tool}${match}${action}${epaStr}${reason}`);
					}
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
			const format = (a: ApprovalRecord) => `${a.tool}:${a.scopeType}:${a.scopeValue}`;

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
