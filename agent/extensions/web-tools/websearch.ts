import { defineTool, keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
	clipText,
	formatTruncationNotice,
	normalizeDomainFilters,
	normalizeWhitespace,
	persistFullOutput,
	truncateToolText,
	validateHttpUrl,
	WEB_TOOLS_NAMESPACE,
} from "./shared";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const MAX_DOMAINS = 10;
const MAX_OBJECTIVE_CHARS = 4096;
const EXA_SERVER_NAME = "exa";
const EXA_SEARCH_TOOL = `mcp__${EXA_SERVER_NAME}__web_search_exa`;
const MCP_READY_TIMEOUT_MS = 3000;
const MCP_READY_POLL_MS = 100;

export const WebsearchParams = Type.Object(
	{
		query: Type.String({ description: "Search query for discovering relevant public web pages" }),
		limit: Type.Optional(
			Type.Number({
				description: `Maximum number of results to return, integer (1..${MAX_LIMIT}, default ${DEFAULT_LIMIT})`,
			}),
		),
		domains: Type.Optional(
			Type.Array(
				Type.String({ description: "Restrict results to a domain or subdomain, e.g. docs.example.com" }),
				{
					description: `Optional allowlist of domains to filter results to, up to ${MAX_DOMAINS}`,
				},
			),
		),
		objective: Type.Optional(
			Type.String({
				description:
					"Which documents should rank first and which facts to extract. Defaults to the query when omitted.",
			}),
		),
	},
	{ additionalProperties: false },
);

export interface WebsearchResultItem {
	title: string;
	url: string;
	snippet: string;
	domain: string;
	publishedDate?: string;
}

export interface WebsearchDetails {
	provider: "exa";
	transport: "mcp";
	tool: string;
	query: string;
	objective: string;
	requestedLimit?: number;
	appliedLimit: number;
	domains: string[];
	resultCount: number;
	results: WebsearchResultItem[];
	outputTruncation: ReturnType<typeof truncateToolText>;
	fullOutputPath?: string;
	warnings: string[];
}

export const WebsearchOutput = Type.Object(
	{
		query: Type.String({ description: "Query sent to the provider" }),
		objective: Type.String({ description: "Objective sent to the provider" }),
		domains: Type.Array(Type.String(), { description: "Client-side domain filters that were applied" }),
		resultCount: Type.Number({ description: "Number of results returned" }),
		fullOutputPath: Type.Optional(
			Type.String({ description: "Temp file with the complete output when truncated" }),
		),
		warnings: Type.Array(Type.String(), { description: "Non-fatal issues encountered while searching" }),
		results: Type.Array(
			Type.Object(
				{
					title: Type.String(),
					url: Type.String(),
					snippet: Type.String(),
					domain: Type.String(),
					publishedDate: Type.Optional(Type.String()),
				},
				{ additionalProperties: false },
			),
			{ description: "Normalized search results" },
		),
	},
	{ additionalProperties: false },
);

/** Text block shape returned by the built-in MCP integration. */
export interface McpTextContent {
	type: string;
	text?: string;
}

/** Normalized subset of the built-in MCP tool outcome this tool depends on. */
export interface McpToolOutcome {
	isError: boolean;
	content: McpTextContent[];
	structuredContent?: unknown;
}

export type McpCallTool = (toolName: string, args: Record<string, unknown>) => Promise<McpToolOutcome>;

export interface WebsearchOptions {
	callTool: McpCallTool;
	onProgress?: (message: string) => void;
}

interface ParsedMcpSearchBlock {
	title?: string;
	url?: string;
	publishedDate?: string;
	highlights: string[];
}

// Clamp rather than reject; see clampTimeout in shared.ts for why the schemas omit constraints.
function normalizeLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function normalizeQuery(query: string): string {
	const trimmed = query.trim();
	if (!trimmed) throw new Error("websearch requires a non-empty query");
	return trimmed;
}

