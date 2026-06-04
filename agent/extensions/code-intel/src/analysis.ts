import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CODE_INTEL_CACHE_VERSION, DEFAULT_MAP_TOKENS, DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_FILES } from "./constants";
import { extractReferences, extractDefinitions, mergeDefinitions } from "./extractors";
import { clampInt, looksBinary } from "./helpers";
import { getLspService, hydrateLspDocumentSymbols, isMappableLspDocumentSymbol, type LspDocumentSymbol } from "./lsp";
import { findProjectRoot, listSourceFiles } from "./source-files";
import { commandVersion, extractTreeSitterTags, hydrateTreeSitterDefinitions } from "./tree-sitter";
import type { CachedAnalysisPayload, Definition, RepoAnalysis, RepoMapOptions, SourceFile, SourceScanDiagnostics } from "./types";

const MAX_LSP_DOCUMENT_SYMBOL_FILES = 250;

export async function generateRepoMapOutput(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: RepoMapOptions,
	signal?: AbortSignal,
): Promise<string> {
	const analysis = await buildRepoAnalysis(pi, ctx, params, signal);
	const mapTokens = clampInt(params.mapTokens ?? DEFAULT_MAP_TOKENS, 200, 20_000);
	return renderRepoMap({
		root: analysis.root,
		files: analysis.files,
		diagnostics: analysis.diagnostics,
		rankedDefinitions: analysis.rankedDefinitions,
		mapTokens,
		query: params.query,
	});
}

export async function buildRepoAnalysis(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: RepoMapOptions,
	signal?: AbortSignal,
): Promise<RepoAnalysis> {
	const root = params.root ? resolve(ctx.cwd, params.root) : await findProjectRoot(pi, ctx.cwd, signal);
	const maxFiles = clampInt(params.maxFiles ?? DEFAULT_MAX_FILES, 1, 25_000);
	const maxFileBytes = clampInt(params.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 1_000, 5 * 1024 * 1024);
	const sourceDiscovery = await listSourceFiles(pi, root, { maxFiles, maxFileBytes, include: params.include, exclude: params.exclude }, signal);
	const files = sourceDiscovery.files;
	const backendSignature = await getBackendSignature(pi, signal);
	const cached = await loadAnalysisCache(root, files, backendSignature, params);
	if (cached) {
		const rankedDefinitions = rankDefinitions(cached.definitionsByName, cached.referencesByName, splitQueryTerms(params.query), {
			query: params.query,
			preferPath: params.path,
		});
		return { ...cached, rankedDefinitions };
	}

	const lspDocumentSymbols = await extractLspDocumentSymbols(pi, files, signal);
	if (lspDocumentSymbols) {
		sourceDiscovery.diagnostics.lspDocumentSymbolsAvailable = true;
		sourceDiscovery.diagnostics.lspDocumentSymbolFiles = lspDocumentSymbols.byFile.size;
		sourceDiscovery.diagnostics.lspDocumentSymbolDefinitions = lspDocumentSymbols.definitionCount;
		sourceDiscovery.diagnostics.lspDocumentSymbolSkippedFiles = lspDocumentSymbols.skippedFiles;
	} else {
		sourceDiscovery.diagnostics.lspDocumentSymbolsAvailable = false;
	}

	const treeSitterTags = await extractTreeSitterTags(pi, root, files, signal);
	if (treeSitterTags) {
		sourceDiscovery.diagnostics.treeSitterTagsAvailable = true;
		sourceDiscovery.diagnostics.treeSitterTaggedFiles = treeSitterTags.byFile.size;
		sourceDiscovery.diagnostics.treeSitterTagDefinitions = treeSitterTags.definitionCount;
		sourceDiscovery.diagnostics.treeSitterTagReferences = treeSitterTags.referenceCount;
	} else {
		sourceDiscovery.diagnostics.treeSitterTagsAvailable = false;
	}

	const analyses = [] as RepoAnalysis["analyses"];
	const definitionsByName = new Map<string, Definition[]>();
	const referencesByName = new Map<string, Map<string, number>>();

	for (const file of files) {
		if (signal?.aborted) throw new Error("code_intel analysis cancelled");
		let text: string;
		try {
			text = await readFile(file.absPath, "utf8");
		} catch {
			continue;
		}


		if (looksBinary(text)) continue;

		const lspFileSymbols = lspDocumentSymbols?.byFile.get(file.relPath) ?? [];
		const treeSitterFileTags = treeSitterTags?.byFile.get(file.relPath);
		const definitions = mergeDefinitions(
			hydrateLspDocumentSymbols(file, text, lspFileSymbols),
			mergeDefinitions(hydrateTreeSitterDefinitions(file, text, treeSitterFileTags?.definitions ?? []), extractDefinitions(file, text)),
		);
		const references = treeSitterFileTags?.references.size ? treeSitterFileTags.references : extractReferences(text);
		analyses.push({ file, definitions, references, text });

		for (const definition of definitions) {
			const bucket = definitionsByName.get(definition.name) ?? [];
			bucket.push(definition);
			definitionsByName.set(definition.name, bucket);
		}

		for (const [name, count] of references) {
			const bucket = referencesByName.get(name) ?? new Map<string, number>();
			bucket.set(file.relPath, (bucket.get(file.relPath) ?? 0) + count);
			referencesByName.set(name, bucket);
		}
	}

	const rankedDefinitions = rankDefinitions(definitionsByName, referencesByName, splitQueryTerms(params.query), {
		query: params.query,
		preferPath: params.path,
	});
	const analysis = { root, files, diagnostics: sourceDiscovery.diagnostics, analyses, definitionsByName, referencesByName, rankedDefinitions };
	await saveAnalysisCache(root, files, backendSignature, analysis).catch(() => undefined);
	return analysis;
}

