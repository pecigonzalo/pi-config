/**
 * Best-effort env-file detection for bash commands.
 *
 * When env reads or writes resolve to "ask", the OS sandbox no longer denies them, because the
 * sandbox cannot prompt. Bash would then read a `.env` silently whenever a command rule allows
 * the command (for example a broad `cat` allow rule). This module recovers the prompt for the
 * common literal forms: existing env files named in the command, output redirections, and the
 * usual write commands.
 *
 * It is deliberately best-effort. A dynamic path (`cat "$FILE"`) is not detected; hard-blocked
 * resources stay enforced by the sandbox, and `readAction`/`envWriteAction: "block"` restores
 * the sandbox denial for env files.
 */

import * as fs from "node:fs";
import { canonicalizePathToken, isWorkspaceReadExempt } from "./matching";
import type { ParsedBash, ParsedCommand } from "./shell-parse";
import { PROTECTED_RESOURCE_BLOCK_REASON, type ProtectedAction, type ResolvedProtectedResources } from "./shared";

export interface BashEnvPathHit {
	action: ProtectedAction;
	kind: "read" | "write";
	path: string;
	reason: string;
}

const ENV_NAME_PATTERN = /^\.env(\..+)?$/i;
const ENV_TEMPLATE_NAME_PATTERN = /^\.env\.(example|sample|template|dist|defaults)$/i;
const WRITE_DEST_COMMANDS = new Set(["cp", "mv", "install", "ln", "rsync", "scp"]);
const WRITE_ALL_COMMANDS = new Set(["tee", "touch", "truncate", "rm", "rmdir", "shred", "unlink", "mkdir"]);

function isEnvFilePath(token: string): boolean {
	const candidate = token.trim().replace(/^["']|["']$/g, "");
	if (!candidate) return false;
	const base = candidate.split("/").pop() ?? candidate;
	return ENV_NAME_PATTERN.test(base) && !ENV_TEMPLATE_NAME_PATTERN.test(base);
}

/** Tokens that can carry a path, including the value of `--flag=value`. */
function pathTokens(tokens: readonly string[]): string[] {
	const paths: string[] = [];
	for (const token of tokens.slice(1)) {
		if (token.startsWith("-")) {
			const equals = token.indexOf("=");
			if (equals > 0) paths.push(token.slice(equals + 1));
			continue;
		}
		paths.push(token);
	}
	return paths;
}

function outputRedirectTargets(redirectionTexts: readonly string[]): string[] {
	const targets: string[] = [];
	for (const text of redirectionTexts) {
		const withoutFd = text.replace(/^\d+/, "");
		const match = withoutFd.match(/^(?:&>>?|>>?|>\|)\s*(.+)$/);
		if (!match?.[1]) continue;
		const target = match[1].trim().replace(/^["']|["']$/g, "");
		if (!target || target.startsWith("&")) continue;
		if (/^\/dev\/(null|stdout|stderr|tty)$/.test(target)) continue;
		targets.push(target);
	}
	return targets;
}

function inputRedirectTargets(redirectionTexts: readonly string[]): string[] {
	const targets: string[] = [];
	for (const text of redirectionTexts) {
		const withoutFd = text.replace(/^\d+/, "");
		const match = withoutFd.match(/^<(?!<)\s*(.+)$/);
		if (!match?.[1]) continue;
		targets.push(match[1].trim().replace(/^["']|["']$/g, ""));
	}
	return targets;
}

function writeTargets(command: ParsedCommand): string[] {
	const targets = outputRedirectTargets(command.redirectionTexts);
	const args = pathTokens(command.tokens);

	if (command.name === "tee" || WRITE_ALL_COMMANDS.has(command.name)) {
		targets.push(...args);
		return targets;
	}

	if (WRITE_DEST_COMMANDS.has(command.name)) {
		const inlineTarget = command.tokens.find((token) => token.startsWith("--target-directory="));
		const flagIndex = command.tokens.findIndex((token) => token === "-t" || token === "--target-directory");
		const target =
			inlineTarget?.slice("--target-directory=".length) ??
			(flagIndex >= 0 ? command.tokens[flagIndex + 1] : undefined) ??
			args[args.length - 1];
		if (target) targets.push(target);
		return targets;
	}

	if (command.name === "dd") {
		for (const token of command.tokens) {
			if (token.startsWith("of=")) targets.push(token.slice(3));
		}
		return targets;
	}

	const inPlace = command.tokens.some(
		(token) => /^-[a-zA-Z]*i/.test(token) || token === "--in-place" || token.startsWith("--in-place="),
	);
	if (inPlace && (command.name === "sed" || command.name === "perl" || command.name === "ruby")) {
		// The first non-flag argument is the script expression.
		targets.push(...args.slice(1));
	}

	return targets;
}

function hitReason(action: ProtectedAction, kind: "read" | "write", path: string): string {
	return action === "block"
		? `${PROTECTED_RESOURCE_BLOCK_REASON}: ${path}`
		: `Protected env file ${kind} requires confirmation: ${path}`;
}

function tryCanonicalize(token: string, cwd: string): string | undefined {
	try {
		return canonicalizePathToken(token, cwd);
	} catch {
		return undefined;
	}
}

/** Returns the strongest env-file hit found in a parsed bash command, if any. */
export function findBashEnvPathHit(
	parsed: ParsedBash,
	cwd: string,
	protectedResources: ResolvedProtectedResources,
): BashEnvPathHit | undefined {
	const hits: BashEnvPathHit[] = [];

	const add = (hit: BashEnvPathHit) => {
		if (!hits.some((existing) => existing.kind === hit.kind && existing.path === hit.path)) hits.push(hit);
	};

	const addWrite = (token: string) => {
		if (!isEnvFilePath(token)) return;
		const path = tryCanonicalize(token, cwd);
		if (!path) return;
		const action = protectedResources.envWriteAction;
		add({ action, kind: "write", path, reason: hitReason(action, "write", path) });
	};

	for (const command of parsed.commands) {
		for (const token of writeTargets(command)) {
			addWrite(token);
		}

		const readCandidate = (token: string) => {
			if (!isEnvFilePath(token)) return;
			const path = tryCanonicalize(token, cwd);
			if (!path || !fs.existsSync(path)) return;
			if (isWorkspaceReadExempt(token, cwd, protectedResources.workspaceRead)) return;
			add({
				action: protectedResources.readAction,
				kind: "read",
				path,
				reason: hitReason(protectedResources.readAction, "read", path),
			});
		};

		for (const token of pathTokens(command.tokens)) readCandidate(token);
		for (const token of inputRedirectTargets(command.redirectionTexts)) readCandidate(token);
	}

	return hits.find((hit) => hit.action === "block") ?? hits[0];
}