function normalizeObjective(objective: string | undefined, query: string): string {
	const trimmed = objective?.trim();
	return (trimmed && trimmed.length > 0 ? trimmed : query).slice(0, MAX_OBJECTIVE_CHARS);
}

function buildSearchError(message: string): Error {
	if (/not found|unknown tool|no such tool|unknown server/i.test(message)) {
		return new Error(
			`websearch requires the "${EXA_SERVER_NAME}" MCP server (url https://mcp.exa.ai/mcp) in mcp.json`,
		);
	}
	if (/401|403|unauthorized|forbidden|auth/i.test(message)) {
		return new Error(
			`websearch authentication failed; check the "${EXA_SERVER_NAME}" server configuration in mcp.json`,
		);
	}
	if (/429|rate limit/i.test(message)) {
		return new Error("websearch rate limited by provider");
	}
	if (!message.trim()) {
		return new Error("websearch failed: MCP response contained no output");
	}
	return new Error(`websearch failed: ${message}`);
}

function extractOutcomeText(outcome: McpToolOutcome): string {
	return outcome.content
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => (item.text ?? "").trim())
		.filter(Boolean)
		.join("\n\n");
}

function domainMatches(host: string, filter: string): boolean {
	return host === filter || host.endsWith(`.${filter}`);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Built-in MCP connects servers in the background and only waits for `codemode`, `tool_search`, and
 * resource tools, so a custom tool calling `ctx.executeTool()` can race the first connection. Poll
 * the registered tool list until the server's tool appears, or the timeout/abort ends the wait.
 */
async function waitForMcpTool(
	isRegistered: () => boolean,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!isRegistered()) {
		if (Date.now() >= deadline || signal?.aborted) return isRegistered();
		await sleep(MCP_READY_POLL_MS, signal);
	}
	return true;
}

function parseSearchBlock(block: string): ParsedMcpSearchBlock | undefined {
	const lines = block.replace(/\r\n/g, "\n").split("\n");
	const parsed: ParsedMcpSearchBlock = { highlights: [] };
	let inHighlights = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		if (trimmed.startsWith("Title:")) {
			parsed.title = trimmed.slice("Title:".length).trim();
			inHighlights = false;
			continue;
		}
		if (trimmed.startsWith("URL:")) {
			parsed.url = trimmed.slice("URL:".length).trim();
			inHighlights = false;
			continue;
		}
		if (trimmed.startsWith("Published:")) {
			const published = trimmed.slice("Published:".length).trim();
			parsed.publishedDate = published === "N/A" ? undefined : published;
			inHighlights = false;
			continue;
		}
		if (trimmed.startsWith("Author:")) {
			inHighlights = false;
			continue;
		}
		if (trimmed === "Highlights:") {
			inHighlights = true;
			continue;
		}
		if (inHighlights && trimmed !== "[...]" && !trimmed.startsWith("Title:")) {
			parsed.highlights.push(trimmed);
		}
	}

	if (!parsed.url) return undefined;
	return parsed;
}

function parseMcpSearchText(text: string): ParsedMcpSearchBlock[] {
	return text
		.split(/\n\s*---\s*\n/g)
		.map((block) => block.trim())
		.filter(Boolean)
		.map(parseSearchBlock)
		.filter((block): block is ParsedMcpSearchBlock => Boolean(block));
}

function pickSnippet(block: ParsedMcpSearchBlock): string {
	const uniqueLines = [...new Set(block.highlights.map((line) => normalizeWhitespace(line)).filter(Boolean))];
	const combined = uniqueLines.join(" ").trim();
	return clipText(combined || "No snippet available.", 320);
}

function normalizeResult(block: ParsedMcpSearchBlock): WebsearchResultItem | undefined {
	if (!block.url) return undefined;

	let parsed: URL;
	try {
		parsed = validateHttpUrl(block.url, "result URL");
	} catch {
		return undefined;
	}

	const title = block.title && block.title.trim().length > 0 ? clipText(block.title, 200) : parsed.hostname;
	return {
		title,
		url: parsed.toString(),
		snippet: pickSnippet(block),
		domain: parsed.hostname.toLowerCase(),
		publishedDate: block.publishedDate,
	};
}

