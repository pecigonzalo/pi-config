import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type CodeIntelAction = "repo_map" | "status" | "outline" | "symbols" | "slice" | "enclosing_symbol";

interface CodeIntelParams {
	action: CodeIntelAction;
	root?: string;
	mapTokens?: number;
	maxFiles?: number;
	maxFileBytes?: number;
	include?: string[];
	exclude?: string[];
	query?: string;
	path?: string;
	symbol?: string;
	line?: number;
	column?: number;
	limit?: number;
}

interface SourceFile {
	absPath: string;
	relPath: string;
	language: string;
	size: number;
}

interface Definition {
	name: string;
	kind: string;
	file: string;
	line: number; // zero-based
	column: number;
	text: string;
	signatureLines: string[];
	score: number;
}

interface RepoMapOptions {
	root?: string;
	mapTokens?: number;
	maxFiles?: number;
	maxFileBytes?: number;
	include?: string[];
	exclude?: string[];
	query?: string;
	path?: string;
	symbol?: string;
	line?: number;
	column?: number;
	limit?: number;
}

interface SourceScanDiagnostics {
	unsupportedExtensions: Map<string, number>;
	fallbackPatternLanguages: Map<string, number>;
}

interface SourceDiscoveryResult {
	files: SourceFile[];
	diagnostics: SourceScanDiagnostics;
}

interface RepoAnalysis {
	root: string;
	files: SourceFile[];
	diagnostics: SourceScanDiagnostics;
	analyses: Array<{ file: SourceFile; definitions: Definition[]; references: Map<string, number>; text?: string }>;
	definitionsByName: Map<string, Definition[]>;
	referencesByName: Map<string, Map<string, number>>;
	rankedDefinitions: Definition[];
}

interface CodeIntelDetails {
	action?: CodeIntelAction;
	summary: string;
	lineCount: number;
	byteCount: number;
	firstLine?: string;
}

const DEFAULT_MAP_TOKENS = 1600;
const DEFAULT_MAX_FILES = 2500;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const MAX_SIGNATURE_LINES = 12;
const IDENT_RE = /\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g;

const CODE_INTEL_SCHEMA = {
	type: "object",
	properties: {
		action: {
			type: "string",
			enum: ["repo_map", "status", "outline", "symbols", "slice", "enclosing_symbol"],
			description: "Operation to run. Use repo_map for compact codebase orientation; outline/symbols/slice/enclosing_symbol for targeted drilldown; status for backend availability.",
		},
		root: { type: "string", description: "Optional project root. Defaults to current working directory or git root." },
		mapTokens: {
			type: "number",
			description: `Approximate token budget for repo_map output. Default ${DEFAULT_MAP_TOKENS}.`,
		},
		maxFiles: { type: "number", description: `Maximum source files to scan. Default ${DEFAULT_MAX_FILES}.` },
		maxFileBytes: {
			type: "number",
			description: `Maximum bytes per file to scan. Default ${formatSize(DEFAULT_MAX_FILE_BYTES)}.`,
		},
		include: { type: "array", items: { type: "string" }, description: "Optional substrings paths must include." },
		exclude: { type: "array", items: { type: "string" }, description: "Optional substrings paths must not include." },
		query: { type: "string", description: "Optional identifier/file hint for repo_map or symbols." },
		path: { type: "string", description: "File path for outline, slice, or enclosing_symbol." },
		symbol: { type: "string", description: "Symbol name for slice." },
		line: { type: "number", description: "1-based line number for enclosing_symbol." },
		column: { type: "number", description: "1-based column number for enclosing_symbol; currently informational." },
		limit: { type: "number", description: "Maximum symbol results for symbols action. Default 50." },
	},
	required: ["action"],
	additionalProperties: false,
};