async function extractLspDocumentSymbols(
	pi: ExtensionAPI,
	files: SourceFile[],
	signal?: AbortSignal,
): Promise<{ byFile: Map<string, LspDocumentSymbol[]>; definitionCount: number; skippedFiles: number } | undefined> {
	const service = getLspService(pi);
	if (!service?.documentSymbols) return undefined;

	const candidates = files.filter((file) => !service.supportsFile || service.supportsFile(file.absPath));
	const skippedFiles = Math.max(0, candidates.length - MAX_LSP_DOCUMENT_SYMBOL_FILES);
	const byFile = new Map<string, LspDocumentSymbol[]>();
	let definitionCount = 0;

	for (const file of candidates.slice(0, MAX_LSP_DOCUMENT_SYMBOL_FILES)) {
		if (signal?.aborted) throw new Error("code_intel analysis cancelled");
		try {
			const symbols = await service.documentSymbols(file.absPath, { signal });
			const mappableSymbols = symbols.filter(isMappableLspDocumentSymbol);
			if (mappableSymbols.length === 0) continue;
			byFile.set(file.relPath, mappableSymbols);
			definitionCount += mappableSymbols.length;
		} catch {
			// LSP document symbols are an enhancement; tree-sitter/syntax fallback remains available.
		}
	}

	return { byFile, definitionCount, skippedFiles };
}

async function getBackendSignature(pi: ExtensionAPI, signal?: AbortSignal): Promise<string> {
	const treeSitter = await commandVersion(pi, "tree-sitter", ["--version"], signal);
	const lspDocumentSymbols = getLspService(pi)?.documentSymbols ? "available" : "missing";
	return `lsp-document-symbols:${lspDocumentSymbols};tree-sitter:${treeSitter.available ? treeSitter.version ?? "available" : "missing"};extractor:${CODE_INTEL_CACHE_VERSION}`;
}

