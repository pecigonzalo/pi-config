import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureSignature, extractDefinitions, mergeDefinitions } from "./extractors";
import { normalizePath } from "./helpers";
import type { Definition, SourceFile, TreeSitterFileTags, TreeSitterTag } from "./types";

export async function commandVersion(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	signal?: AbortSignal,
): Promise<{ available: boolean; version?: string }> {
	try {
		const result = await pi.exec(command, args, { signal, timeout: 3000 });
		const version = `${result.stdout || ""}${result.stderr || ""}`.trim();
		return { available: result.code === 0, version: version || undefined };
	} catch {
		return { available: false };
	}
}

export async function extractTreeSitterTags(
	pi: ExtensionAPI,
	root: string,
	files: SourceFile[],
	signal?: AbortSignal,
): Promise<{ byFile: Map<string, TreeSitterFileTags>; definitionCount: number; referenceCount: number } | undefined> {
	if (files.length === 0) return undefined;
	const availability = await commandVersion(pi, "tree-sitter", ["--version"], signal);
	if (!availability.available) return undefined;

	const tempDir = await mkdtemp(join(tmpdir(), "pi-code-intel-"));
	const pathsFile = join(tempDir, "paths.txt");
	try {
		await writeFile(pathsFile, files.map((file) => file.absPath).join("\n"), "utf8");
		const result = await pi.exec("tree-sitter", ["tags", "--paths", pathsFile], { signal, timeout: 30_000 });
		const output = result.stdout.trim();
		if (!output || (result.code !== 0 && !output.includes("|"))) return undefined;
		return parseTreeSitterTagsOutput(output, root);
	} catch {
		return undefined;
	} finally {
		await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

export function parseTreeSitterTagsOutput(
	output: string,
	root: string,
): { byFile: Map<string, TreeSitterFileTags>; definitionCount: number; referenceCount: number } {
	const byFile = new Map<string, TreeSitterFileTags>();
	let currentFile: string | undefined;
	let definitionCount = 0;
	let referenceCount = 0;

	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (!line.trim()) continue;

		if (!line.includes("|") || /^\S.*:$/.test(line.trim())) {
			const possiblePath = line.trim().replace(/:$/, "");
			currentFile = normalizePath(possiblePath.startsWith(root) ? relative(root, possiblePath) : possiblePath);
			continue;
		}

		const match = line.match(/^\s*(.*?)\s+\|\s+(\S+)\s+(def|ref)\s+\((\d+),\s*(\d+)\)\s*-\s*\((\d+),\s*(\d+)\)(?:\s+`([^`]*)`)?/);
		if (!match || !currentFile) continue;
		const name = match[1]?.trim();
		const kind = match[2]?.trim() || "symbol";
		const role = match[3] as "def" | "ref";
		const lineNumber = Number(match[4]);
		const column = Number(match[5]);
		const text = match[8]?.trim();
		if (!name || !Number.isFinite(lineNumber) || !Number.isFinite(column)) continue;

		const bucket = byFile.get(currentFile) ?? { definitions: [], references: new Map<string, number>() };
		if (role === "def") {
			bucket.definitions.push({ name, kind, role, file: currentFile, line: lineNumber, column, text });
			definitionCount++;
		} else {
			bucket.references.set(name, (bucket.references.get(name) ?? 0) + 1);
			referenceCount++;
		}
		byFile.set(currentFile, bucket);
	}

	return { byFile, definitionCount, referenceCount };
}

export function hydrateTreeSitterDefinitions(file: SourceFile, text: string, tags: TreeSitterTag[]): Definition[] {
	if (tags.length === 0) return [];
	const lines = text.split(/\r?\n/);
	return tags.map((tag) => ({
		name: tag.name,
		kind: tag.kind,
		file: file.relPath,
		line: tag.line,
		column: tag.column,
		text: tag.text ?? lines[tag.line]?.trimEnd() ?? tag.name,
		signatureLines: captureSignature(lines, tag.line, file.language),
		score: 0,
		backend: "tree-sitter-tags" as const,
	}));
}

export async function extractDefinitionsForLoadedSource(
	pi: ExtensionAPI,
	root: string,
	file: SourceFile,
	text: string,
	signal?: AbortSignal,
): Promise<Definition[]> {
	const syntaxDefinitions = extractDefinitions(file, text);
	const treeSitterTags = await extractTreeSitterTags(pi, root, [file], signal);
	const treeSitterDefinitions = hydrateTreeSitterDefinitions(file, text, treeSitterTags?.byFile.get(file.relPath)?.definitions ?? []);
	return mergeDefinitions(treeSitterDefinitions, syntaxDefinitions);
}