const EXT_TO_LANGUAGE = new Map<string, string>([
	[".ts", "typescript"],
	[".tsx", "tsx"],
	[".js", "javascript"],
	[".jsx", "jsx"],
	[".mjs", "javascript"],
	[".cjs", "javascript"],
	[".go", "go"],
	[".py", "python"],
	[".rs", "rust"],
	[".java", "java"],
	[".kt", "kotlin"],
	[".kts", "kotlin"],
	[".rb", "ruby"],
	[".php", "php"],
	[".cs", "csharp"],
	[".c", "c"],
	[".h", "c"],
	[".cc", "cpp"],
	[".cpp", "cpp"],
	[".cxx", "cpp"],
	[".hpp", "cpp"],
	[".swift", "swift"],
	[".scala", "scala"],
	[".ex", "elixir"],
	[".exs", "elixir"],
	[".erl", "erlang"],
	[".hrl", "erlang"],
]);

const LANGUAGE_SPECIFIC_PATTERN_SUPPORT = new Set([
	"typescript",
	"tsx",
	"javascript",
	"jsx",
	"go",
	"python",
	"rust",
	"java",
	"kotlin",
	"csharp",
	"php",
	"ruby",
	"c",
	"cpp",
	"swift",
]);

const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"target",
	"vendor",
	"coverage",
	".next",
	".nuxt",
	".turbo",
	".cache",
	"tmp",
	"temp",
]);

const KEYWORDS = new Set([
	"abstract",
	"and",
	"as",
	"async",
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"def",
	"default",
	"defer",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"final",
	"finally",
	"fn",
	"for",
	"from",
	"func",
	"function",
	"if",
	"impl",
	"import",
	"in",
	"interface",
	"let",
	"match",
	"mod",
	"module",
	"namespace",
	"new",
	"nil",
	"none",
	"not",
	"null",
	"or",
	"package",
	"private",
	"protected",
	"pub",
	"public",
	"return",
	"self",
	"static",
	"struct",
	"super",
	"switch",
	"this",
	"trait",
	"true",
	"try",
	"type",
	"undefined",
	"use",
	"var",
	"void",
	"while",
]);

export default function codeIntelExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "code_intel",
		label: "Code Intel",
		description:
			"Generate compact codebase orientation maps and symbol drilldowns without reading whole files into context. Results are syntax-derived and approximate.",
		promptSnippet: "Generate compact repo maps, file outlines, symbol search results, and symbol slices before reading many files.",
		promptGuidelines: [
			"Use code_intel repo_map before broad file reads when you need to understand an unfamiliar codebase or locate important APIs.",
			"Use code_intel outline for file structure and code_intel slice for targeted symbol bodies instead of reading entire files.",
			"Treat code_intel results as approximate syntax-derived orientation; use read on targeted files/ranges before editing.",
		],
		parameters: CODE_INTEL_SCHEMA as any,
		renderCall(args, theme) {
			return new Text(formatCallHint(args as Partial<CodeIntelParams>, theme), 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const args = context.args as Partial<CodeIntelParams>;
			if (isPartial) return new Text(theme.fg("warning", `${formatAction(args.action)} running...`), 0, 0);

			const details = result.details as CodeIntelDetails | undefined;
			const content = result.content[0];
			const text = content?.type === "text" ? content.text : "";
			let rendered = theme.fg("success", `✓ ${formatAction(args.action)}`);
			if (details?.summary) rendered += theme.fg("muted", ` • ${details.summary}`);
			if (details) rendered += theme.fg("dim", ` • ${details.lineCount} lines • ${formatSize(details.byteCount)}`);

			if (expanded && text) {
				const previewLines = text.split("\n").slice(0, 35);
				rendered += "\n" + previewLines.map((line) => theme.fg("dim", line)).join("\n");
				const totalLines = text.split("\n").length;
				if (totalLines > previewLines.length) {
					rendered += `\n${theme.fg("muted", `⋮... ${totalLines - previewLines.length} more lines in tool result`)}`;
				}
			}

			return new Text(rendered, 0, 0);
		},
		async execute(_toolCallId, params: CodeIntelParams, signal, _onUpdate, ctx) {
			let output: string;
			switch (params.action) {
				case "status":
					output = await buildStatus(pi, ctx, signal);
					break;
				case "repo_map":
					output = await generateRepoMap(pi, ctx, params, signal);
					break;
				case "outline":
					output = await generateOutline(pi, ctx, params, signal);
					break;
				case "symbols":
					output = await findSymbols(pi, ctx, params, signal);
					break;
				case "slice":
					output = await sliceSymbol(pi, ctx, params, signal);
					break;
				case "enclosing_symbol":
					output = await findEnclosingSymbol(pi, ctx, params, signal);
					break;
				default:
					output = `Unknown code_intel action: ${(params as { action?: string }).action}`;
			}
			const text = truncateForTool(output);
			return textResult(text, buildDetails(params, text));
		},
	});

	pi.registerCommand("code-intel", {
		description: "Code intelligence helpers: /code-intel status | /code-intel map [tokens]",
		handler: async (args, ctx) => {
			const [subcommandRaw, maybeTokens] = args.trim().split(/\s+/, 2);
			const subcommand = subcommandRaw || "status";

			if (subcommand === "status") {
				ctx.ui.notify(await buildStatus(pi, ctx, ctx.signal), "info");
				return;
			}

			if (subcommand === "map" || subcommand === "repo-map" || subcommand === "repomap") {
				const mapTokens = maybeTokens ? Number(maybeTokens) : undefined;
				const map = await generateRepoMap(pi, ctx, { mapTokens }, ctx.signal);
				if (ctx.hasUI) {
					await ctx.ui.editor("Repo map", map);
				} else {
					ctx.ui.notify(truncateForTool(map), "info");
				}
				return;
			}

			ctx.ui.notify("Usage: /code-intel status | /code-intel map [tokens]", "warning");
		},
	});
}

