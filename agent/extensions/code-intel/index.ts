import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	__actionsTest,
	buildStatus,
	findDefinitionWithLsp,
	findEnclosingSymbol,
	findHoverWithLsp,
	findIdentifierLineMatches,
	findReferencesWithLsp,
	findSymbols,
	generateOutline,
	generateRepoMap,
	renderTextMatchFallback,
	sliceSymbol,
} from "./src/actions";
import { __analysisTest } from "./src/analysis";
import { CODE_INTEL_SCHEMA } from "./src/constants";
import {
	extractDefinitions,
	extractImportLines,
	findDefinitionEnd,
	getDefinitionEnd,
	matchDefinition,
	mergeDefinitions,
} from "./src/extractors";
import { buildDetails, formatAction, formatCallHint, textResult, truncateForTool } from "./src/helpers";
import { hydrateLspDocumentSymbols, identifierAtPosition } from "./src/lsp";
import { languageForPath } from "./src/source-files";
import { hydrateTreeSitterDefinitions, parseTreeSitterTagsOutput } from "./src/tree-sitter";
import type { CodeIntelParams } from "./src/types";

const CODE_INTEL_COMPLETIONS = [
	{ value: "status", label: "status: show code intelligence status" },
	{ value: "map", label: "map: generate repo map" },
	{ value: "repo-map", label: "repo-map: generate repo map (alias for map)" },
] as const;

export const CODE_INTEL_DESCRIPTION =
	"Locate symbols and follow compact drilldowns without loading whole files: symbols → slice → LSP references → enclosing_symbol → slice. Symbol discovery and slicing use LSP document symbols when available, with Tree-sitter/syntax fallback; definition, references, and hover require LSP.";
export const CODE_INTEL_PROMPT_SNIPPET =
	"Locate with symbols, inspect bodies with slice, follow usages with LSP references, convert usage locations to caller context with enclosing_symbol, then slice callers; avoid broad file reads.";
export const CODE_INTEL_PROMPT_GUIDELINES = [
	"Use repo_map for unfamiliar codebase orientation, then symbols only as a locator; do not follow symbols results with whole-file reads.",
	"When LSP is available, prefer symbols → slice → references → enclosing_symbol → slice to inspect definitions, usages, and caller bodies.",
	"When LSP references are unavailable, continue with outline, symbols, and slice; use targeted text search only for usages that semantic lookup cannot provide.",
	"Use outline only for file structure, and definition/hover for focused LSP-backed lookup by symbol or path+line+column.",
	"Before editing, verify only the exact target with a small read of the relevant lines when code_intel output is insufficient; avoid broad reads.",
];

export default function codeIntelExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "code_intel",
		label: "Code Intel",
		description: CODE_INTEL_DESCRIPTION,
		promptSnippet: CODE_INTEL_PROMPT_SNIPPET,
		promptGuidelines: CODE_INTEL_PROMPT_GUIDELINES,
		parameters: CODE_INTEL_SCHEMA as any,
		renderCall(args, theme) {
			return new Text(formatCallHint(args as Partial<CodeIntelParams>, theme), 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const args = context.args as Partial<CodeIntelParams>;
			if (isPartial) return new Text(theme.fg("warning", `${formatAction(args.action)} running...`), 0, 0);

			const details = result.details as { summary?: string; lineCount?: number; byteCount?: number } | undefined;
			const content = result.content[0];
			const text = content?.type === "text" ? content.text : "";
			let rendered = theme.fg("success", `✓ ${formatAction(args.action)}`);
			if (details?.summary) rendered += theme.fg("muted", ` • ${details.summary}`);
			if (details?.lineCount !== undefined && details?.byteCount !== undefined) {
				rendered += theme.fg("dim", ` • ${details.lineCount} lines • ${formatSize(details.byteCount)}`);
			}

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
				case "definition":
					output = await findDefinitionWithLsp(pi, ctx, params, signal);
					break;
				case "references":
					output = await findReferencesWithLsp(pi, ctx, params, signal);
					break;
				case "hover":
					output = await findHoverWithLsp(pi, ctx, params, signal);
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
		getArgumentCompletions: (prefix) => CODE_INTEL_COMPLETIONS.filter((s) => s.value.startsWith(prefix.trim())),
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

export const __test = {
	CODE_INTEL_COMPLETIONS,
	CODE_INTEL_DESCRIPTION,
	CODE_INTEL_PROMPT_SNIPPET,
	CODE_INTEL_PROMPT_GUIDELINES,
	CODE_INTEL_SCHEMA,
	extractDefinitions,
	matchDefinition,
	rankDefinitions: __analysisTest.rankDefinitions,
	renderRepoMap: __analysisTest.renderRepoMap,
	renderScanDiagnostics: __analysisTest.renderScanDiagnostics,
	languageForPath,
	findDefinitionEnd,
	extractImportLines,
	parseTreeSitterTagsOutput,
	hydrateTreeSitterDefinitions,
	hydrateLspDocumentSymbols,
	identifierAtPosition,
	mergeDefinitions,
	renderTextMatchFallback,
	findIdentifierLineMatches,
	getDefinitionEnd,
	filterBySliceMode: __actionsTest.filterBySliceMode,
	isDeclaration: __actionsTest.isDeclaration,
	formatBackendSummary: __actionsTest.formatBackendSummary,
	normalizeSliceMode: __actionsTest.normalizeSliceMode,
	parseSymbolQuery: __actionsTest.parseSymbolQuery,
	matchesSymbolQuery: __actionsTest.matchesSymbolQuery,
	inferCallableArity: __actionsTest.inferCallableArity,
	chooseReferenceDeclaration: __actionsTest.chooseReferenceDeclaration,
	formatLspLocations: __actionsTest.formatLspLocations,
	formatReferencesOutput: __actionsTest.formatReferencesOutput,
};
