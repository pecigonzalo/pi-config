import { StringEnum } from "@mariozechner/pi-ai";
import { keyHint, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { callMcpTool } from "./mcp";
import {
	clampTimeout,
	clipText,
	formatTruncationNotice,
	normalizeDomainFilters,
	normalizeWhitespace,
	truncateToolText,
	validateHttpUrl,
	DEFAULT_TIMEOUT_SECONDS,
} from "./shared";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const DEFAULT_EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const EXA_MCP_TIMEOUT_SECONDS = clampTimeout(
	process.env.WEBSEARCH_TIMEOUT_SECONDS ? Number(process.env.WEBSEARCH_TIMEOUT_SECONDS) : DEFAULT_TIMEOUT_SECONDS,
);

export const WebsearchParams = Type.Object({
	query: Type.String({ description: "Search query for discovering relevant public web pages" }),
	limit: Type.Optional(Type.Number({ description: `Maximum number of results to return (1..${MAX_LIMIT}, default ${DEFAULT_LIMIT})` })),
	domains: Type.Optional(
		Type.Array(Type.String({ description: "Restrict search to a domain or subdomain, e.g. docs.example.com" }), {
			description: "Optional allowlist of domains to search within",
			maxItems: 10,
		}),
	),
	mode: Type.Optional(
		StringEnum(["auto", "exact", "semantic"] as const, {
			description:
				'Search mode: "auto" (default), "exact" for identifiers/error text/package names, or "semantic" for conceptual/topic retrieval',
		}),
	),
});

export type WebsearchMode = "auto" | "exact" | "semantic";

export interface WebsearchParamsInput {
	query: string;
	limit?: number;
	domains?: string[];
	mode?: WebsearchMode;
}

export interface WebsearchResultItem {
	title: string;
	url: string;
	snippet: string;
	domain: string;
	score?: number;
	publishedDate?: string;
}

export interface WebsearchDetails {
	provider: "exa";
	transport: "mcp";
	query: string;
	mode: WebsearchMode;
	requestedLimit?: number;
	appliedLimit: number;
	domains: string[];
	resultCount: number;
	results: WebsearchResultItem[];
	outputTruncation: ReturnType<typeof truncateToolText>;
	warnings: string[];
	response: {
		status?: number;
		requestId?: string;
		endpoint: string;
		rateLimit?: {
			retryAfterSeconds?: number;
			remaining?: number;
			resetAt?: string;
		};
	};
}

interface ParsedMcpSearchBlock {
	title?: string;
	url?: string;
	publishedDate?: string;
	highlights: string[];
}

function normalizeLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function normalizeMode(mode: WebsearchMode | undefined): WebsearchMode {
	return mode ?? "auto";
}

function normalizeQuery(query: string): string {
	const trimmed = query.trim();
	if (!trimmed) throw new Error("websearch requires a non-empty query");
	return trimmed;
}

function mapModeToExaType(mode: WebsearchMode): string {
	switch (mode) {
		case "exact":
			return "fast";
		case "semantic":
			return "neural";
		case "auto":
		default:
			return "auto";
	}
}

function parseHeaderNumber(value: string | null): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

interface ExaMcpRequestConfig {
	endpoint: string;
	headers?: Record<string, string>;
}

function isSensitiveQueryParam(paramName: string): boolean {
	const normalized = paramName.toLowerCase();
	return normalized === "exaapikey" || /(^|[_-])(api)?key$/i.test(normalized) || /(token|secret|auth|password)/i.test(normalized);
}

function sanitizeEndpointForDetails(endpoint: string): string {
	let parsed: URL;
	try {
		parsed = new URL(endpoint);
	} catch {
		return endpoint;
	}

	for (const key of new Set(parsed.searchParams.keys())) {
		if (!isSensitiveQueryParam(key)) continue;
		parsed.searchParams.set(key, "REDACTED");
	}

	return parsed.toString();
}

function buildExaMcpRequest(): ExaMcpRequestConfig {
	const endpoint = new URL(process.env.EXA_MCP_URL || DEFAULT_EXA_MCP_URL).toString();
	const apiKey = process.env.EXA_API_KEY?.trim();
	if (!apiKey) return { endpoint };

	return {
		endpoint,
		headers: {
			authorization: `Bearer ${apiKey}`,
			"x-api-key": apiKey,
		},
	};
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

function renderResults(query: string, mode: WebsearchMode, domains: string[], results: WebsearchResultItem[]): string {
	const lines: string[] = [`Search results for \"${query}\"`, `Mode: ${mode}`];
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

async function callExaMcpSearch(
	request: { query: string; limit: number; domains: string[]; mode: WebsearchMode },
	options?: { signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<{ response: Response; requestId?: string; text: string; endpoint: string }> {
	const mcpRequest = buildExaMcpRequest();

	try {
		const { response, text } = await callMcpTool({
			url: mcpRequest.endpoint,
			toolName: "web_search_exa",
			args: {
				query: request.query,
				type: mapModeToExaType(request.mode),
				numResults: request.limit,
				livecrawl: "fallback",
				includeDomains: request.domains.length > 0 ? request.domains : undefined,
			},
			timeoutSeconds: EXA_MCP_TIMEOUT_SECONDS,
			signal: options?.signal,
			fetchImpl: options?.fetchImpl,
			headers: mcpRequest.headers,
		});

		const requestId = text.match(/"requestId":"([^"]+)"/)?.[1];
		return { response, requestId, text, endpoint: sanitizeEndpointForDetails(mcpRequest.endpoint) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/HTTP 401|HTTP 403|auth/i.test(message)) {
			throw new Error("websearch authentication failed; check EXA_API_KEY or remove it to use unauthenticated MCP access");
		}
		if (/HTTP 429|rate limit/i.test(message)) {
			throw new Error("websearch rate limited by provider");
		}
		throw new Error(`websearch failed: ${message}`);
	}
}

export async function executeWebsearch(
	params: WebsearchParamsInput,
	options?: { signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<{ content: { type: "text"; text: string }[]; details: WebsearchDetails }> {
	const query = normalizeQuery(params.query);
	const appliedLimit = normalizeLimit(params.limit);
	const mode = normalizeMode(params.mode);
	const domains = normalizeDomainFilters(params.domains);
	const warnings: string[] = [];

	const { response, requestId, text, endpoint } = await callExaMcpSearch({ query, limit: appliedLimit, domains, mode }, options);
	const parsedBlocks = parseMcpSearchText(text);
	const normalizedResults = parsedBlocks
		.map((block) => normalizeResult(block))
		.filter((item): item is WebsearchResultItem => Boolean(item))
		.slice(0, appliedLimit);

	if (parsedBlocks.length === 0 && text.trim().length > 0) {
		warnings.push("MCP search response did not match the expected result block format.");
	}
	if (parsedBlocks.length > normalizedResults.length) {
		warnings.push(`${parsedBlocks.length - normalizedResults.length} malformed result(s) were discarded during normalization.`);
	}

	const rendered = renderResults(query, mode, domains, normalizedResults);
	const outputTruncation = truncateToolText(rendered);
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

	const details: WebsearchDetails = {
		provider: "exa",
		transport: "mcp",
		query,
		mode,
		requestedLimit: params.limit,
		appliedLimit,
		domains,
		resultCount: normalizedResults.length,
		results: normalizedResults,
		outputTruncation,
		warnings,
		response: {
			status: response.status,
			requestId,
			endpoint,
			rateLimit: {
				retryAfterSeconds: parseHeaderNumber(response.headers.get("retry-after")),
				remaining: parseHeaderNumber(response.headers.get("x-ratelimit-remaining")),
				resetAt: response.headers.get("x-ratelimit-reset") ?? undefined,
			},
		},
	};

	return {
		content: [{ type: "text", text: outputParts.filter(Boolean).join("\n\n") }],
		details,
	};
}

export function registerWebsearchTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "websearch",
		label: "Web Search",
		description:
			"Search the public web for relevant pages and return normalized result summaries. Best for discovering candidate URLs before using webfetch.",
		promptSnippet: "Search the public web for relevant pages and return candidate URLs with snippets.",
		promptGuidelines: [
			"Use websearch when you need to discover relevant URLs rather than read a known page.",
			"Use websearch before webfetch when you need candidate pages first, then use webfetch to inspect the most relevant result.",
			"Use websearch with domains when the user wants results constrained to specific documentation or company sites.",
			'Use websearch with mode="exact" for exact identifiers, package names, quoted text, or error messages; use websearch with mode="semantic" for broader topic discovery.',
		],
		parameters: WebsearchParams,
		async execute(_toolCallId, params, signal) {
			return executeWebsearch(params, { signal });
		},
		renderCall(args, theme) {
			const rawQuery = typeof (args as { query?: unknown })?.query === "string"
				? ((args as { query: string }).query ?? "")
				: "(missing query)";
			const mode = typeof (args as { mode?: unknown })?.mode === "string" ? ` ${theme.fg("muted", `[${(args as { mode: string }).mode}]`)}` : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("websearch"))} ${theme.fg("accent", `\"${clipText(rawQuery, 90)}\"`)}${mode}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const textOutput = result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text ?? "")
				.join("\n")
				.trim();
			const details = result.details as WebsearchDetails | undefined;

			if (isPartial) {
				return new Text(theme.fg("warning", "Searching the web..."), 0, 0);
			}

			if (!expanded) {
				const count = details?.resultCount ?? 0;
				const query = details?.query ? ` for \"${details.query}\"` : "";
				const warnings = details?.warnings?.length
					? theme.fg("warning", ` · ${details.warnings.length} warning${details.warnings.length === 1 ? "" : "s"}`)
					: "";
				return new Text(
					`${theme.fg("success", "✓")} ${theme.fg("toolOutput", `${count} result${count === 1 ? "" : "s"}${query}`)}${warnings}${theme.fg("dim", ` (${keyHint("app.tools.expand", "to expand")})`)}`,
					0,
					0,
				);
			}

			return new Text(theme.fg("toolOutput", textOutput || "(no output)"), 0, 0);
		},
	});
}
