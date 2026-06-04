import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { EXT_TO_LANGUAGE, LANGUAGE_SPECIFIC_PATTERN_SUPPORT } from "./constants";
import { buildRepoAnalysis, generateRepoMapOutput, renderScanDiagnostics } from "./analysis";
import { extractImportLines, findEnclosingDefinition, getDefinitionEnd } from "./extractors";
import { clampInt } from "./helpers";
import { formatLspLocations, formatRelativeLocation, getLspService, identifierAtPosition, type LspManagerService, type LspPosition } from "./lsp";
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
		`- active backend: LSP document symbols when available; ${treeSitter.available ? "tree-sitter tags when queries/parsers are configured, with syntax-pattern fallback" : "syntax-pattern fallback"}`,
		`- LSP manager: ${formatLspStatus(pi)}`,
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

function formatLspStatus(pi: ExtensionAPI): string {
	const service = getLspService(pi);
	if (!service) return "not available (load lsp-manager for definition/references/hover)";
	return service.documentSymbols
		? "available for semantic lookups and document symbols"
		: "available for semantic lookups; document symbols unavailable";
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
	const imports = extractImportLines(lines, file.language);
	const out = [
		`Outline for ${file.relPath}`,
		`Root: ${root}`,
		`Language: ${file.language}; ${lines.length} line(s); ${formatSize(file.size)}`,
		formatBackendSummary(definitions),
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
		const endLine = getDefinitionEnd(definition, lines, file.language);
		const declarationMarker = definition.declaration ? " [declaration]" : "";
		out.push(
			`${String(definition.line + 1).padStart(5, " ")}-${String(endLine + 1).padStart(5, " ")} │${definition.kind.padEnd(16)} ${definition.name}${declarationMarker}${definition.backend ? ` [${definition.backend}]` : ""}`,
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
	const parsedQuery = parseSymbolQuery(query);
	const analysis = await buildRepoAnalysis(pi, ctx, params, signal);
	const matches = analysis.rankedDefinitions.filter((definition) => matchesSymbolQuery(definition, parsedQuery));

	const out = [
		query ? `Symbols matching "${query}"` : "Top ranked symbols",
		`Root: ${analysis.root}`,
		parsedQuery.filters.length > 0 ? `Applied filters: ${parsedQuery.filters.join(", ")}.` : undefined,
		`Showing ${Math.min(matches.length, limit)} of ${matches.length} match(es).`,
		...renderScanDiagnostics(analysis.diagnostics, analysis.files.length),
		"",
	].filter(Boolean) as string[];

	for (const definition of matches.slice(0, limit)) {
		const declarationMarker = definition.declaration ? " declaration" : "";
		out.push(
			`${definition.file}:${definition.line + 1}:${definition.column + 1} │ ${definition.kind}${declarationMarker} ${definition.name} │ score ${definition.score.toFixed(2)}${definition.backend ? ` │ ${definition.backend}` : ""}`,
		);
		out.push(`  ${definition.signatureLines[0]?.trim() ?? definition.text.trim()}`);
	}
	return out.join("\n");
}

interface ParsedSymbolQuery {
	text: string;
	name?: string;
	kind?: string;
	file?: string;
	declaration?: boolean;
	backend?: "lsp-document-symbol" | "tree-sitter-tags" | "syntax-pattern";
	filters: string[];
}

function parseSymbolQuery(query: string): ParsedSymbolQuery {
	let rest = query.trim();
	const parsed: ParsedSymbolQuery = { text: "", filters: [] };

	const nameMatch = rest.match(/(?:^|\s)name:([^\s]+)/i);
	const nameValue = nameMatch?.[1];
	if (nameMatch && nameValue !== undefined) {
		parsed.name = nameValue.replace(/^"|"$/g, "").toLowerCase();
		parsed.filters.push(`name=${nameValue}`);
		rest = rest.replace(nameMatch[0], " ").trim();
	}

	const kindMatch = rest.match(/(?:^|\s)kind:([^\s]+)/i);
	const kindValue = kindMatch?.[1];
	if (kindMatch && kindValue !== undefined) {
		parsed.kind = kindValue.replace(/^"|"$/g, "").toLowerCase();
		parsed.filters.push(`kind=${kindValue}`);
		rest = rest.replace(kindMatch[0], " ").trim();
	}

	const fileMatch = rest.match(/(?:^|\s)file:([^\s]+)/i);
	const fileValue = fileMatch?.[1];
	if (fileMatch && fileValue !== undefined) {
		parsed.file = fileValue.replace(/^"|"$/g, "").toLowerCase();
		parsed.filters.push(`file=${fileValue}`);
		rest = rest.replace(fileMatch[0], " ").trim();
	}

	const declMatch = rest.match(/(?:^|\s)decl:(true|false|1|0|yes|no)/i);
	const declValue = declMatch?.[1];
	if (declMatch && declValue !== undefined) {
		parsed.declaration = ["true", "1", "yes"].includes(declValue.toLowerCase());
		parsed.filters.push(`decl=${declValue}`);
		rest = rest.replace(declMatch[0], " ").trim();
	}

	const backendMatch = rest.match(/(?:^|\s)backend:(lsp|tree|tree-sitter|syntax|lsp-document-symbol|tree-sitter-tags|syntax-pattern)/i);
	const backendValue = backendMatch?.[1];
	if (backendMatch && backendValue !== undefined) {
		const raw = backendValue.toLowerCase();
		parsed.backend = raw.startsWith("lsp") ? "lsp-document-symbol" : raw.startsWith("tree") ? "tree-sitter-tags" : "syntax-pattern";
		parsed.filters.push(`backend=${backendValue}`);
		rest = rest.replace(backendMatch[0], " ").trim();
	}

	parsed.text = rest.toLowerCase();
	return parsed;
}

function matchesSymbolQuery(definition: Definition, query: ParsedSymbolQuery): boolean {
	if (query.kind && definition.kind.toLowerCase() !== query.kind) return false;
	if (query.name && definition.name.toLowerCase() !== query.name && !definition.name.toLowerCase().includes(query.name)) return false;
	if (query.file && !definition.file.toLowerCase().includes(query.file)) return false;
	if (query.declaration !== undefined && isDeclaration(definition) !== query.declaration) return false;
	if (query.backend && definition.backend !== query.backend) return false;
	if (!query.text) return true;
	const haystack = `${definition.name} ${definition.kind} ${definition.file}`.toLowerCase();
	return haystack.includes(query.text);
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

	const sliceMode = normalizeSliceMode(params.sliceMode);
	let target: { file: SourceFile; text: string; definition: Definition } | undefined;
	let loadedDefinitions: Definition[] | undefined;
	if (loaded && typeof loaded !== "string") {
		loadedDefinitions = await extractDefinitionsForLoadedSource(pi, loaded.root, loaded.file, loaded.text, signal);
		target = chooseDefinition(loadedDefinitions, loaded.file, loaded.text, params, sliceMode);
	} else {
		const analysis = await buildRepoAnalysis(pi, ctx, params, signal);
		const symbolLower = (params.symbol ?? "").toLowerCase();
		const candidates = filterBySliceMode(
			analysis.rankedDefinitions.filter((definition) => definition.name.toLowerCase() === symbolLower || definition.name.toLowerCase().includes(symbolLower)),
			sliceMode,
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
		if (fallback) {
			const reference = chooseReferenceDeclaration(loadedDefinitions, params.symbol);
			const links = await renderImplementationLinks(pi, ctx, params, params.symbol, signal, {
				excludeFile: loaded.file.relPath,
				reference,
			});
			return links ? `${fallback}\n\n${links}` : fallback;
		}
	}

	if (!target) return `No matching symbol found${params.symbol ? ` for "${params.symbol}"` : ""} (sliceMode=${sliceMode}).`;
	const lines = target.text.split(/\r?\n/);
	const endLine = getDefinitionEnd(target.definition, lines, target.file.language);
	const slice = lines.slice(target.definition.line, endLine + 1).join("\n");
	const declarationMarker = target.definition.declaration ? " declaration" : "";
	const header = `${target.file.relPath}:${target.definition.line + 1}-${endLine + 1} │ ${target.definition.kind}${declarationMarker} ${target.definition.name}${target.definition.backend ? ` │ ${target.definition.backend}` : ""}`;
	const summary = loadedDefinitions ? formatBackendSummary(loadedDefinitions) : formatBackendSummary([target.definition]);

	const links = target.definition.declaration && params.symbol
		? await renderImplementationLinks(pi, ctx, params, params.symbol, signal, {
				excludeFile: target.file.relPath,
				excludeLine: target.definition.line,
				reference: target.definition,
			})
		: undefined;

	return [header, summary, "", slice, links ? `\n${links}` : undefined].filter(Boolean).join("\n");
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
		`${enclosing.definition.kind} ${enclosing.definition.name}${enclosing.definition.declaration ? " (declaration)" : ""}${enclosing.definition.backend ? ` (${enclosing.definition.backend})` : ""}`,
		`range: ${enclosing.definition.line + 1}-${enclosing.endLine + 1}`,
		`signature: ${enclosing.definition.signatureLines.map((line) => line.trim()).join(" ")}`,
	].join("\n");
}

export async function findDefinitionWithLsp(pi: ExtensionAPI, ctx: ExtensionContext, params: RepoMapOptions, signal?: AbortSignal): Promise<string> {
	const request = await getLspLookupRequest(pi, ctx, params, "definition", signal);
	if (typeof request === "string") return request;
	const locations = await request.service.definition(request.path, request.position, { signal });
	return formatLspLocations(ctx.cwd, `LSP definition for ${formatLspLookupTarget(ctx.cwd, request)}`, locations);
}

export async function findReferencesWithLsp(pi: ExtensionAPI, ctx: ExtensionContext, params: RepoMapOptions, signal?: AbortSignal): Promise<string> {
	const request = await getLspLookupRequest(pi, ctx, params, "references", signal);
	if (typeof request === "string") return request;
	const locations = await request.service.references(request.path, request.position, { signal });
	return formatLspLocations(ctx.cwd, `LSP references for ${formatLspLookupTarget(ctx.cwd, request)}`, locations);
}

export async function findHoverWithLsp(pi: ExtensionAPI, ctx: ExtensionContext, params: RepoMapOptions, signal?: AbortSignal): Promise<string> {
	const request = await getLspLookupRequest(pi, ctx, params, "hover", signal);
	if (typeof request === "string") return request;
	const hover = await request.service.hover(request.path, request.position, { signal });
	if (!hover) return `No LSP hover found for ${formatLspLookupTarget(ctx.cwd, request)}.`;
	return [
		`LSP hover for ${request.symbol ? `${request.symbol} at ` : ""}${formatRelativeLocation(ctx.cwd, hover.file, hover.line, hover.column)}`,
		"",
		hover.contents,
	].join("\n");
}

interface LspLookupRequest {
	service: LspManagerService;
	path: string;
	position: LspPosition;
	symbol?: string;
}

async function getLspLookupRequest(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: RepoMapOptions,
	action: "definition" | "references" | "hover",
	signal?: AbortSignal,
): Promise<LspLookupRequest | string> {
	const service = getLspService(pi);
	if (!service) return `code_intel ${action} requires lsp-manager to be loaded.`;

	const symbol = params.symbol?.trim();
	if (symbol) {
		return resolveLspSymbolRequest(pi, ctx, params, service, symbol, action, signal);
	}

	if (!params.path || !params.line || !params.column) {
		return `code_intel ${action} requires symbol or path with 1-based line and column.`;
	}

	const path = resolve(ctx.cwd, params.path);
	const position = { line: Math.floor(params.line), column: Math.floor(params.column) };
	return { service, path, position, symbol: await readIdentifierAtPosition(path, position) };
}

async function resolveLspSymbolRequest(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: RepoMapOptions,
	service: LspManagerService,
	symbol: string,
	action: "definition" | "references" | "hover",
	signal?: AbortSignal,
): Promise<LspLookupRequest | string> {
	if (params.path) {
		const loaded = await loadRequestedSourceFile(pi, ctx, params, signal);
		if (typeof loaded === "string") return loaded;
		if (service.supportsFile && !service.supportsFile(loaded.file.absPath)) {
			return `code_intel ${action} cannot use LSP for unsupported file ${loaded.file.relPath}.`;
		}
		const definitions = await extractDefinitionsForLoadedSource(pi, loaded.root, loaded.file, loaded.text, signal);
		const definition = chooseSymbolDefinition(definitions, symbol);
		if (!definition) return `No matching symbol found for "${symbol}" in ${loaded.file.relPath}.`;
		return { service, path: loaded.file.absPath, position: positionForDefinition(definition, loaded.text, symbol), symbol: definition.name };
	}

	const analysis = await buildRepoAnalysis(pi, ctx, { ...params, query: symbol }, signal);
	const lspSupportedDefinitions = service.supportsFile
		? analysis.rankedDefinitions.filter((definition) => service.supportsFile?.(resolve(analysis.root, definition.file)) ?? true)
		: analysis.rankedDefinitions;
	const definition = chooseSymbolDefinition(lspSupportedDefinitions, symbol);
	if (!definition) return `No matching LSP-supported symbol found for "${symbol}".`;
	const fileAnalysis = analysis.analyses.find((item) => item.file.relPath === definition.file);
	const text = fileAnalysis?.text ?? (fileAnalysis ? await readFile(fileAnalysis.file.absPath, "utf8") : "");
	return {
		service,
		path: fileAnalysis ? fileAnalysis.file.absPath : resolve(analysis.root, definition.file),
		position: positionForDefinition(definition, text, symbol),
		symbol: definition.name,
	};
}

function chooseSymbolDefinition(definitions: Definition[], symbol: string): Definition | undefined {
	const lower = symbol.toLowerCase();
	return (
		definitions.find((definition) => definition.name.toLowerCase() === lower) ??
		definitions.find((definition) => definition.name.toLowerCase().includes(lower))
	);
}

function positionForDefinition(definition: Definition, text: string, symbol: string): LspPosition {
	const line = definition.line + 1;
	const lines = text.split(/\r?\n/);
	const column = findSymbolColumn(lines[definition.line] ?? "", definition.name || symbol) ?? definition.column + 1;
	return { line, column };
}

function findSymbolColumn(line: string, symbol: string): number | undefined {
	if (!symbol) return undefined;
	const match = line.match(new RegExp(`\\b${escapeRegExp(symbol)}\\b`));
	return match?.index == null ? undefined : match.index + 1;
}

async function readIdentifierAtPosition(path: string, position: LspPosition): Promise<string | undefined> {
	try {
		return identifierAtPosition(await readFile(path, "utf8"), position.line, position.column);
	} catch {
		return undefined;
	}
}

function formatLspLookupTarget(cwd: string, request: LspLookupRequest): string {
	const location = formatRelativeLocation(cwd, request.path, request.position.line, request.position.column);
	return request.symbol ? `${request.symbol} at ${location}` : location;
}

function chooseDefinition(
	definitions: Definition[],
	file: SourceFile,
	text: string,
	params: RepoMapOptions,
	sliceMode: "implementation" | "declaration" | "any",
): { file: SourceFile; text: string; definition: Definition } | undefined {
	const scoped = filterBySliceMode(definitions, sliceMode);
	if (params.line) {
		const lines = text.split(/\r?\n/);
		const zeroLine = Math.max(0, Math.floor(params.line) - 1);
		const enclosing = findEnclosingDefinition(scoped, lines, zeroLine, file.language);
		if (enclosing) return { file, text, definition: enclosing.definition };
	}
	const symbol = params.symbol?.toLowerCase();
	const definition = symbol
		? scoped.find((item) => item.name.toLowerCase() === symbol) ?? scoped.find((item) => item.name.toLowerCase().includes(symbol))
		: scoped[0];
	return definition ? { file, text, definition } : undefined;
}

function filterBySliceMode(definitions: Definition[], sliceMode: "implementation" | "declaration" | "any"): Definition[] {
	if (sliceMode === "any") return definitions;
	if (sliceMode === "declaration") return definitions.filter(isDeclaration);
	return definitions.filter((definition) => !isDeclaration(definition));
}

function normalizeSliceMode(mode?: string): "implementation" | "declaration" | "any" {
	if (mode === "implementation" || mode === "declaration" || mode === "any") return mode;
	return "any";
}

function isDeclaration(definition: Definition): boolean {
	return Boolean(definition.declaration) || definition.kind === "interface_method";
}

function formatBackendSummary(definitions: Definition[]): string {
	const lsp = definitions.filter((definition) => definition.backend === "lsp-document-symbol").length;
	const tree = definitions.filter((definition) => definition.backend === "tree-sitter-tags").length;
	const syntax = definitions.filter((definition) => definition.backend === "syntax-pattern").length;
	const declarations = definitions.filter(isDeclaration).length;
	return `Backend summary: lsp=${lsp}, tree-sitter=${tree}, syntax-pattern=${syntax}, declarations=${declarations}.`;
}

interface ImplementationLinkOptions {
	excludeFile?: string;
	excludeLine?: number;
	reference?: Definition;
}

async function renderImplementationLinks(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: RepoMapOptions,
	symbol: string,
	signal: AbortSignal | undefined,
	options?: ImplementationLinkOptions,
): Promise<string | undefined> {
	const analysis = await buildRepoAnalysis(pi, ctx, { ...params, path: undefined, query: symbol }, signal);
	const lower = symbol.toLowerCase();
	const referenceArity = options?.reference ? inferCallableArity(options.reference) : undefined;
	const preferredDir = options?.excludeFile ? dirname(options.excludeFile) : undefined;

	const scored = analysis.rankedDefinitions
		.filter((definition) => definition.name.toLowerCase() === lower)
		.filter((definition) => ["method", "function"].includes(definition.kind))
		.filter((definition) => !isDeclaration(definition))
		.filter((definition) => !(definition.file === options?.excludeFile && definition.line === options?.excludeLine))
		.map((definition) => {
			let score = definition.score;
			const notes: string[] = [];
			const arity = inferCallableArity(definition);
			if (referenceArity !== undefined && arity !== undefined) {
				if (arity === referenceArity) {
					score += 1000;
					notes.push(`arity=${arity}`);
				} else {
					score -= 250;
				}
			}
			if (preferredDir && definition.file.startsWith(`${preferredDir}/`)) {
				score += 200;
				notes.push("same-dir");
			}
			return { definition, score, notes };
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, 8);

	if (scored.length === 0) return;
	const out = [`Likely implementations for ${symbol}:`];
	for (const item of scored) {
		const noteText = item.notes.length > 0 ? ` │ ${item.notes.join(",")}` : "";
		out.push(
			`- ${item.definition.file}:${item.definition.line + 1}:${item.definition.column + 1} │ ${item.definition.kind} ${item.definition.name}${item.definition.backend ? ` │ ${item.definition.backend}` : ""}${noteText}`,
		);
	}
	return out.join("\n");
}

function chooseReferenceDeclaration(definitions: Definition[], symbol: string): Definition | undefined {
	const lower = symbol.toLowerCase();
	return definitions.find((definition) => definition.name.toLowerCase() === lower && isDeclaration(definition));
}

function inferCallableArity(definition: Definition): number | undefined {
	const signature = definition.signatureLines[0] ?? definition.text;
	if (!signature) return;
	const groups = collectParenthesizedGroups(signature);
	if (groups.length === 0) return;

	let paramsText = groups[0] ?? "";
	if (definition.kind === "method" && signature.trimStart().startsWith("func ") && groups.length >= 2) {
		paramsText = groups[1] ?? "";
	}
	if (definition.kind === "interface_method" && groups.length >= 1) {
		paramsText = groups[0] ?? "";
	}

	const parts = splitTopLevel(paramsText, ",").map((part) => part.trim()).filter(Boolean);
	return parts.length;
}

function collectParenthesizedGroups(text: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = "";
	for (const char of text) {
		if (char === "(") {
			if (depth > 0) current += char;
			depth++;
			continue;
		}
		if (char === ")") {
			depth--;
			if (depth === 0) {
				out.push(current);
				current = "";
				continue;
			}
		}
		if (depth > 0) current += char;
	}
	return out;
}

function splitTopLevel(text: string, delimiter: string): string[] {
	const parts: string[] = [];
	let current = "";
	let paren = 0;
	let bracket = 0;
	let brace = 0;
	for (const char of text) {
		if (char === "(") paren++;
		if (char === ")") paren = Math.max(0, paren - 1);
		if (char === "[") bracket++;
		if (char === "]") bracket = Math.max(0, bracket - 1);
		if (char === "{") brace++;
		if (char === "}") brace = Math.max(0, brace - 1);
		if (char === delimiter && paren === 0 && bracket === 0 && brace === 0) {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) parts.push(current);
	return parts;
}

export function renderTextMatchFallback(file: SourceFile, text: string, definitions: Definition[], symbol: string): string | undefined {
	const matches = findIdentifierLineMatches(text.split(/\r?\n/), symbol);
	if (matches.length === 0) return;

	const lines = text.split(/\r?\n/);
	const out = [
		`No extracted symbol found for "${symbol}".`,
		`Text match fallback: found ${matches.length} identifier match(es) in ${file.relPath}.`,
		formatBackendSummary(definitions),
		"",
	];
	const renderedRanges = new Set<string>();

	for (const match of matches.slice(0, 3)) {
		const enclosing = findEnclosingDefinition(definitions, lines, match.line, file.language);
		if (enclosing) {
			const rangeKey = `${enclosing.definition.line}:${enclosing.endLine}`;
			if (renderedRanges.has(rangeKey)) continue;
			renderedRanges.add(rangeKey);
			const declarationMarker = enclosing.definition.declaration ? " declaration" : "";
			out.push(
				`${file.relPath}:${enclosing.definition.line + 1}-${enclosing.endLine + 1} │ enclosing ${enclosing.definition.kind}${declarationMarker} ${enclosing.definition.name}${enclosing.definition.backend ? ` │ ${enclosing.definition.backend}` : ""}`,
			);
			if (enclosing.definition.kind === "interface_method" && enclosing.definition.container) {
				out.push(`declared in interface ${enclosing.definition.container}`);
			}
			out.push(`matched line ${match.line + 1}: ${lines[match.line]?.trimEnd() ?? ""}`);
			out.push("");
			out.push(lines.slice(enclosing.definition.line, enclosing.endLine + 1).join("\n"));
			if (enclosing.definition.kind === "interface_method" && enclosing.definition.container) {
				const containerDef = definitions.find(
					(definition) => definition.kind === "type" && definition.name === enclosing.definition.container,
				);
				if (containerDef) {
					const containerEnd = getDefinitionEnd(containerDef, lines, file.language);
					out.push("");
					out.push(`${file.relPath}:${containerDef.line + 1}-${containerEnd + 1} │ container type ${containerDef.name}`);
					out.push(lines.slice(containerDef.line, containerEnd + 1).join("\n"));
				}
			}
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
		const line = lines[i];
		if (line === undefined) continue;
		const match = line.match(re);
		if (!match || match.index === undefined) continue;
		matches.push({ line: i, column: match.index + (match[1]?.length ?? 0) });
	}
	return matches;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const __actionsTest = {
	filterBySliceMode,
	isDeclaration,
	formatBackendSummary,
	normalizeSliceMode,
	parseSymbolQuery,
	matchesSymbolQuery,
	inferCallableArity,
	chooseReferenceDeclaration,
	formatLspLocations,
};
