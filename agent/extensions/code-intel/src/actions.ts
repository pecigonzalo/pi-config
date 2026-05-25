import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { EXT_TO_LANGUAGE, LANGUAGE_SPECIFIC_PATTERN_SUPPORT } from "./constants";
import { buildRepoAnalysis, generateRepoMapOutput, renderScanDiagnostics } from "./analysis";
import { extractImportLines, findDefinitionEnd, findEnclosingDefinition } from "./extractors";
import { clampInt } from "./helpers";
import { findProjectRoot, loadRequestedSourceFile } from "./source-files";
import { commandVersion, extractDefinitionsForLoadedSource } from "./tree-sitter";
import type { Definition, RepoMapOptions, SourceFile } from "./types";

export async function buildStatus(pi: ExtensionAPI, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
	const root = await findProjectRoot(pi, ctx.cwd, signal);
	const treeSitter = await commandVersion(pi, "tree-sitter", ["--version"], signal);
	const ctags = await commandVersion(pi, "ctags", ["--version"], signal);
	const rg = await commandVersion(pi, "rg", ["--version"], signal);
	const git = await commandVersion(pi, "git", ["--version"], signal);
	const universalCtags = /Universal Ctags/i.test(ctags.version ?? "");
	const fallbackPatternLanguages = Array.from(new Set(EXT_TO_LANGUAGE.values()))
		.filter((language) => !LANGUAGE_SPECIFIC_PATTERN_SUPPORT.has(language))
		.sort();

	return [
		"Code Intel status",
		`- root: ${root}`,
		`- git: ${formatCommandStatus(git)}`,
		`- ripgrep: ${formatCommandStatus(rg)}`,
		`- tree-sitter CLI: ${formatCommandStatus(treeSitter)}`,
		`- universal-ctags: ${universalCtags ? "available" : ctags.available ? "not detected (ctags exists, but does not look like Universal Ctags)" : "not found"}`,
		`- active backend: ${treeSitter.available ? "tree-sitter tags when queries/parsers are configured, with syntax-pattern fallback" : "syntax-pattern fallback"}`,
		`- supported extensions: ${Array.from(EXT_TO_LANGUAGE.keys()).sort().join(", ")}`,
		`- dedicated syntax patterns: ${Array.from(LANGUAGE_SPECIFIC_PATTERN_SUPPORT).sort().join(", ")}`,
		fallbackPatternLanguages.length > 0 ? `- generic fallback patterns only: ${fallbackPatternLanguages.join(", ")}` : undefined,
		"- notes: repo_map is approximate and meant for orientation; read targeted files/ranges before editing.",
	]
		.filter(Boolean)
		.join("\n");
}

function formatCommandStatus(status: { available: boolean; version?: string }): string {
	if (!status.available) return "not found";
	return status.version?.split("\n")[0]?.trim() || "available";
}

export async function generateRepoMap(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: RepoMapOptions,
	signal?: AbortSignal,
): Promise<string> {
	return generateRepoMapOutput(pi, ctx, params, signal);
}

export async function generateOutline(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: RepoMapOptions,
	signal?: AbortSignal,
): Promise<string> {
	const loaded = await loadRequestedSourceFile(pi, ctx, params, signal);
	if (typeof loaded === "string") return loaded;
	const { root, file, text } = loaded;
	const definitions = await extractDefinitionsForLoadedSource(pi, root, file, text, signal);
	const lines = text.split(/\r?\n/);
	const imports = extractImportLines(lines);
	const out = [
		`Outline for ${file.relPath}`,
		`Root: ${root}`,
		`Language: ${file.language}; ${lines.length} line(s); ${formatSize(file.size)}`,
		"",
	];

	if (imports.length > 0) {
		out.push("Imports / module links:");
		for (const item of imports.slice(0, 40)) out.push(`${String(item.line + 1).padStart(5, " ")} │${item.text}`);
		if (imports.length > 40) out.push(`⋮... ${imports.length - 40} more import/module lines omitted`);
		out.push("");
	}

	if (definitions.length === 0) {
		out.push("No symbols found by the current Tree-sitter/syntax-pattern backend.");
		return out.join("\n");
	}

	out.push("Symbols:");
	for (const definition of definitions) {
		const endLine = findDefinitionEnd(lines, definition.line, file.language);
		out.push(
			`${String(definition.line + 1).padStart(5, " ")}-${String(endLine + 1).padStart(5, " ")} │${definition.kind.padEnd(10)} ${definition.name}${definition.backend ? ` [${definition.backend}]` : ""}`,
		);
		for (const signatureLine of definition.signatureLines.slice(0, 3)) {
			out.push(`            │ ${signatureLine.trim()}`);
		}
	}
	return out.join("\n");
}

