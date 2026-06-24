import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type PermissionToolInput,
	type PermissionToolName,
	type Rule,
	isFilesystemToolName,
} from "./shared";

export function getCommandInput(input: PermissionToolInput): string | undefined {
	return typeof input.command === "string" ? input.command : undefined;
}

export function getPathInput(input: PermissionToolInput): string | undefined {
	return typeof input.path === "string" ? input.path : undefined;
}

export function asPermissionToolInput(input: unknown): PermissionToolInput {
	if (!input || typeof input !== "object") return {};
	return input as PermissionToolInput;
}

export function asPermissionToolName(toolName: string): PermissionToolName {
	return toolName;
}

export function getMatchTarget(toolName: PermissionToolName, input: PermissionToolInput): string | undefined {
	switch (toolName) {
		case "bash":
			return getCommandInput(input);
		case "write":
		case "edit":
		case "read":
		case "grep":
		case "find":
		case "ls":
			return getPathInput(input);
		default:
			return undefined;
	}
}

export function hasRegexMeta(pattern: string): boolean {
	return /[.^$+?(){}[\]\\|]/.test(pattern);
}

export function bashPrefixMatchesCommand(prefix: string, command: string): boolean {
	const trimmedPrefix = prefix.trim();
	const trimmedCommand = command.trim();
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

export function ruleMatch(rule: Rule, toolName: PermissionToolName, target: string): boolean {
	const pattern = rule.match;
	if (pattern === undefined) return true;

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

export function matchRule(rules: Rule[], toolName: PermissionToolName, input: PermissionToolInput): Rule | undefined {
	const target = getMatchTarget(toolName, input);

	for (const rule of rules) {
		if (rule.tool !== "*" && rule.tool !== toolName) continue;
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

export function canonicalizePath(inputPath: string): string {
	try {
		return fs.realpathSync.native(inputPath);
	} catch {
		return path.resolve(inputPath);
	}
}

export function canonicalizePathToken(token: string, cwd: string): string {
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