function renderResults(query: string, domains: string[], results: WebsearchResultItem[]): string {
	const lines: string[] = [`Search results for "${query}"`];
	if (domains.length > 0) lines.push(`Domains: ${domains.join(", ")}`);
	lines.push(`Results: ${results.length}`);
	lines.push("");

	if (results.length === 0) {
		lines.push("No search results found.");
		return lines.join("\n");
	}

	for (const [index, result] of results.entries()) {
		lines.push(`${index + 1}. ${result.title}`);
		lines.push(`   URL: ${result.url}`);
		lines.push(`   Snippet: ${normalizeWhitespace(result.snippet)}`);
		const meta: string[] = [`domain=${result.domain}`];
		if (result.publishedDate) meta.push(`published=${result.publishedDate}`);
		lines.push(`   Meta: ${meta.join(" | ")}`);
		lines.push("");
	}

	return lines.join("\n").trim();
}

export async function executeWebsearch(
	params: Static<typeof WebsearchParams>,
	options: WebsearchOptions,
): Promise<{
	content: { type: "text"; text: string }[];
	details: WebsearchDetails;
	structuredContent: Static<typeof WebsearchOutput>;
}> {
	const query = normalizeQuery(params.query);
	const appliedLimit = normalizeLimit(params.limit);
	const domains = normalizeDomainFilters(params.domains).slice(0, MAX_DOMAINS);
	const objective = normalizeObjective(params.objective, query);
	const warnings: string[] = [];

	// The hosted Exa tool has no domain filter, so request extra results and filter client-side.
	const requestedResults = domains.length > 0 ? MAX_LIMIT : appliedLimit;

	let outcome: McpToolOutcome;
	try {
		options.onProgress?.("Searching the web...");
		outcome = await options.callTool(EXA_SEARCH_TOOL, {
			query,
			objective,
			numResults: requestedResults,
		});
	} catch (error) {
		throw buildSearchError(error instanceof Error ? error.message : String(error));
	}

	const text = extractOutcomeText(outcome);
	if (outcome.isError) throw buildSearchError(text);
	if (!text) throw buildSearchError("");

	const parsedBlocks = parseMcpSearchText(text);
	const normalizedResults = parsedBlocks
		.map((block) => normalizeResult(block))
		.filter((item): item is WebsearchResultItem => Boolean(item));

	if (parsedBlocks.length === 0) {
		warnings.push("MCP search response did not match the expected result block format.");
	}
	if (parsedBlocks.length > normalizedResults.length) {
		warnings.push(
			`${parsedBlocks.length - normalizedResults.length} malformed result(s) were discarded during normalization.`,
		);
	}

	const filtered =
		domains.length > 0
			? normalizedResults.filter((result) => domains.some((domain) => domainMatches(result.domain, domain)))
			: normalizedResults;
	if (domains.length > 0 && filtered.length < normalizedResults.length) {
		warnings.push(
			`${normalizedResults.length - filtered.length} result(s) outside the requested domains were filtered out.`,
		);
	}

	const results = filtered.slice(0, appliedLimit);
	if (results.length < filtered.length) {
		warnings.push(`${filtered.length - results.length} result(s) over the limit of ${appliedLimit} were dropped.`);
	}

	const rendered = renderResults(query, domains, results);
	options.onProgress?.(`Found ${results.length} result${results.length === 1 ? "" : "s"}.`);
	const outputTruncation = truncateToolText(rendered);
	const fullOutputPath = outputTruncation.truncated ? await persistFullOutput(rendered, "websearch") : undefined;
	if (outputTruncation.truncated) {
		warnings.push("Search results were truncated for model context safety.");
	}

	const outputParts: string[] = [];
	if (warnings.length > 0) {
		outputParts.push(warnings.map((warning) => `[${warning}]`).join("\n"));
	}
	outputParts.push(outputTruncation.content);
	const truncationNotice = formatTruncationNotice(outputTruncation);
	if (truncationNotice) outputParts.push(truncationNotice);
	if (fullOutputPath) outputParts.push(`[Full output saved to: ${fullOutputPath}]`);

	const details: WebsearchDetails = {
		provider: "exa",
		transport: "mcp",
		tool: EXA_SEARCH_TOOL,
		query,
		objective,
		requestedLimit: params.limit,
		appliedLimit,
		domains,
		resultCount: results.length,
		results,
		outputTruncation,
		fullOutputPath,
		warnings,
	};

	const structuredContent: Static<typeof WebsearchOutput> = {
		query,
		objective,
		domains,
		resultCount: results.length,
		fullOutputPath,
		warnings,
		results: results.map((result) => ({
			title: result.title,
			url: result.url,
			snippet: result.snippet,
			domain: result.domain,
			...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
		})),
	};

	return {
		content: [{ type: "text", text: outputParts.filter(Boolean).join("\n\n") }],
		details,
		structuredContent,
	};
}

