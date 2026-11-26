import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type PermissionToolInput,
	type PermissionToolName,
	type Rule,
	isFilesystemToolName,
	isMcpToolName,
} from "./shared";

export function getCommandInput(input: PermissionToolInput): string | undefined {
	return typeof input.command === "string" ? input.command : undefined;
}

export function getPathInput(input: PermissionToolInput): string | undefined {
	if (typeof input.path === "string") return input.path;
	// Tools like code_intel scope by root when no path is given (repo_map, symbols).
	return typeof input.root === "string" ? input.root : undefined;
}

export function asPermissionToolInput(input: unknown): PermissionToolInput {
	if (!input || typeof input !== "object") return {};
	return input as PermissionToolInput;
}

export function getMatchTarget(toolName: PermissionToolName, input: PermissionToolInput): string | undefined {
	switch (toolName) {
		case "bash":
		case "mcp":
			return getCommandInput(input);
		case "write":
		case "edit":
		case "read":
		case "grep":
		case "find":
		case "ls":
		case "code_intel":
			return getPathInput(input);
		default:
			return undefined;
	}
}

export function hasRegexMeta(pattern: string): boolean {
	return /[.^$+?(){}[\]\\|]/.test(pattern);
}

function stripLeadingBashEnvAssignments(command: string): string {
	return command.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:\"[^\"]*\"|'[^']*'|[^\s;&|<>$`]+)\s+)*/, "");
}

export function bashPrefixMatchesCommand(prefix: string, command: string): boolean {
	const trimmedPrefix = prefix.trim();
	const trimmedCommand = stripLeadingBashEnvAssignments(command);
	if (!trimmedPrefix || !trimmedCommand) return false;
	if (trimmedCommand === trimmedPrefix) return true;
	if (!trimmedCommand.startsWith(trimmedPrefix)) return false;
	const boundaryChar = trimmedCommand[trimmedPrefix.length];
	return boundaryChar !== undefined && (/\s/.test(boundaryChar) || boundaryChar === "@");
}

export function matchSimpleBashPattern(pattern: string, command: string): boolean {
	const trimmedPattern = pattern.trim();
	if (!trimmedPattern) return false;

	if (trimmedPattern.endsWith(" *")) {
		const prefix = trimmedPattern.slice(0, -2).trim();
		return bashPrefixMatchesCommand(prefix, command);
	}

	if (!trimmedPattern.includes(" ")) {
		const escaped = trimmedPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`\\b${escaped}\\b`, "i").test(command);
	}

	return command.toLowerCase().includes(trimmedPattern.toLowerCase());
}

function patternMatches(pattern: string, toolName: PermissionToolName, target: string): boolean {
	if (hasRegexMeta(pattern)) {
		try {
			return new RegExp(pattern, "i").test(target);
		} catch {
			return false;
		}
	}

	if (toolName === "bash") {
		return matchSimpleBashPattern(pattern, target);
	}

	return target.toLowerCase().includes(pattern.toLowerCase());
}

export function ruleMatch(rule: Rule, toolName: PermissionToolName, target: string): boolean {
	const patterns = rule.match;
	if (patterns === undefined) return true;

	return (Array.isArray(patterns) ? patterns : [patterns]).some((pattern) =>
		patternMatches(pattern, toolName, target),
	);
}

export function matchRule(rules: Rule[], toolName: PermissionToolName, input: PermissionToolInput): Rule | undefined {
	const target = getMatchTarget(toolName, input);

	for (const rule of rules) {
		// A rule written for "mcp" covers every `mcp__<server>__<tool>` registration.
		const toolMatches =
			rule.tool === "*" || rule.tool === toolName || (rule.tool === "mcp" && isMcpToolName(toolName));
		if (!toolMatches) continue;
		if (rule.match !== undefined) {
			if (target === undefined) continue;
			if (!ruleMatch(rule, toolName, target)) continue;
		}
		return rule;
	}

	return undefined;
}

export function resolveToken(token: string, cwd: string): string {
	const clean = token.replace(/^@/, "");
	if (clean === "~" || clean.startsWith("~/")) {
		const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
		return clean === "~" ? home : path.resolve(home, clean.slice(2));
	}
	return path.isAbsolute(clean) ? path.resolve(clean) : path.resolve(cwd, clean);
}

function hasErrno(error: unknown, ...codes: string[]): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && codes.includes(String(error.code));
}