async function loadAnalysisCache(
	root: string,
	files: SourceFile[],
	backendSignature: string,
	params: RepoMapOptions,
): Promise<Omit<RepoAnalysis, "rankedDefinitions"> | undefined> {
	if (params.path) return undefined;
	const cachePath = getAnalysisCachePath(root);
	let payload: CachedAnalysisPayload;
	try {
		payload = JSON.parse(await readFile(cachePath, "utf8")) as CachedAnalysisPayload;
	} catch {
		return undefined;
	}

	if (payload.version !== CODE_INTEL_CACHE_VERSION || payload.root !== root || payload.backendSignature !== backendSignature) return undefined;
	if (payload.fileSignature !== fileSignature(files)) return undefined;

	const analyses = payload.analyses.map((item) => ({
		file: item.file,
		definitions: item.definitions,
		references: new Map(item.references),
	}));
	const definitionsByName = new Map<string, Definition[]>();
	const referencesByName = new Map<string, Map<string, number>>();
	for (const analysis of analyses) {
		for (const definition of analysis.definitions) {
			const bucket = definitionsByName.get(definition.name) ?? [];
			bucket.push(definition);
			definitionsByName.set(definition.name, bucket);
		}
		for (const [name, count] of analysis.references) {
			const bucket = referencesByName.get(name) ?? new Map<string, number>();
			bucket.set(analysis.file.relPath, (bucket.get(analysis.file.relPath) ?? 0) + count);
			referencesByName.set(name, bucket);
		}
	}

	return {
		root,
		files,
		diagnostics: {
			unsupportedExtensions: new Map(payload.diagnostics.unsupportedExtensions),
			fallbackPatternLanguages: new Map(payload.diagnostics.fallbackPatternLanguages),
			treeSitterTagsAvailable: payload.diagnostics.treeSitterTagsAvailable,
			treeSitterTaggedFiles: payload.diagnostics.treeSitterTaggedFiles,
			treeSitterTagDefinitions: payload.diagnostics.treeSitterTagDefinitions,
			treeSitterTagReferences: payload.diagnostics.treeSitterTagReferences,
			lspDocumentSymbolsAvailable: payload.diagnostics.lspDocumentSymbolsAvailable,
			lspDocumentSymbolFiles: payload.diagnostics.lspDocumentSymbolFiles,
			lspDocumentSymbolDefinitions: payload.diagnostics.lspDocumentSymbolDefinitions,
			lspDocumentSymbolSkippedFiles: payload.diagnostics.lspDocumentSymbolSkippedFiles,
		},
		analyses,
		definitionsByName,
		referencesByName,
	};
}

async function saveAnalysisCache(root: string, files: SourceFile[], backendSignature: string, analysis: RepoAnalysis): Promise<void> {
	const cachePath = getAnalysisCachePath(root);
	await mkdir(dirname(cachePath), { recursive: true });
	const payload: CachedAnalysisPayload = {
		version: CODE_INTEL_CACHE_VERSION,
		root,
		backendSignature,
		fileSignature: fileSignature(files),
		diagnostics: {
			unsupportedExtensions: Array.from(analysis.diagnostics.unsupportedExtensions),
			fallbackPatternLanguages: Array.from(analysis.diagnostics.fallbackPatternLanguages),
			treeSitterTagsAvailable: analysis.diagnostics.treeSitterTagsAvailable,
			treeSitterTaggedFiles: analysis.diagnostics.treeSitterTaggedFiles,
			treeSitterTagDefinitions: analysis.diagnostics.treeSitterTagDefinitions,
			treeSitterTagReferences: analysis.diagnostics.treeSitterTagReferences,
			lspDocumentSymbolsAvailable: analysis.diagnostics.lspDocumentSymbolsAvailable,
			lspDocumentSymbolFiles: analysis.diagnostics.lspDocumentSymbolFiles,
			lspDocumentSymbolDefinitions: analysis.diagnostics.lspDocumentSymbolDefinitions,
			lspDocumentSymbolSkippedFiles: analysis.diagnostics.lspDocumentSymbolSkippedFiles,
		},
		analyses: analysis.analyses.map((item) => ({
			file: item.file,
			definitions: item.definitions.map((definition) => ({ ...definition, score: 0 })),
			references: Array.from(item.references),
		})),
	};
	await writeFile(cachePath, JSON.stringify(payload), "utf8");
}

function getAnalysisCachePath(root: string): string {
	const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	const rootHash = createHash("sha256").update(root).digest("hex").slice(0, 24);
	return join(cacheRoot, "pi-code-intel", rootHash, `analysis-v${CODE_INTEL_CACHE_VERSION}.json`);
}

function fileSignature(files: SourceFile[]): string {
	const input = files
		.map((file) => `${file.relPath}\0${file.size}\0${file.mtimeMs ?? 0}\0${file.language}`)
		.sort()
		.join("\n");
	return createHash("sha256").update(input).digest("hex");
}

function splitQueryTerms(query?: string): Set<string> {
	if (!query) return new Set();
	return new Set(query.split(/[^A-Za-z0-9_.$/-]+/).filter((term) => term.length >= 2));
}

