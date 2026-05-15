import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
	clampTimeout,
	clipText,
	createTimedSignal,
	createToolUserAgent,
	formatTruncationNotice,
	normalizeDomainFilters,
	normalizeWhitespace,
	truncateToolText,
	validateHttpUrl,
	DEFAULT_TIMEOUT_SECONDS,
} from "./shared";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const EXA_BASE_URL = process.env.EXA_BASE_URL || "https://api.exa.ai";
const EXA_TIMEOUT_SECONDS = clampTimeout(
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
		rateLimit?: {
			retryAfterSeconds?: number;
			remaining?: number;
			resetAt?: string;
		};
	};
}

interface ExaSearchResponse {
	requestId?: string;
	results?: unknown[];
}

interface ExaResultCandidate {
	title?: unknown;
	url?: unknown;
	highlights?: unknown;
	text?: unknown;
	summary?: unknown;
	score?: unknown;
	publishedDate?: unknown;
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

function pickSnippet(candidate: ExaResultCandidate): string {
	const highlights = Array.isArray(candidate.highlights)
		? candidate.highlights.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		: [];
	const text = typeof candidate.text === "string" ? candidate.text : undefined;
	const summary = typeof candidate.summary === "string" ? candidate.summary : undefined;
	const snippetSource = highlights[0] ?? summary ?? text ?? "";
	return clipText(snippetSource || "No snippet available.", 320);
}

function normalizeResult(candidate: ExaResultCandidate): WebsearchResultItem | undefined {
	if (typeof candidate.url !== "string") return undefined;

	let parsed: URL;
	try {
		parsed = validateHttpUrl(candidate.url, "result URL");
	} catch {
		return undefined;
	}

	const title = typeof candidate.title === "string" && candidate.title.trim().length > 0
		? clipText(candidate.title, 200)
		: parsed.hostname;
	const snippet = pickSnippet(candidate);
	const score = typeof candidate.score === "number" && Number.isFinite(candidate.score) ? candidate.score : undefined;
	const publishedDate = typeof candidate.publishedDate === "string" && candidate.publishedDate.trim().length > 0
		? candidate.publishedDate
		: undefined;

	return {
		title,
		url: parsed.toString(),
		snippet,
		domain: parsed.hostname.toLowerCase(),
		score,
		publishedDate,
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
		if (typeof result.score === "number") meta.push(`score=${result.score.toFixed(3)}`);
		if (result.publishedDate) meta.push(`published=${result.publishedDate}`);
		lines.push(`   Meta: ${meta.join(" | ")}`);
		lines.push("");
	}

	return lines.join("\n").trim();
}

async function callExaSearch(
	request: { query: string; limit: number; domains: string[]; mode: WebsearchMode },
	options?: { signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<{ response: Response; body: ExaSearchResponse }> {
	const fetchImpl = options?.fetchImpl ?? fetch;
	const apiKey = process.env.EXA_API_KEY;
	if (!apiKey) {
		throw new Error("websearch is not configured: set EXA_API_KEY in the environment");
	}

	const timedSignal = createTimedSignal(options?.signal, EXA_TIMEOUT_SECONDS);
	try {
		let response: Response;
		try {
			response = await fetchImpl(`${EXA_BASE_URL.replace(/\/$/, "")}/search`, {
				method: "POST",
				signal: timedSignal.signal,
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					"x-api-key": apiKey,
					"user-agent": createToolUserAgent("websearch"),
				},
				body: JSON.stringify({
					query: request.query,
					type: mapModeToExaType(request.mode),
					numResults: request.limit,
					includeDomains: request.domains.length > 0 ? request.domains : undefined,
					contents: {
						highlights: true,
					},
				}),
			});
		} catch (error) {
			if (timedSignal.didTimeout()) {
				throw new Error(`websearch timed out after ${EXA_TIMEOUT_SECONDS}s`);
			}
			throw new Error(`websearch failed: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (response.status === 401 || response.status === 403) {
			throw new Error("websearch authentication failed; check EXA_API_KEY");
		}
		if (response.status === 429) {
			const retryAfter = response.headers.get("retry-after");
			throw new Error(`websearch rate limited by provider${retryAfter ? `; retry after ${retryAfter}s` : ""}`);
		}
		if (response.status >= 500) {
			throw new Error(`websearch provider unavailable (HTTP ${response.status})`);
		}

		let body: ExaSearchResponse;
		try {
			body = (await response.json()) as ExaSearchResponse;
		} catch {
			throw new Error("websearch provider returned an invalid JSON response");
		}

		if (!response.ok) {
			const message =
				body && typeof body === "object" && "error" in body && typeof (body as { error?: unknown }).error === "string"
					? (body as { error: string }).error
					: undefined;
			throw new Error(`websearch provider error (HTTP ${response.status})${message ? `: ${message}` : ""}`);
		}

		return { response, body };
	} finally {
		timedSignal.cleanup();
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

	const { response, body } = await callExaSearch({ query, limit: appliedLimit, domains, mode }, options);
	const rawResults = Array.isArray(body.results) ? body.results : [];
	const normalizedResults = rawResults
		.map((item) => normalizeResult(item as ExaResultCandidate))
		.filter((item): item is WebsearchResultItem => Boolean(item))
		.slice(0, appliedLimit);

	if (!Array.isArray(body.results)) {
		warnings.push("Provider response did not include a results array.");
	}
	if (rawResults.length > normalizedResults.length) {
		warnings.push(`${rawResults.length - normalizedResults.length} malformed result(s) were discarded during normalization.`);
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
			requestId: typeof body.requestId === "string" ? body.requestId : undefined,
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
		promptSnippet: "Search the public web for candidate pages; returns titles, URLs, snippets, and compact metadata.",
		promptGuidelines: [
			"Use websearch when you need to discover relevant URLs across the public web rather than read a specific known page.",
			"Use websearch before webfetch when you need candidate URLs first, then use webfetch to inspect the most relevant result pages.",
			"Use websearch with domains when the user wants results constrained to specific documentation or company sites.",
			'Use websearch with mode="exact" for exact identifiers, package names, quoted text, or error messages; use websearch with mode="semantic" for topic or concept discovery.',
		],
		parameters: WebsearchParams,
		async execute(_toolCallId, params, signal) {
			return executeWebsearch(params, { signal });
		},
	});
}