function canonicalizeThroughExistingAncestor(inputPath: string, visitedSymlinks: Set<string> = new Set()): string {
	const absolutePath = path.resolve(inputPath);
	let current = absolutePath;
	const unresolved: string[] = [];

	while (true) {
		try {
			return path.join(fs.realpathSync.native(current), ...unresolved);
		} catch (realpathError) {
			if (!hasErrno(realpathError, "ENOENT", "ELOOP")) throw realpathError;

			let isSymlink = false;
			try {
				isSymlink = fs.lstatSync(current).isSymbolicLink();
			} catch (lstatError) {
				const isCycleWalk = hasErrno(realpathError, "ELOOP") && hasErrno(lstatError, "ELOOP");
				if (!hasErrno(lstatError, "ENOENT") && !isCycleWalk) throw lstatError;
				// ENOENT walks to the longest existing ancestor. ELOOP walks to the
				// symlink responsible for the cycle so it can fail closed below.
			}

			if (isSymlink) {
				// A cycle must fail closed rather than be mistaken for an ordinary missing path.
				if (visitedSymlinks.has(current) || visitedSymlinks.size >= 40) {
					throw new Error(`Unable to safely resolve symlink chain at ${current}`);
				}
				visitedSymlinks.add(current);
				const linkTarget = fs.readlinkSync(current);
				const resolvedTarget = path.isAbsolute(linkTarget)
					? path.resolve(linkTarget)
					: path.resolve(path.dirname(current), linkTarget);
				return canonicalizeThroughExistingAncestor(path.join(resolvedTarget, ...unresolved), visitedSymlinks);
			}

			const parent = path.dirname(current);
			if (parent === current) return path.join(current, ...unresolved);
			unresolved.unshift(path.basename(current));
			current = parent;
		}
	}
}

export function canonicalizePath(inputPath: string): string {
	return canonicalizeThroughExistingAncestor(inputPath);
}

export function canonicalizePathToken(token: string, cwd: string): string {
	return canonicalizeThroughExistingAncestor(resolveToken(token, cwd));
}

export interface FilesystemApprovalTargets {
	targetPath: string;
	targetKind: "file" | "folder";
	parentFolderPath?: string;
	gitRepoPath?: string;
}

function isDirectoryTarget(rawPath: string, canonicalPath: string): boolean {
	if (/[\\/]$/.test(rawPath)) return true;
	try {
		return fs.statSync(canonicalPath).isDirectory();
	} catch {
		return false;
	}
}

export function findGitRepoRoot(startPath: string): string | undefined {
	let current = canonicalizePath(startPath);
	while (true) {
		const gitMarker = path.join(current, ".git");
		if (fs.existsSync(gitMarker)) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function getFilesystemApprovalTargets(rawPath: string, cwd: string): FilesystemApprovalTargets {
	const targetPath = canonicalizePathToken(rawPath, cwd);
	const targetKind = isDirectoryTarget(rawPath, targetPath) ? "folder" : "file";
	const parentFolderPath = path.dirname(targetPath);
	const gitSearchRoot = targetKind === "folder" ? targetPath : parentFolderPath;
	const gitRepoPath = findGitRepoRoot(gitSearchRoot);
	return {
		targetPath,
		targetKind,
		parentFolderPath: parentFolderPath !== targetPath ? parentFolderPath : undefined,
		gitRepoPath,
	};
}

export function isPathOutsideCwd(rawPath: string, cwd: string): boolean {
	const target = canonicalizePathToken(rawPath, cwd);
	const root = canonicalizePath(cwd);
	const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
	return target !== root && !target.startsWith(normalizedRoot);
}

/** Translates a workspace-relative glob into a RegExp source (`*`, `**`, and `?` supported). */
function globToRegExpSource(glob: string): string {
	const normalized = glob.replace(/\\/g, "/");
	let source = "^";

	for (let i = 0; i < normalized.length; i++) {
		const char = normalized[i];
		if (char === undefined) break;
		if (char === "*") {
			if (normalized[i + 1] === "*") {
				i++;
				if (normalized[i + 1] === "/") {
					i++;
					source += "(?:.*/)?";
				} else {
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			continue;
		}
		source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	return `${source}$`;
}

function globMatchesPath(glob: string, relativePath: string): boolean {
	try {
		return new RegExp(globToRegExpSource(glob)).test(relativePath.replace(/\\/g, "/"));
	} catch {
		return false;
	}
}

function workspaceRelativePath(rawPath: string, cwd: string): string | undefined {
	const target = canonicalizePathToken(rawPath, cwd);
	const root = canonicalizePath(cwd);
	if (target === root) return "";
	const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
	if (!target.startsWith(normalizedRoot)) return undefined;
	return target.slice(normalizedRoot.length).split(path.sep).join("/");
}

/**
 * True when `rawPath` resolves inside the workspace and matches a read-exemption glob.
 * Canonicalization prevents a symlink inside the workspace from standing in for a file outside it.
 */
export function isWorkspaceReadExempt(rawPath: string, cwd: string, globs: readonly string[] | undefined): boolean {
	if (!globs || globs.length === 0) return false;

	const relative = workspaceRelativePath(rawPath, cwd);
	if (relative === undefined || relative === "") return false;
	return globs.some((glob) => globMatchesPath(glob, relative));
}

export function getExternalPaths(toolName: PermissionToolName, input: PermissionToolInput, cwd: string): string[] {
	if (!isFilesystemToolName(toolName)) return [];

	const target = getMatchTarget(toolName, input);
	if (!target || !isPathOutsideCwd(target, cwd)) return [];
	return [canonicalizePathToken(target, cwd)];
}

export function pathMatchesPrefix(target: string, prefix: string): boolean {
	if (target === prefix) return true;
	const normalizedPrefix = prefix.endsWith(path.sep) ? prefix : prefix + path.sep;
	return target.startsWith(normalizedPrefix);
}