function rankDefinitions(
	definitionsByName: Map<string, Definition[]>,
	referencesByName: Map<string, Map<string, number>>,
	queryTerms: Set<string>,
	context?: { query?: string; preferPath?: string },
): Definition[] {
	const ranked: Definition[] = [];
	const queryLower = context?.query?.trim().toLowerCase();
	const queryWantsTests = Boolean(queryLower && /\btest\b|_test|\.test\./.test(queryLower));
	const preferPath = context?.preferPath ? context.preferPath.toLowerCase() : undefined;
	for (const [name, definitions] of definitionsByName) {
		const references = referencesByName.get(name) ?? new Map<string, number>();
		const definitionFiles = new Set(definitions.map((definition) => definition.file));
		let totalRefs = 0;
		let externalFiles = 0;
		for (const [file, count] of references) {
			totalRefs += count;
			if (!definitionFiles.has(file)) externalFiles++;
		}

		for (const definition of definitions) {
			let score = 1;
			score += Math.sqrt(totalRefs);
			score += externalFiles * 2;
			if (["class", "interface", "type", "struct", "trait", "protocol"].includes(definition.kind)) score += 3;
			if (["function", "method"].includes(definition.kind)) score += 1.5;
			if (isMeaningfulIdentifier(name)) score *= 1.4;
			if (name.startsWith("_")) score *= 0.2;
			if (definitions.length > 5) score *= 0.35;
			if (matchesQuery(definition, queryTerms)) score *= 12;

			const defNameLower = definition.name.toLowerCase();
			if (queryLower && defNameLower === queryLower) score *= 20;
			else if (queryLower && defNameLower.includes(queryLower)) score *= 4;

			if (preferPath && definition.file.toLowerCase().includes(preferPath)) score *= 4;
			if (!queryWantsTests && isTestFile(definition.file)) score *= 0.4;
			if (definition.declaration) score *= 0.85;

			definition.score = score;
			ranked.push(definition);
		}
	}
	return ranked.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
}

function isMeaningfulIdentifier(name: string): boolean {
	return name.length >= 8 && (name.includes("_") || name.includes("-") || /[a-z][A-Z]/.test(name) || /[A-Z][a-z]/.test(name));
}

function matchesQuery(definition: Definition, queryTerms: Set<string>): boolean {
	if (queryTerms.size === 0) return false;
	const haystack = `${definition.name} ${definition.file} ${definition.kind}`.toLowerCase();
	for (const term of queryTerms) {
		if (haystack.includes(term.toLowerCase())) return true;
	}
	return false;
}

function isTestFile(path: string): boolean {
	const lower = path.toLowerCase();
	return lower.includes("/test/") || lower.includes("/__tests__/") || lower.endsWith("_test.go") || lower.includes(".test.") || lower.includes(".spec.");
}

export function renderScanDiagnostics(diagnostics: SourceScanDiagnostics, analyzedSourceFiles: number): string[] {
	const notes: string[] = [];
	const unsupportedTotal = mapTotal(diagnostics.unsupportedExtensions);
	if (unsupportedTotal > 0 && analyzedSourceFiles === 0) {
		notes.push(`No supported source files were analyzed. Unsupported extensions in scope: ${formatCountBreakdown(diagnostics.unsupportedExtensions)}.`);
	}

	if (diagnostics.lspDocumentSymbolsAvailable) {
		const skipped = diagnostics.lspDocumentSymbolSkippedFiles ? `; skipped ${diagnostics.lspDocumentSymbolSkippedFiles} file(s) over LSP cap` : "";
		notes.push(
			`LSP document symbols: ${diagnostics.lspDocumentSymbolDefinitions ?? 0} definition(s) from ${diagnostics.lspDocumentSymbolFiles ?? 0} file(s)${skipped}.`,
		);
	} else {
		notes.push("LSP document symbols: unavailable; using Tree-sitter/syntax fallback for structure.");
	}

	if (diagnostics.treeSitterTagsAvailable) {
		notes.push(
			`Tree-sitter tags: ${diagnostics.treeSitterTagDefinitions ?? 0} definition(s), ${diagnostics.treeSitterTagReferences ?? 0} reference(s) from ${diagnostics.treeSitterTaggedFiles ?? 0} file(s).`,
		);
	} else {
		notes.push("Tree-sitter tags: unavailable or not configured; using syntax-pattern fallback where possible.");
	}

	const fallbackTotal = mapTotal(diagnostics.fallbackPatternLanguages);
	if (fallbackTotal > 0) {
		notes.push(`Limited extraction for languages using generic fallback patterns: ${formatCountBreakdown(diagnostics.fallbackPatternLanguages, " file(s)")}.`);
	}

	return notes;
}