function textResult(text: string, details?: CodeIntelDetails) {
	return {
		content: [{ type: "text" as const, text }],
		details: details ?? buildDetails({}, text),
	};
}

function buildDetails(params: Partial<CodeIntelParams>, text: string): CodeIntelDetails {
	const lines = text.split("\n");
	return {
		action: params.action,
		summary: summarizeResult(params, text),
		lineCount: lines.length,
		byteCount: Buffer.byteLength(text, "utf8"),
		firstLine: lines.find((line) => line.trim())?.trim(),
	};
}

function summarizeResult(params: Partial<CodeIntelParams>, text: string): string {
	const firstLine = text.split("\n").find((line) => line.trim())?.trim();
	const scope = params.path ?? params.query ?? params.symbol ?? params.root;
	const prefix = scope ? `${scope}` : firstLine ?? "complete";
	const counts = [
		matchCount(text, /Scanned (\d+) source file/),
		matchCount(text, /found (\d+) definition/),
		matchCount(text, /Showing (\d+) of (\d+) match/),
	]
		.filter(Boolean)
		.join(", ");
	return counts ? `${prefix} (${counts})` : prefix;
}

function matchCount(text: string, re: RegExp): string | undefined {
	const match = text.match(re);
	if (!match) return;
	if (match[2]) return `${match[1]}/${match[2]}`;
	return match[1];
}

function formatCallHint(args: Partial<CodeIntelParams>, theme: { fg: (name: string, value: string) => string; bold: (value: string) => string }): string {
	const action = formatAction(args.action);
	const parts: string[] = [];
	if (args.path) parts.push(`path=${quoteArg(args.path)}`);
	if (args.symbol) parts.push(`symbol=${quoteArg(args.symbol)}`);
	if (args.query) parts.push(`query=${quoteArg(args.query)}`);
	if (args.line !== undefined) parts.push(`line=${args.line}`);
	if (args.column !== undefined) parts.push(`column=${args.column}`);
	if (args.mapTokens !== undefined) parts.push(`mapTokens=${args.mapTokens}`);
	if (args.maxFiles !== undefined) parts.push(`maxFiles=${args.maxFiles}`);
	if (args.include?.length) parts.push(`include=${quoteArg(args.include.join(","))}`);
	if (args.exclude?.length) parts.push(`exclude=${quoteArg(args.exclude.join(","))}`);
	if (args.root) parts.push(`root=${quoteArg(args.root)}`);

	let text = theme.fg("toolTitle", theme.bold("code_intel"));
	text += " " + theme.fg("accent", action);
	if (parts.length > 0) text += " " + theme.fg("muted", parts.join(" "));
	return text;
}

