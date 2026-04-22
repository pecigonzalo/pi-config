import { matchRule } from "./matching";
import type { PermissionMode, Rule } from "./shared";

export function sandboxFallbackModeForPolicy(mode: PermissionMode): "normal" | "ask-all-bash" | "block-all-bash" {
	if (mode === "plan") return "block-all-bash";
	if (mode === "workspace-write") return "ask-all-bash";
	return "normal";
}

const CONTROL_FLOW_KEYWORD_RE = /^\s*(if|for|while|case)\b/;
const DANGEROUS_BASH_CHECKS = [
	{ re: /\brm\b/i, reason: "Deletes files" },
	{ re: /\bmv\b/i, reason: "Moves or renames" },
	{ re: /\bsudo\b/i, reason: "Elevated privileges" },
	{ re: /\b(chmod|chown)\b/i, reason: "Changes permissions or ownership" },
	{ re: /\bkill\b/i, reason: "Terminates processes" },
	{ re: /\bcurl\b.+(-X\s*(POST|PUT|DELETE|PATCH)|--request\s+(POST|PUT|DELETE|PATCH))/i, reason: "HTTP write operation" },
] as const;

type ShellQuoteState = "none" | "single" | "double";

function scanShellSyntax(command: string): { hasComplex: boolean; hasForbiddenSimple: boolean } {
	let hasComplex = CONTROL_FLOW_KEYWORD_RE.test(command);
	let hasForbiddenSimple = hasComplex;
	let quoteState: ShellQuoteState = "none";
	let escaped = false;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];

		if (escaped) {
			escaped = false;
			continue;
		}

		if (ch === "\\" && quoteState !== "single") {
			if (next === "\n") {
				i++;
				continue;
			}
			escaped = true;
			continue;
		}

		if (quoteState === "single") {
			if (ch === "'") quoteState = "none";
			continue;
		}

		if (quoteState === "double") {
			if (ch === '"') {
				quoteState = "none";
				continue;
			}
			if (ch === "`") {
				hasComplex = true;
				hasForbiddenSimple = true;
				continue;
			}
			if (ch === "$" && next === "(") {
				hasComplex = true;
				hasForbiddenSimple = true;
				i++;
				continue;
			}
			continue;
		}

		if (ch === "'") {
			quoteState = "single";
			continue;
		}
		if (ch === '"') {
			quoteState = "double";
			continue;
		}
		if (ch === "`") {
			hasComplex = true;
			hasForbiddenSimple = true;
			continue;
		}
		if (ch === "$" && next === "(") {
			hasComplex = true;
			hasForbiddenSimple = true;
			i++;
			continue;
		}
		if (ch === "&") {
			hasComplex = true;
			if (next === "&") {
				i++;
				continue;
			}
			hasForbiddenSimple = true;
			continue;
		}
		if (ch === "|") {
			hasComplex = true;
			if (next === "|") i++;
			continue;
		}
		if (ch === ";" || ch === ">" || ch === "<" || ch === "\n") {
			hasComplex = true;
			hasForbiddenSimple = true;
		}
	}

	return { hasComplex, hasForbiddenSimple };
}

export function hasComplexBashSyntax(command: string): boolean {
	return scanShellSyntax(command).hasComplex;
}

export function hasForbiddenSimpleBashCompoundSyntax(command: string): boolean {
	return scanShellSyntax(command).hasForbiddenSimple;
}

export function splitSimpleBashCompound(command: string): string[] | undefined {
	const trimmed = command.trim();
	if (!trimmed) return undefined;
	if (hasForbiddenSimpleBashCompoundSyntax(command)) return undefined;

	const parts: string[] = [];
	let current = "";
	let quoteState: ShellQuoteState = "none";
	let escaped = false;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];

		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}

		if (ch === "\\" && quoteState !== "single") {
			current += ch;
			escaped = true;
			continue;
		}

		if (ch === '"' && quoteState !== "single") {
			quoteState = quoteState === "double" ? "none" : "double";
			current += ch;
			continue;
		}

		if (ch === "'" && quoteState !== "double") {
			quoteState = quoteState === "single" ? "none" : "single";
			current += ch;
			continue;
		}

		if (quoteState === "none") {
			if (ch === "&") {
				if (next !== "&") return undefined;
				const segment = current.trim();
				if (!segment) return undefined;
				parts.push(segment);
				current = "";
				i++;
				continue;
			}

			if (ch === "|") {
				const segment = current.trim();
				if (!segment) return undefined;
				parts.push(segment);
				current = "";
				if (next === "|") i++;
				continue;
			}
		}

		current += ch;
	}

	if (escaped || quoteState !== "none") return undefined;
	const tail = current.trim();
	if (!tail) return undefined;
	parts.push(tail);
	return parts;
}

export function detectDangerousBashPattern(command: string): string | undefined {
	for (const check of DANGEROUS_BASH_CHECKS) {
		if (check.re.test(command)) return check.reason;
	}
	return undefined;
}

export function isAllowedSimpleBashCommand(command: string, rules: Rule[]): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	if (detectDangerousBashPattern(trimmed)) return false;
	const rule = matchRule(rules, "bash", { command: trimmed });
	return rule?.action === "allow";
}

export function getFirstUnapprovedBashSegment(
	command: string,
	rules: Rule[],
	isApproved?: (command: string) => boolean,
): string | undefined {
	const parts = splitSimpleBashCompound(command);
	if (!parts || parts.length < 2) return undefined;
	for (const part of parts) {
		if (isAllowedSimpleBashCommand(part, rules)) continue;
		if (isApproved?.(part) === true) continue;
		return part;
	}
	return undefined;
}

export function isAllowedBashCompound(
	command: string,
	rules: Rule[],
	isApproved?: (command: string) => boolean,
): boolean {
	const parts = splitSimpleBashCompound(command);
	if (!parts || parts.length < 2) return false;
	return getFirstUnapprovedBashSegment(command, rules, isApproved) === undefined;
}