function mapTotal(map: Map<string, number>): number {
	let total = 0;
	for (const count of map.values()) total += count;
	return total;
}

function formatCountBreakdown(map: Map<string, number>, countSuffix = ""): string {
	const sorted = Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const shown = sorted.slice(0, 6).map(([name, count]) => `${name} (${count}${countSuffix})`);
	const remaining = sorted.length - shown.length;
	if (remaining > 0) shown.push(`+${remaining} more`);
	return shown.join(", ");
}

function renderRepoMap(args: {
	root: string;
	files: SourceFile[];
	diagnostics: SourceScanDiagnostics;
	rankedDefinitions: Definition[];
	mapTokens: number;
	query?: string;
}): string {
	const budgetChars = args.mapTokens * 4;
	const selected = new Map<string, Definition[]>();
	const maxSymbols = Math.min(args.rankedDefinitions.length, Math.max(20, Math.floor(args.mapTokens / 12)));

	for (const definition of args.rankedDefinitions.slice(0, maxSymbols * 2)) {
		const bucket = selected.get(definition.file) ?? [];
		if (bucket.length >= 12) continue;
		bucket.push(definition);
		selected.set(definition.file, bucket);
		if (Array.from(selected.values()).reduce((sum, defs) => sum + defs.length, 0) >= maxSymbols) break;
	}

	const rankedFiles = Array.from(selected.entries()).sort((a, b) => maxScore(b[1]) - maxScore(a[1]) || a[0].localeCompare(b[0]));
	const header = [
		`Repo map for ${args.root}`,
		`Generated by code-intel structural backend (LSP document symbols when available, then Tree-sitter tags, then syntax fallback; approximate).`,
		`Scanned ${args.files.length} source file(s); found ${args.rankedDefinitions.length} definition(s).`,
		...renderScanDiagnostics(args.diagnostics, args.files.length),
		args.query ? `Query bias: ${args.query}` : undefined,
		"Use this to choose targeted files/ranges to inspect with read before editing.",
		"",
	]
		.filter(Boolean)
		.join("\n");

	let output = header;
	let includedSymbols = 0;
	let includedFiles = 0;
	for (const [file, definitions] of rankedFiles) {
		const block = renderFileBlock(file, definitions.sort((a, b) => a.line - b.line));
		if (output.length + block.length > budgetChars && includedFiles > 0) break;
		output += block;
		includedSymbols += definitions.length;
		includedFiles++;
	}

	if (includedSymbols === 0) {
		output += "No symbols found. Try increasing maxFiles/maxFileBytes or check backend status with code_intel action=status.\n";
	} else if (includedSymbols < args.rankedDefinitions.length) {
		output += `\n⋮...\n[Map truncated to ~${args.mapTokens} tokens: showing ${includedSymbols} of ${args.rankedDefinitions.length} ranked definitions from ${includedFiles} file(s).]\n`;
	}

	return output;
}

function maxScore(definitions: Definition[]): number {
	return definitions.reduce((max, definition) => Math.max(max, definition.score), 0);
}

function renderFileBlock(file: string, definitions: Definition[]): string {
	let out = `\n${file}:\n`;
	let lastLine = -10;
	const seen = new Set<string>();
	for (const definition of definitions) {
		if (definition.line - lastLine > 2) out += "⋮...\n";
		for (let offset = 0; offset < definition.signatureLines.length; offset++) {
			const lineNumber = definition.line + offset + 1;
			const text = definition.signatureLines[offset];
			const key = `${lineNumber}:${text}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const backendMarker = offset === 0 && definition.backend === "lsp-document-symbol" ? "  # lsp" : offset === 0 && definition.backend === "tree-sitter-tags" ? "  # tree-sitter" : "";
			out += `${String(lineNumber).padStart(5, " ")} │${text}${backendMarker}\n`;
			lastLine = definition.line + offset;
		}
	}
	return out;
}

export const __analysisTest = {
	rankDefinitions,
	renderRepoMap,
	renderScanDiagnostics,
};