function formatAction(action?: string): string {
	return action ?? "code_intel";
}

function quoteArg(value: string): string {
	if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
	return JSON.stringify(value.length > 80 ? `${value.slice(0, 77)}...` : value);
}

function truncateForTool(text: string): string {
	const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncation.truncated) return text;
	return `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
		truncation.outputBytes,
	)} of ${formatSize(truncation.totalBytes)}).]`;
}

async function buildStatus(pi: ExtensionAPI, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
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
		`- active Phase 1 backend: ${treeSitter.available ? "syntax-pattern fallback (tree-sitter integration planned)" : "syntax-pattern fallback"}`,
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

async function commandVersion(
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

async function generateRepoMap(
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
		analyses: analysis.analyses,
		rankedDefinitions: analysis.rankedDefinitions,
		mapTokens,
		query: params.query,
	});
}

async function buildRepoAnalysis(
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

		const definitions = extractDefinitions(file, text);
		const references = extractReferences(text);
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

	const rankedDefinitions = rankDefinitions(definitionsByName, referencesByName, splitQueryTerms(params.query));
	return { root, files, diagnostics: sourceDiscovery.diagnostics, analyses, definitionsByName, referencesByName, rankedDefinitions };
}

async function generateOutline(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: RepoMapOptions,
	signal?: AbortSignal,
): Promise<string> {
	const loaded = await loadRequestedSourceFile(pi, ctx, params, signal);
	if (typeof loaded === "string") return loaded;
	const { root, file, text } = loaded;
	const definitions = extractDefinitions(file, text);
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
		out.push("No symbols found by the current syntax-pattern backend.");
		return out.join("\n");
	}

	out.push("Symbols:");
	for (const definition of definitions) {
		const endLine = findDefinitionEnd(lines, definition.line, file.language);
		out.push(
			`${String(definition.line + 1).padStart(5, " ")}-${String(endLine + 1).padStart(5, " ")} │${definition.kind.padEnd(10)} ${definition.name}`,
		);
		for (const signatureLine of definition.signatureLines.slice(0, 3)) {
			out.push(`            │ ${signatureLine.trim()}`);
		}
	}
	return out.join("\n");
}

async function findSymbols(
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
			`${definition.file}:${definition.line + 1}:${definition.column + 1} │ ${definition.kind} ${definition.name} │ score ${definition.score.toFixed(2)}`,
		);
		out.push(`  ${definition.signatureLines[0]?.trim() ?? definition.text.trim()}`);
	}
	return out.join("\n");
}

async function sliceSymbol(
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
	if (loaded && typeof loaded !== "string") {
		const definitions = extractDefinitions(loaded.file, loaded.text);
		target = chooseDefinition(definitions, loaded.file, loaded.text, params);
	} else {
		const analysis = await buildRepoAnalysis(pi, ctx, params, signal);
		const candidates = analysis.rankedDefinitions.filter((definition) => definition.name === params.symbol || definition.name.toLowerCase().includes((params.symbol ?? "").toLowerCase()));
		const definition = candidates[0];
		if (definition) {
			const fileAnalysis = analysis.analyses.find((item) => item.file.relPath === definition.file);
			if (fileAnalysis?.text) target = { file: fileAnalysis.file, text: fileAnalysis.text, definition };
		}
	}

	if (!target) return `No matching symbol found${params.symbol ? ` for "${params.symbol}"` : ""}.`;
	const lines = target.text.split(/\r?\n/);
	const endLine = findDefinitionEnd(lines, target.definition.line, target.file.language);
	const slice = lines.slice(target.definition.line, endLine + 1).join("\n");
	const header = `${target.file.relPath}:${target.definition.line + 1}-${endLine + 1} │ ${target.definition.kind} ${target.definition.name}`;
	return `${header}\n\n${slice}`;
}

