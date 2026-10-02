import { formatSize } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const CODE_INTEL_CACHE_VERSION = 6;
export const DEFAULT_MAP_TOKENS = 1600;
export const DEFAULT_MAX_FILES = 2500;
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
export const MAX_SIGNATURE_LINES = 12;
export const IDENT_RE = /\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g;

const actionSchema = Type.Union(
	[
		Type.Literal("repo_map"),
		Type.Literal("status"),
		Type.Literal("outline"),
		Type.Literal("symbols"),
		Type.Literal("slice"),
		Type.Literal("enclosing_symbol"),
		Type.Literal("definition"),
		Type.Literal("references"),
		Type.Literal("hover"),
	],
	{
		description:
			"Operation to run. Orient with repo_map, locate with symbols, inspect bodies with slice, find usages with LSP-backed references, convert usage locations to caller context with enclosing_symbol, then slice callers. Use outline for structure; definition/references/hover require LSP; status reports backend availability.",
	},
);

export const CODE_INTEL_SCHEMA = Type.Object(
	{
		action: actionSchema,
		root: Type.Optional(
			Type.String({
				description: "Optional project root. Defaults to current working directory or git root.",
			}),
		),
		mapTokens: Type.Optional(
			Type.Number({
				description: `Approximate token budget for repo_map output. Default ${DEFAULT_MAP_TOKENS}.`,
			}),
		),
		maxFiles: Type.Optional(
			Type.Number({
				description: `Maximum source files to scan. Default ${DEFAULT_MAX_FILES}.`,
			}),
		),
		maxFileBytes: Type.Optional(
			Type.Number({
				description: `Maximum bytes per file to scan. Default ${formatSize(DEFAULT_MAX_FILE_BYTES)}.`,
			}),
		),
		include: Type.Optional(
			Type.Array(Type.String(), {
				description: "Optional substrings paths must include.",
			}),
		),
		exclude: Type.Optional(
			Type.Array(Type.String(), {
				description: "Optional substrings paths must not include.",
			}),
		),
		query: Type.Optional(
			Type.String({
				description:
					"Identifier/file hint for repo_map, or locator query for symbols; follow symbol matches with slice.",
			}),
		),
		path: Type.Optional(
			Type.String({
				description:
					"File path for outline, slice, enclosing_symbol, definition, references, or hover. Pass a reference location to enclosing_symbol to identify its caller.",
			}),
		),
		symbol: Type.Optional(
			Type.String({
				description:
					"Symbol name. Prefer slice for its body and LSP-backed references for usages; symbols only locates candidates.",
			}),
		),
		line: Type.Optional(
			Type.Number({
				description:
					"1-based line for enclosing_symbol or LSP lookup. Use enclosing_symbol on a reference line, then slice the returned caller.",
			}),
		),
		column: Type.Optional(
			Type.Number({
				description: "1-based column number for LSP-backed position lookups.",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description:
					"Maximum locator results for symbols. Default 50; use slice rather than reading matched files broadly.",
			}),
		),
		sliceMode: Type.Optional(
			Type.Union([Type.Literal("implementation"), Type.Literal("declaration"), Type.Literal("any")], {
				description: 'Preferred body for slice: implementation, declaration, or any. Default "any".',
			}),
		),
	},
	{ additionalProperties: false },
);

export const EXT_TO_LANGUAGE = new Map<string, string>([
	[".ts", "typescript"],
	[".tsx", "tsx"],
	[".js", "javascript"],
	[".jsx", "jsx"],
	[".mjs", "javascript"],
	[".cjs", "javascript"],
	[".go", "go"],
	[".py", "python"],
	[".rs", "rust"],
	[".tf", "terraform"],
	[".tfvars", "terraform"],
	[".tfcomponent.hcl", "terraform"],
	[".tfstack.hcl", "terraform"],
	[".tfdeploy.hcl", "terraform"],
	[".tfquery.hcl", "terraform"],
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

export const LANGUAGE_SPECIFIC_PATTERN_SUPPORT = new Set([
	"typescript",
	"tsx",
	"javascript",
	"jsx",
	"go",
	"python",
	"rust",
	"terraform",
	"java",
	"kotlin",
	"csharp",
	"php",
	"ruby",
	"c",
	"cpp",
	"swift",
]);

export const SKIP_DIRS = new Set([
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

export const KEYWORDS = new Set([
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
