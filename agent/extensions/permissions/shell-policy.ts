import { matchRule } from "./matching";
import type { PermissionMode, Rule } from "./shared";
import type { ParsedBash, ParsedCommand } from "./shell-parse";

export function sandboxFallbackModeForPolicy(mode: PermissionMode): "normal" | "ask-all-bash" | "block-all-bash" {
	if (mode === "plan") return "block-all-bash";
	if (mode === "workspace-write") return "ask-all-bash";
	return "normal";
}

// ── Dangerous pattern detection (regex-based, always available) ───────────────

const DANGEROUS_BASH_CHECKS = [
	{ re: /\brm\b/i, reason: "Deletes files" },
	{ re: /\bmv\b/i, reason: "Moves or renames" },
	{ re: /\bsudo\b/i, reason: "Elevated privileges" },
	{ re: /\b(chmod|chown)\b/i, reason: "Changes permissions or ownership" },
	{ re: /\bkill\b/i, reason: "Terminates processes" },
	{ re: /\bcurl\b.+(-X\s*(POST|PUT|DELETE|PATCH)|--request\s+(POST|PUT|DELETE|PATCH))/i, reason: "HTTP write operation" },
] as const;

export function detectDangerousBashPattern(command: string): string | undefined {
	for (const check of DANGEROUS_BASH_CHECKS) {
		if (check.re.test(command)) return check.reason;
	}
	return undefined;
}

// ── Tree-sitter-based policy functions ────────────────────────────────────────
// These operate on a pre-parsed AST (ParsedBash) from shell-parse.ts.

/**
 * Check if a single parsed command is allowed by rules (not dangerous, rule matches "allow").
 */
export function isParsedCommandAllowed(cmd: ParsedCommand, rules: Rule[]): boolean {
	if (detectDangerousBashPattern(cmd.source)) return false;
	const rule = matchRule(rules, "bash", { command: cmd.source });
	return rule?.action === "allow";
}

/**
 * Check if a parsed command is covered by existing approvals.
 */
export function isParsedCommandApproved(
	cmd: ParsedCommand,
	isApproved: (candidate: string) => boolean,
): boolean {
	return isApproved(cmd.source) || isApproved(cmd.command) || isApproved(cmd.alwaysPattern);
}

/**
 * Find the first unapproved command in a parsed bash AST.
 * Returns the ParsedCommand that needs approval, or undefined if all are approved.
 */
export function getFirstUnapprovedParsedCommand(
	parsed: ParsedBash,
	rules: Rule[],
	isApproved?: (candidate: string) => boolean,
): ParsedCommand | undefined {
	for (const cmd of parsed.commands) {
		if (isParsedCommandAllowed(cmd, rules)) continue;
		if (isApproved && isParsedCommandApproved(cmd, isApproved)) continue;
		return cmd;
	}
	return undefined;
}

/**
 * Check if all commands in a parsed bash AST are allowed (by rules or approvals).
 */
export function isAllParsedCommandsAllowed(
	parsed: ParsedBash,
	rules: Rule[],
	isApproved?: (candidate: string) => boolean,
): boolean {
	if (parsed.commands.length === 0) return false;
	return getFirstUnapprovedParsedCommand(parsed, rules, isApproved) === undefined;
}

export function canAutoApproveParsedBash(
	parsed: ParsedBash,
	rules: Rule[],
	isApproved?: (candidate: string) => boolean,
): boolean {
	if (parsed.isComplex) return false;
	return isAllParsedCommandsAllowed(parsed, rules, isApproved);
}