async function findEnclosingSymbol(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: RepoMapOptions,
	signal?: AbortSignal,
): Promise<string> {
	if (!params.path) return "code_intel enclosing_symbol requires path.";
	if (!params.line) return "code_intel enclosing_symbol requires 1-based line.";
	const loaded = await loadRequestedSourceFile(pi, ctx, params, signal);
	if (typeof loaded === "string") return loaded;
	const definitions = extractDefinitions(loaded.file, loaded.text);
	const lines = loaded.text.split(/\r?\n/);
	const zeroLine = Math.max(0, Math.floor(params.line) - 1);
	const enclosing = definitions
		.map((definition) => ({ definition, endLine: findDefinitionEnd(lines, definition.line, loaded.file.language) }))
		.filter((item) => item.definition.line <= zeroLine && item.endLine >= zeroLine)
		.sort((a, b) => b.definition.line - a.definition.line)[0];

	if (!enclosing) return `No enclosing symbol found at ${loaded.file.relPath}:${params.line}.`;
	return [
		`Enclosing symbol at ${loaded.file.relPath}:${params.line}${params.column ? `:${params.column}` : ""}`,
		`${enclosing.definition.kind} ${enclosing.definition.name}`,
		`range: ${enclosing.definition.line + 1}-${enclosing.endLine + 1}`,
		`signature: ${enclosing.definition.signatureLines.map((line) => line.trim()).join(" ")}`,
	].join("\n");
}

async function loadRequestedSourceFile(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: RepoMapOptions,
	signal?: AbortSignal,
): Promise<{ root: string; file: SourceFile; text: string } | string> {
	if (!params.path) return "This action requires path.";
	const root = params.root ? resolve(ctx.cwd, params.root) : await findProjectRoot(pi, ctx.cwd, signal);
	const absPath = resolve(root, params.path);
	if (!existsSync(absPath)) return `File not found: ${params.path}`;
	const relPath = normalizePath(relative(root, absPath));
	const language = languageForPath(relPath);
	if (!language) return `Unsupported file extension for ${params.path}.`;
	const fileStat = await stat(absPath);
	if (!fileStat.isFile()) return `Not a regular file: ${params.path}`;
	const text = await readFile(absPath, "utf8");
	if (looksBinary(text)) return `Refusing to analyze binary-looking file: ${params.path}`;
	return { root, file: { absPath, relPath, language, size: fileStat.size }, text };
}

function chooseDefinition(definitions: Definition[], file: SourceFile, text: string, params: RepoMapOptions): { file: SourceFile; text: string; definition: Definition } | undefined {
	if (params.line) {
		const lines = text.split(/\r?\n/);
		const zeroLine = Math.max(0, Math.floor(params.line) - 1);
		const enclosing = definitions
			.map((definition) => ({ definition, endLine: findDefinitionEnd(lines, definition.line, file.language) }))
			.filter((item) => item.definition.line <= zeroLine && item.endLine >= zeroLine)
			.sort((a, b) => b.definition.line - a.definition.line)[0];
		if (enclosing) return { file, text, definition: enclosing.definition };
	}
	const symbol = params.symbol?.toLowerCase();
	const definition = symbol ? definitions.find((item) => item.name.toLowerCase() === symbol) ?? definitions.find((item) => item.name.toLowerCase().includes(symbol)) : definitions[0];
	return definition ? { file, text, definition } : undefined;
}