export function registerWebsearchTool(pi: ExtensionAPI) {
	const tool = defineTool<typeof WebsearchParams, WebsearchDetails | undefined>({
		name: "websearch",
		label: "Web Search",
		description:
			"Search the public web for relevant pages and return normalized result summaries. Best for discovering candidate URLs before using webfetch.",
		promptSnippet: "Search the public web for relevant pages and return candidate URLs with snippets.",
		promptGuidelines: [
			"Use websearch when you need to discover relevant URLs rather than read a known page.",
			"Use websearch before webfetch when you need candidate pages first, then use webfetch to inspect the most relevant result.",
			"Use websearch with domains when the user wants results constrained to specific documentation or company sites.",
			"Use websearch with objective to say which documents should rank first or which facts to extract.",
		],
		parameters: WebsearchParams,
		outputSchema: WebsearchOutput,
		namespace: WEB_TOOLS_NAMESPACE,
		annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Best-effort wait for a still-connecting server; if the tool is absent or excluded from
			// the active tool set, `executeTool` reports it and `executeWebsearch` maps the error.
			await waitForMcpTool(
				() => pi.getAllTools().some((tool) => tool.name === EXA_SEARCH_TOOL),
				MCP_READY_TIMEOUT_MS,
				signal,
			);
			return executeWebsearch(params, {
				onProgress: (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: undefined }),
				callTool: async (toolName, args) => {
					const outcome = await ctx.executeTool(toolName, args, { signal });
					return {
						isError: outcome.isError,
						content: outcome.result.content,
						structuredContent: outcome.result.structuredContent,
					};
				},
			});
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("websearch"))} ${theme.fg("accent", `"${clipText(args?.query ?? "(missing query)", 90)}"`)}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const textOutput = result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text ?? "")
				.join("\n")
				.trim();
			const details = result.details;

			if (isPartial) {
				const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				component.setText(theme.fg("warning", textOutput || "Searching the web..."));
				return component;
			}

			if (!expanded) {
				const count = details?.resultCount ?? 0;
				const query = details?.query ? ` for "${details.query}"` : "";
				const warnings = details?.warnings?.length
					? theme.fg(
							"warning",
							` · ${details.warnings.length} warning${details.warnings.length === 1 ? "" : "s"}`,
						)
					: "";
				const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				component.setText(
					`${theme.fg(context.isError ? "error" : "success", context.isError ? "✗" : "✓")} ${theme.fg("toolOutput", `${count} result${count === 1 ? "" : "s"}${query}`)}${warnings}${theme.fg("dim", ` (${keyHint("app.tools.expand", "to expand")})`)}`,
				);
				return component;
			}

			const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			component.setText(theme.fg("toolOutput", textOutput || "(no output)"));
			return component;
		},
	});
	pi.registerTool(tool);
}