export async function findSymbols(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: RepoMapOptions,
	signal?: AbortSignal,
): Promise<string> {
	const query = params.query?.trim() ?? params.symbol?.trim() ?? "";
	const limit = clampInt(params.limit ?? 50, 1, 500);
	const analysis = await buildRepoAnalysis(pi, ctx, params, signal);
	const lower = query.toLowerCase();
	const matches = analysis.rankedDefinitions.filter((definition) => {
		if (!query) return true;
		return `${definition.name} ${definition.kind} ${definition.file}`.toLowerCase().includes(lower);
	});

	const out = [
		query ? `Symbols matching "${query}"` : "Top ranked symbols",
		`Root: ${analysis.root}`,
		`Showing ${Math.min(matches.length, limit)} of ${matches.length} match(es).`,
		...renderScanDiagnostics(analysis.diagnostics, analysis.files.length),
		"",
	];

	for (const definition of matches.slice(0, limit)) {
		out.push(
			`${definition.file}:${definition.line + 1}:${definition.column + 1} │ ${definition.kind} ${definition.name} │ score ${definition.score.toFixed(2)}${definition.backend ? ` │ ${definition.backend}` : ""}`,
		);
		out.push(`  ${definition.signatureLines[0]?.trim() ?? definition.text.trim()}`);
	}
	return out.join("\n");
}

export async function sliceSymbol(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: RepoMapOptions,
	signal?: AbortSignal,
): Promise<string> {
	if (!params.symbol?.trim() && !params.line) return "code_intel slice requires symbol or line.";

	let loaded: Awaited<ReturnType<typeof loadRequestedSourceFile>> | undefined;
	if (params.path) {
		loaded = await loadRequestedSourceFile(pi, ctx, params, signal);
		if (typeof loaded === "string") return loaded;
	}

	let target: { file: SourceFile; text: string; definition: Definition } | undefined;
	let loadedDefinitions: Definition[] | undefined;
	if (loaded && typeof loaded !== "string") {
		loadedDefinitions = await extractDefinitionsForLoadedSource(pi, loaded.root, loaded.file, loaded.text, signal);
		target = chooseDefinition(loadedDefinitions, loaded.file, loaded.text, params);
	} else {
		const analysis = await buildRepoAnalysis(pi, ctx, params, signal);
		const candidates = analysis.rankedDefinitions.filter(
			(definition) => definition.name === params.symbol || definition.name.toLowerCase().includes((params.symbol ?? "").toLowerCase()),
		);
		const definition = candidates[0];
		if (definition) {
			const fileAnalysis = analysis.analyses.find((item) => item.file.relPath === definition.file);
			if (fileAnalysis) {
				const text = fileAnalysis.text ?? (await readFile(fileAnalysis.file.absPath, "utf8"));
				target = { file: fileAnalysis.file, text, definition };
			}
		}
	}

	if (!target && loaded && typeof loaded !== "string" && loadedDefinitions && params.symbol?.trim()) {
		const fallback = renderTextMatchFallback(loaded.file, loaded.text, loadedDefinitions, params.symbol);
		if (fallback) return fallback;
	}

	if (!target) return `No matching symbol found${params.symbol ? ` for "${params.symbol}"` : ""}.`;
	const lines = target.text.split(/\r?\n/);
	const endLine = findDefinitionEnd(lines, target.definition.line, target.file.language);
	const slice = lines.slice(target.definition.line, endLine + 1).join("\n");
	const header = `${target.file.relPath}:${target.definition.line + 1}-${endLine + 1} │ ${target.definition.kind} ${target.definition.name}${target.definition.backend ? ` │ ${target.definition.backend}` : ""}`;
	return `${header}\n\n${slice}`;
}

