import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_FILE_BYTES, EXT_TO_LANGUAGE, LANGUAGE_SPECIFIC_PATTERN_SUPPORT, SKIP_DIRS } from "./constants";
import { canonicalizePath, clampInt, isWithinRoot, looksBinary, normalizePath } from "./helpers";
import type { RepoMapOptions, SourceDiscoveryResult, SourceFile } from "./types";

const SOURCE_SUFFIXES = [...EXT_TO_LANGUAGE.keys()].sort((left, right) => right.length - left.length);

export async function findProjectRoot(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string> {
	return (await gitTopLevel(pi, cwd, signal)) ?? cwd;
}

/**
 * Workspace boundary for root and path inputs: the git top level when cwd is
 * inside a work tree, otherwise cwd. All requested roots and paths must resolve
 * within it.
 */
export async function findWorkspaceRoot(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string> {
	return canonicalizePath(await findProjectRoot(pi, cwd, signal));
}

async function gitTopLevel(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const result = await pi.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { signal, timeout: 5000 });
		if (result.code === 0) {
			const root = result.stdout.trim();
			if (root) return root;
		}
	} catch {
		// Not a git work tree; fall back to cwd.
	}
	return undefined;
}

export async function loadRequestedSourceFile(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: RepoMapOptions,
	signal?: AbortSignal,
): Promise<{ root: string; file: SourceFile; text: string } | string> {
	if (!params.path) return "This action requires path.";
	const root = params.root ? resolve(ctx.cwd, params.root) : await findProjectRoot(pi, ctx.cwd, signal);
	const workspace = await findWorkspaceRoot(pi, ctx.cwd, signal);
	const canonicalRoot = canonicalizePath(root);
	if (!isWithinRoot(workspace, canonicalRoot)) {
		return `Requested root is outside the session workspace (${workspace}): ${params.root}`;
	}
	const absPath = canonicalizePath(resolve(root, params.path));
	if (!isWithinRoot(workspace, absPath)) {
		return `Path is outside the session workspace (${workspace}): ${params.path}`;
	}
	if (!existsSync(absPath)) return `File not found: ${params.path}`;
	const relPath = normalizePath(relative(canonicalRoot, absPath));
	const language = languageForPath(relPath);
	if (!language) return `Unsupported file extension for ${params.path}.`;
	const fileStat = await stat(absPath);
	if (!fileStat.isFile()) return `Not a regular file: ${params.path}`;
	const maxFileBytes = clampInt(params.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 1_000, 5 * 1024 * 1024);
	if (fileStat.size > maxFileBytes) {
		return `File is too large to analyze (limit ${maxFileBytes} bytes): ${params.path}`;
	}
	const text = await readFile(absPath, "utf8");
	if (looksBinary(text)) return `Refusing to analyze binary-looking file: ${params.path}`;
	return {
		root: canonicalRoot,
		file: { absPath, relPath, language, size: fileStat.size, mtimeMs: fileStat.mtimeMs },
		text,
	};
}

export async function listSourceFiles(
	pi: ExtensionAPI,
	root: string,
	options: { maxFiles: number; maxFileBytes: number; include?: string[]; exclude?: string[] },
	signal?: AbortSignal,
): Promise<SourceDiscoveryResult> {
	const topLevel = await gitTopLevel(pi, root, signal);
	// git ls-files paths are repo-root-relative; only use them when the requested
	// root is the top level. Otherwise walk the root so subdirectory roots resolve.
	const useGitFiles = !!topLevel && canonicalizePath(root) === topLevel;
	const relPaths = useGitFiles
		? await listGitFiles(pi, root, signal)
		: await walkFiles(root, options.maxFiles * 2, signal);
	const files: SourceFile[] = [];
	const unsupportedExtensions = new Map<string, number>();
	const fallbackPatternLanguages = new Map<string, number>();

	for (const relPath of relPaths) {
		if (files.length >= options.maxFiles) break;
		if (!shouldIncludePath(relPath, options.include, options.exclude)) continue;
		if (isGeneratedOrVendored(relPath)) continue;
		const language = languageForPath(relPath);
		if (!language) {
			incrementCount(unsupportedExtensions, extensionLabel(relPath));
			continue;
		}
		if (!LANGUAGE_SPECIFIC_PATTERN_SUPPORT.has(language)) incrementCount(fallbackPatternLanguages, language);

		const absPath = resolve(root, relPath);
		let fileStat;
		try {
			fileStat = await stat(absPath);
		} catch {
			continue;
		}
		if (!fileStat.isFile() || fileStat.size > options.maxFileBytes) continue;
		files.push({ absPath, relPath, language, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
	}

	return {
		files,
		diagnostics: { unsupportedExtensions, fallbackPatternLanguages },
	};
}

function incrementCount(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

function extensionLabel(relPath: string): string {
	const extension = sourceSuffixForPath(relPath) ?? extname(relPath).toLowerCase();
	return extension || "(no extension)";
}

async function listGitFiles(pi: ExtensionAPI, root: string, signal?: AbortSignal): Promise<string[]> {
	try {
		const result = await pi.exec(
			"git",
			["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
			{
				signal,
				timeout: 10_000,
			},
		);
		if (result.code !== 0) return [];
		return result.stdout.split("\0").filter(Boolean);
	} catch {
		return [];
	}
}

async function walkFiles(root: string, maxEntries: number, signal?: AbortSignal): Promise<string[]> {
	const out: string[] = [];
	async function walk(absDir: string) {
		if (signal?.aborted || out.length >= maxEntries) return;
		let entries;
		try {
			entries = await readdir(absDir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (signal?.aborted || out.length >= maxEntries) return;
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				await walk(join(absDir, entry.name));
			} else if (entry.isFile()) {
				out.push(relative(root, join(absDir, entry.name)));
			}
		}
	}
	await walk(root);
	return out;
}

function shouldIncludePath(relPath: string, include?: string[], exclude?: string[]): boolean {
	const normalized = normalizePath(relPath);
	if (include?.length && !include.some((item) => normalized.includes(normalizePath(item)))) return false;
	if (exclude?.some((item) => normalized.includes(normalizePath(item)))) return false;
	return true;
}

export function languageForPath(path: string): string | undefined {
	const suffix = sourceSuffixForPath(path);
	return suffix ? EXT_TO_LANGUAGE.get(suffix) : undefined;
}

function sourceSuffixForPath(path: string): string | undefined {
	const lowerPath = path.toLowerCase();
	return SOURCE_SUFFIXES.find((suffix) => lowerPath.endsWith(suffix));
}

function isGeneratedOrVendored(path: string): boolean {
	const normalized = normalizePath(path);
	const parts = normalized.split("/");
	if (parts.some((part) => SKIP_DIRS.has(part))) return true;
	const base = basename(normalized).toLowerCase();
	return (
		base.endsWith(".min.js") ||
		base.endsWith(".bundle.js") ||
		base.endsWith(".generated.ts") ||
		base.endsWith(".generated.js") ||
		base.endsWith(".pb.go") ||
		base === "package-lock.json"
	);
}