function extractImportLines(lines: string[]): Array<{ line: number; text: string }> {
	const imports: Array<{ line: number; text: string }> = [];
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (/^(import|export\s+.*from|from\s+\S+\s+import|package\s+|use\s+|mod\s+|require\(|#include\s+)/.test(trimmed)) {
			imports.push({ line: i, text: lines[i].trimEnd() });
		}
	}
	return imports;
}

function findDefinitionEnd(lines: string[], start: number, language: string): number {
	if (["python", "ruby"].includes(language)) return findIndentBlockEnd(lines, start);
	return findBraceBlockEnd(lines, start);
}

function findIndentBlockEnd(lines: string[], start: number): number {
	const startIndent = leadingWhitespace(lines[start] ?? "");
	let end = start;
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) {
			end = i;
			continue;
		}
		const indent = leadingWhitespace(line);
		if (indent <= startIndent) break;
		end = i;
	}
	return end;
}

function findBraceBlockEnd(lines: string[], start: number): number {
	let depth = 0;
	let sawOpen = false;
	let end = start;
	for (let i = start; i < Math.min(lines.length, start + 500); i++) {
		const line = lines[i];
		for (const char of line) {
			if (char === "{") {
				depth++;
				sawOpen = true;
			} else if (char === "}") {
				depth--;
			}
		}
		end = i;
		if (sawOpen && depth <= 0) break;
		if (!sawOpen && i > start && !line.trim()) break;
	}
	return end;
}

function leadingWhitespace(line: string): number {
	return line.length - line.trimStart().length;
}

async function findProjectRoot(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string> {
	try {
		const result = await pi.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { signal, timeout: 5000 });
		if (result.code === 0) {
			const root = result.stdout.trim();
			if (root) return root;
		}
	} catch {
		// fall through
	}
	return cwd;
}

async function listSourceFiles(
	pi: ExtensionAPI,
	root: string,
	options: { maxFiles: number; maxFileBytes: number; include?: string[]; exclude?: string[] },
	signal?: AbortSignal,
): Promise<SourceDiscoveryResult> {
	const gitFiles = await listGitFiles(pi, root, signal);
	const relPaths = gitFiles.length > 0 ? gitFiles : await walkFiles(root, options.maxFiles * 2, signal);
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
		if (!LANGUAGE_SPECIFIC_PATTERN_SUPPORT.has(language)) {
			incrementCount(fallbackPatternLanguages, language);
		}

		const absPath = resolve(root, relPath);
		let fileStat;
		try {
			fileStat = await stat(absPath);
		} catch {
			continue;
		}
		if (!fileStat.isFile() || fileStat.size > options.maxFileBytes) continue;
		files.push({ absPath, relPath, language, size: fileStat.size });
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
	const extension = extname(relPath).toLowerCase();
	return extension || "(no extension)";
}