export async function findEnclosingSymbol(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: RepoMapOptions,
	signal?: AbortSignal,
): Promise<string> {
	if (!params.path) return "code_intel enclosing_symbol requires path.";
	if (!params.line) return "code_intel enclosing_symbol requires 1-based line.";
	const loaded = await loadRequestedSourceFile(pi, ctx, params, signal);
	if (typeof loaded === "string") return loaded;
	const definitions = await extractDefinitionsForLoadedSource(pi, loaded.root, loaded.file, loaded.text, signal);
	const lines = loaded.text.split(/\r?\n/);
	const zeroLine = Math.max(0, Math.floor(params.line) - 1);
	const enclosing = findEnclosingDefinition(definitions, lines, zeroLine, loaded.file.language);

	if (!enclosing) return `No enclosing symbol found at ${loaded.file.relPath}:${params.line}.`;
	return [
		`Enclosing symbol at ${loaded.file.relPath}:${params.line}${params.column ? `:${params.column}` : ""}`,
		`${enclosing.definition.kind} ${enclosing.definition.name}${enclosing.definition.backend ? ` (${enclosing.definition.backend})` : ""}`,
		`range: ${enclosing.definition.line + 1}-${enclosing.endLine + 1}`,
		`signature: ${enclosing.definition.signatureLines.map((line) => line.trim()).join(" ")}`,
	].join("\n");
}

function chooseDefinition(definitions: Definition[], file: SourceFile, text: string, params: RepoMapOptions): { file: SourceFile; text: string; definition: Definition } | undefined {
	if (params.line) {
		const lines = text.split(/\r?\n/);
		const zeroLine = Math.max(0, Math.floor(params.line) - 1);
		const enclosing = findEnclosingDefinition(definitions, lines, zeroLine, file.language);
		if (enclosing) return { file, text, definition: enclosing.definition };
	}
	const symbol = params.symbol?.toLowerCase();
	const definition = symbol
		? definitions.find((item) => item.name.toLowerCase() === symbol) ?? definitions.find((item) => item.name.toLowerCase().includes(symbol))
		: definitions[0];
	return definition ? { file, text, definition } : undefined;
}

export function renderTextMatchFallback(file: SourceFile, text: string, definitions: Definition[], symbol: string): string | undefined {
	const matches = findIdentifierLineMatches(text.split(/\r?\n/), symbol);
	if (matches.length === 0) return;

	const lines = text.split(/\r?\n/);
	const out = [
		`No extracted symbol found for "${symbol}".`,
		`Text match fallback: found ${matches.length} identifier match(es) in ${file.relPath}.`,
		"",
	];
	const renderedRanges = new Set<string>();

	for (const match of matches.slice(0, 3)) {
		const enclosing = findEnclosingDefinition(definitions, lines, match.line, file.language);
		if (enclosing) {
			const rangeKey = `${enclosing.definition.line}:${enclosing.endLine}`;
			if (renderedRanges.has(rangeKey)) continue;
			renderedRanges.add(rangeKey);
			out.push(
				`${file.relPath}:${enclosing.definition.line + 1}-${enclosing.endLine + 1} │ enclosing ${enclosing.definition.kind} ${enclosing.definition.name}${enclosing.definition.backend ? ` │ ${enclosing.definition.backend}` : ""}`,
			);
			out.push(`matched line ${match.line + 1}: ${lines[match.line]?.trimEnd() ?? ""}`);
			out.push("");
			out.push(lines.slice(enclosing.definition.line, enclosing.endLine + 1).join("\n"));
			out.push("");
			continue;
		}

		const start = Math.max(0, match.line - 2);
		const end = Math.min(lines.length - 1, match.line + 2);
		const rangeKey = `${start}:${end}`;
		if (renderedRanges.has(rangeKey)) continue;
		renderedRanges.add(rangeKey);
		out.push(`${file.relPath}:${start + 1}-${end + 1} │ text match context`);
		for (let i = start; i <= end; i++) {
			out.push(`${String(i + 1).padStart(5, " ")} │${lines[i] ?? ""}`);
		}
		out.push("");
	}

	if (matches.length > 3) out.push(`⋮... ${matches.length - 3} more text match(es) omitted`);
	return out.join("\n").trimEnd();
}

export function findIdentifierLineMatches(lines: string[], symbol: string): Array<{ line: number; column: number }> {
	const escaped = escapeRegExp(symbol.trim());
	if (!escaped) return [];
	const re = new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`);
	const matches: Array<{ line: number; column: number }> = [];
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(re);
		if (!match || match.index === undefined) continue;
		matches.push({ line: i, column: match.index + (match[1]?.length ?? 0) });
	}
	return matches;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
