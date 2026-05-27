import { readFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { EXT_TO_LANGUAGE, LANGUAGE_SPECIFIC_PATTERN_SUPPORT } from "./constants";
import { buildRepoAnalysis, generateRepoMapOutput, renderScanDiagnostics } from "./analysis";
import { extractImportLines, findEnclosingDefinition, getDefinitionEnd } from "./extractors";
import { clampInt } from "./helpers";
import { findProjectRoot, loadRequestedSourceFile } from "./source-files";
import { commandVersion, extractDefinitionsForLoadedSource } from "./tree-sitter";
import type { Definition, RepoMapOptions, SourceFile } from "./types";

const LSP_MANAGER_SERVICE_KEY = "lsp-manager:service";

interface LspPosition {
	line: number;
	column: number;
}

interface LspLocation {
	file: string;
	line: number;
	column: number;
	endLine?: number;
	endColumn?: number;
}

interface LspHoverInfo {
	file: string;
	line: number;
	column: number;
	contents: string;
}

interface LspManagerService {
	definition(filePath: string, position: LspPosition): Promise<LspLocation[]>;
	references(filePath: string, position: LspPosition): Promise<LspLocation[]>;
	hover(filePath: string, position: LspPosition): Promise<LspHoverInfo | undefined>;
}

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
		`- LSP manager: ${getLspService(pi) ? "available for semantic lookups" : "not available (load lsp-manager for definition/references/hover)"}`,
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

function getLspService(pi: ExtensionAPI): LspManagerService | undefined {
	const registry = pi.events as unknown as Record<string, unknown>;
	const service = registry[LSP_MANAGER_SERVICE_KEY];
	if (!service || typeof service !== "object") return undefined;
	const candidate = service as Partial<LspManagerService>;
	if (
		typeof candidate.definition === "function" &&
		typeof candidate.references === "function" &&
		typeof candidate.hover === "function"
	) {
		return candidate as LspManagerService;
	}
	return undefined;
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
	backend?: "tree-sitter-tags" | "syntax-pattern";
	filters: string[];
}

function parseSymbolQuery(query: string): ParsedSymbolQuery {
	let rest = query.trim();
	const parsed: ParsedSymbolQuery = { text: "", filters: [] };

	const nameMatch = rest.match(/(?:^|\s)name:([^\s]+)/i);
	if (nameMatch) {
		parsed.name = nameMatch[1].replace(/^"|"$/g, "").toLowerCase();
		parsed.filters.push(`name=${nameMatch[1]}`);
		rest = rest.replace(nameMatch[0], " ").trim();
	}

	const kindMatch = rest.match(/(?:^|\s)kind:([^\s]+)/i);
	if (kindMatch) {
		parsed.kind = kindMatch[1].replace(/^"|"$/g, "").toLowerCase();
		parsed.filters.push(`kind=${kindMatch[1]}`);
		rest = rest.replace(kindMatch[0], " ").trim();
	}

	const fileMatch = rest.match(/(?:^|\s)file:([^\s]+)/i);
	if (fileMatch) {
		parsed.file = fileMatch[1].replace(/^"|"$/g, "").toLowerCase();
		parsed.filters.push(`file=${fileMatch[1]}`);
		rest = rest.replace(fileMatch[0], " ").trim();
	}

	const declMatch = rest.match(/(?:^|\s)decl:(true|false|1|0|yes|no)/i);
	if (declMatch) {
		parsed.declaration = ["true", "1", "yes"].includes(declMatch[1].toLowerCase());
		parsed.filters.push(`decl=${declMatch[1]}`);
		rest = rest.replace(declMatch[0], " ").trim();
	}

	const backendMatch = rest.match(/(?:^|\s)backend:(tree|tree-sitter|syntax|tree-sitter-tags|syntax-pattern)/i);
	if (backendMatch) {
		const raw = backendMatch[1].toLowerCase();
		parsed.backend = raw.startsWith("tree") ? "tree-sitter-tags" : "syntax-pattern";
		parsed.filters.push(`backend=${backendMatch[1]}`);
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

export async function findDefinitionWithLsp(pi: ExtensionAPI, ctx: ExtensionContext, params: RepoMapOptions): Promise<string> {
	const request = getLspPositionRequest(pi, params, "definition");
	if (typeof request === "string") return request;
	const locations = await request.service.definition(request.path, request.position);
	return formatLspLocations(ctx.cwd, `LSP definition for ${request.path}:${request.position.line}:${request.position.column}`, locations);
}

export async function findReferencesWithLsp(pi: ExtensionAPI, ctx: ExtensionContext, params: RepoMapOptions): Promise<string> {
	const request = getLspPositionRequest(pi, params, "references");
	if (typeof request === "string") return request;
	const locations = await request.service.references(request.path, request.position);
	return formatLspLocations(ctx.cwd, `LSP references for ${request.path}:${request.position.line}:${request.position.column}`, locations);
}

export async function findHoverWithLsp(pi: ExtensionAPI, ctx: ExtensionContext, params: RepoMapOptions): Promise<string> {
	const request = getLspPositionRequest(pi, params, "hover");
	if (typeof request === "string") return request;
	const hover = await request.service.hover(request.path, request.position);
	if (!hover) return `No LSP hover found at ${request.path}:${request.position.line}:${request.position.column}.`;
	return [
		`LSP hover for ${formatRelativeLocation(ctx.cwd, hover.file, hover.line, hover.column)}`,
		"",
		hover.contents,
	].join("\n");
}

function getLspPositionRequest(
	pi: ExtensionAPI,
	params: RepoMapOptions,
	action: "definition" | "references" | "hover",
): { service: LspManagerService; path: string; position: LspPosition } | string {
	const service = getLspService(pi);
	if (!service) return `code_intel ${action} requires lsp-manager to be loaded.`;
	if (!params.path) return `code_intel ${action} requires path.`;
	if (!params.line || !params.column) return `code_intel ${action} requires 1-based line and column.`;
	return {
		service,
		path: params.path,
		position: { line: Math.floor(params.line), column: Math.floor(params.column) },
	};
}

function formatRelativeLocation(cwd: string, file: string, line: number, column: number): string {
	const displayFile = relative(cwd, file) || file;
	return `${displayFile}:${line}:${column}`;
}

function formatLspLocations(cwd: string, header: string, locations: LspLocation[]): string {
	if (locations.length === 0) return `${header}\nNo LSP locations found.`;
	const out = [header, `Showing ${locations.length} location(s).`, ""];
	for (const location of locations.slice(0, 100)) {
		const start = formatRelativeLocation(cwd, location.file, location.line, location.column);
		const end = location.endLine && location.endColumn ? `-${location.endLine}:${location.endColumn}` : "";
		out.push(`- ${start}${end}`);
	}
	if (locations.length > 100) out.push(`- ... ${locations.length - 100} more location(s) omitted.`);
	return out.join("\n");
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
	const tree = definitions.filter((definition) => definition.backend === "tree-sitter-tags").length;
	const syntax = definitions.filter((definition) => definition.backend === "syntax-pattern").length;
	const declarations = definitions.filter(isDeclaration).length;
	return `Backend summary: tree-sitter=${tree}, syntax-pattern=${syntax}, declarations=${declarations}.`;
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

	let paramsText = groups[0];
	if (definition.kind === "method" && signature.trimStart().startsWith("func ") && groups.length >= 2) {
		paramsText = groups[1];
	}
	if (definition.kind === "interface_method" && groups.length >= 1) {
		paramsText = groups[0];
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
		const match = lines[i].match(re);
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