async function listGitFiles(pi: ExtensionAPI, root: string, signal?: AbortSignal): Promise<string[]> {
	try {
		const result = await pi.exec("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
			signal,
			timeout: 10_000,
		});
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

function languageForPath(path: string): string | undefined {
	return EXT_TO_LANGUAGE.get(extname(path).toLowerCase());
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

function normalizePath(path: string): string {
	return path.split(sep).join("/");
}

function looksBinary(text: string): boolean {
	return text.includes("\0");
}

function extractDefinitions(file: SourceFile, text: string): Definition[] {
	const lines = text.split(/\r?\n/);
	const definitions: Definition[] = [];

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const match = matchDefinition(file.language, line);
		if (!match) continue;
		definitions.push({
			name: match.name,
			kind: match.kind,
			file: file.relPath,
			line: index,
			column: line.indexOf(match.name),
			text: line.trimEnd(),
			signatureLines: captureSignature(lines, index, file.language),
			score: 0,
		});
	}

	return definitions;
}

function matchDefinition(language: string, line: string): { name: string; kind: string } | undefined {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) return;

	const patternsByLanguage: Record<string, Array<{ kind: string; re: RegExp; nameGroup?: number }>> = {
		typescript: jsTsPatterns(),
		tsx: jsTsPatterns(),
		javascript: jsTsPatterns(),
		jsx: jsTsPatterns(),
		go: [
			{ kind: "method", re: /^func\s*\([^)]*\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
			{ kind: "function", re: /^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
			{ kind: "type", re: /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface|\w+)/ },
		],
		python: [
			{ kind: "class", re: /^class\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
			{ kind: "function", re: /^(async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, nameGroup: 2 },
		],
		rust: [
			{ kind: "function", re: /^(pub\s+)?(async\s+)?(unsafe\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/, nameGroup: 4 },
			{ kind: "struct", re: /^(pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/, nameGroup: 2 },
			{ kind: "enum", re: /^(pub\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/, nameGroup: 2 },
			{ kind: "trait", re: /^(pub\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)\b/, nameGroup: 2 },
			{ kind: "impl", re: /^impl(?:<[^>]+>)?\s+([A-Za-z_][A-Za-z0-9_:<>]*)\b/ },
		],
		java: javaLikePatterns(),
		kotlin: javaLikePatterns(),
		csharp: javaLikePatterns(),
		php: [
			{ kind: "class", re: /^(abstract\s+|final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\b/, nameGroup: 2 },
			{ kind: "interface", re: /^interface\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
			{ kind: "function", re: /^(public\s+|private\s+|protected\s+|static\s+)*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, nameGroup: 2 },
		],
		ruby: [
			{ kind: "class", re: /^class\s+([A-Za-z_][A-Za-z0-9_:]*)\b/ },
			{ kind: "module", re: /^module\s+([A-Za-z_][A-Za-z0-9_:]*)\b/ },
			{ kind: "method", re: /^def\s+([A-Za-z_][A-Za-z0-9_!?=]*)\b/ },
		],
		c: cLikePatterns(),
		cpp: cLikePatterns(),
		swift: [
			{ kind: "class", re: /^(public\s+|private\s+|internal\s+|open\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\b/, nameGroup: 2 },
			{ kind: "struct", re: /^(public\s+|private\s+|internal\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/, nameGroup: 2 },
			{ kind: "protocol", re: /^(public\s+|private\s+|internal\s+)?protocol\s+([A-Za-z_][A-Za-z0-9_]*)\b/, nameGroup: 2 },
			{ kind: "function", re: /^(public\s+|private\s+|internal\s+|static\s+|class\s+)*func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, nameGroup: 2 },
		],
	};

	const patterns = patternsByLanguage[language] ?? jsTsPatterns();
	for (const pattern of patterns) {
		const match = trimmed.match(pattern.re);
		if (!match) continue;
		const name = match[pattern.nameGroup ?? 1];
		if (!name || KEYWORDS.has(name.toLowerCase())) continue;
		return { name, kind: pattern.kind };
	}
}

function jsTsPatterns() {
	return [
		{ kind: "class", re: /^(export\s+)?(default\s+)?(abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/, nameGroup: 4 },
		{ kind: "interface", re: /^(export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/, nameGroup: 2 },
		{ kind: "type", re: /^(export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/, nameGroup: 2 },
		{ kind: "enum", re: /^(export\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/, nameGroup: 2 },
		{ kind: "function", re: /^(export\s+)?(default\s+)?(async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/, nameGroup: 4 },
		{ kind: "function", re: /^(export\s+)?(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(async\s*)?(\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/, nameGroup: 3 },
		{ kind: "function", re: /^(export\s+)?(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(async\s*)?function\b/, nameGroup: 3 },
		{ kind: "method", re: /^(public\s+|private\s+|protected\s+|static\s+|async\s+|override\s+|readonly\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*[:{]/, nameGroup: 2 },
	];
}

function javaLikePatterns() {
	return [
		{ kind: "class", re: /^(public\s+|private\s+|protected\s+|abstract\s+|final\s+|sealed\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/, nameGroup: 2 },
		{ kind: "interface", re: /^(public\s+|private\s+|protected\s+)*interface\s+([A-Za-z_][A-Za-z0-9_]*)\b/, nameGroup: 2 },
		{ kind: "enum", re: /^(public\s+|private\s+|protected\s+)*enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/, nameGroup: 2 },
		{ kind: "method", re: /^(public\s+|private\s+|protected\s+|static\s+|final\s+|override\s+|suspend\s+)*[A-Za-z_][A-Za-z0-9_<>,.?\[\]\s]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*[{;]/, nameGroup: 2 },
		{ kind: "function", re: /^(public\s+|private\s+|protected\s+|internal\s+)?fun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, nameGroup: 2 },
	];
}

function cLikePatterns() {
	return [
		{ kind: "type", re: /^(typedef\s+)?(struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\b/, nameGroup: 3 },
		{ kind: "function", re: /^[A-Za-z_][A-Za-z0-9_*\s]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?$/ },
	];
}

function captureSignature(lines: string[], start: number, language: string): string[] {
	const out: string[] = [];
	let parenDepth = 0;
	let bracketDepth = 0;
	for (let i = start; i < Math.min(lines.length, start + MAX_SIGNATURE_LINES); i++) {
		const line = lines[i].trimEnd();
		out.push(line);
		for (const char of line) {
			if (char === "(") parenDepth++;
			else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
			else if (char === "[") bracketDepth++;
			else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
		}
		const trimmed = line.trim();
		if (i === start && language === "python" && trimmed.endsWith(":")) break;
		if (i > start && parenDepth === 0 && bracketDepth === 0) break;
		if (parenDepth === 0 && bracketDepth === 0 && /[{;:]\s*$/.test(trimmed)) break;
		if (parenDepth === 0 && bracketDepth === 0 && /=>\s*[{(]?\s*$/.test(trimmed)) break;
	}
	return out;
}

function extractReferences(text: string): Map<string, number> {
	const references = new Map<string, number>();
	const stripped = text.replace(/\/\/.*|#.*|\/\*[\s\S]*?\*\//g, " ");
	for (const match of stripped.matchAll(IDENT_RE)) {
		const ident = match[0];
		if (KEYWORDS.has(ident.toLowerCase())) continue;
		if (/^\d/.test(ident)) continue;
		references.set(ident, (references.get(ident) ?? 0) + 1);
	}
	return references;
}

function splitQueryTerms(query?: string): Set<string> {
	if (!query) return new Set();
	return new Set(query.split(/[^A-Za-z0-9_.$/-]+/).filter((term) => term.length >= 2));
}

function rankDefinitions(
	definitionsByName: Map<string, Definition[]>,
	referencesByName: Map<string, Map<string, number>>,
	queryTerms: Set<string>,
): Definition[] {
	const ranked: Definition[] = [];
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

function renderScanDiagnostics(diagnostics: SourceScanDiagnostics, analyzedSourceFiles: number): string[] {
	const notes: string[] = [];
	const unsupportedTotal = mapTotal(diagnostics.unsupportedExtensions);
	if (unsupportedTotal > 0 && analyzedSourceFiles === 0) {
		notes.push(`No supported source files were analyzed. Unsupported extensions in scope: ${formatCountBreakdown(diagnostics.unsupportedExtensions)}.`);
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
	analyses: Array<{ file: SourceFile; definitions: Definition[]; references: Map<string, number> }>;
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
		`Generated by code-intel Phase 1 syntax-pattern backend (approximate).`,
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
			out += `${String(lineNumber).padStart(5, " ")} │${text}\n`;
			lastLine = definition.line + offset;
		}
	}
	return out;
}

function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

export const __test = {
	extractDefinitions,
	extractReferences,
	rankDefinitions,
	renderRepoMap,
	renderScanDiagnostics,
	languageForPath,
	findDefinitionEnd,
	extractImportLines,
};
