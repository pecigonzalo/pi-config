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
import { extractDefinitions, extractImportLines, findDefinitionEnd, getDefinitionEnd, matchDefinition, mergeDefinitions } from "./src/extractors";
import { buildDetails, formatAction, formatCallHint, textResult, truncateForTool } from "./src/helpers";
import { languageForPath } from "./src/source-files";
import { hydrateTreeSitterDefinitions, parseTreeSitterTagsOutput } from "./src/tree-sitter";
import type { CodeIntelParams } from "./src/types";

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
					output = await findDefinitionWithLsp(pi, ctx, params);
					break;
				case "references":
					output = await findReferencesWithLsp(pi, ctx, params);
					break;
				case "hover":
					output = await findHoverWithLsp(pi, ctx, params);
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

export const __test = {
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
};
