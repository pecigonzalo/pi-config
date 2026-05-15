import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import TurndownService from "turndown";
import {
	clampTimeout,
	createTimedSignal,
	createToolUserAgent,
	decodeBuffer,
	detectContentKind,
	type ContentKind,
	formatTruncationNotice,
	isTextLikeMime,
	parseContentType,
	readBodyWithLimit,
	truncateToolText,
	validateHttpUrl,
	normalizeWhitespace,
	DEFAULT_TIMEOUT_SECONDS,
	MAX_TIMEOUT_SECONDS,
} from "./shared";

const MAX_FETCH_BYTES = 2 * 1024 * 1024; // 2MB raw response cap before normalization.

export const WebfetchParams = Type.Object({
	url: Type.String({ description: "HTTP(S) URL to fetch" }),
	format: Type.Optional(
		StringEnum(["markdown", "text", "html"] as const, {
			description: "Response format (default: markdown for HTML, text otherwise)",
		}),
	),
	timeout: Type.Optional(
		Type.Number({ description: `Timeout in seconds (1..${MAX_TIMEOUT_SECONDS}, default ${DEFAULT_TIMEOUT_SECONDS})` }),
	),
});

export type WebfetchFormat = "markdown" | "text" | "html";

export interface WebfetchParamsInput {
	url: string;
	format?: WebfetchFormat;
	timeout?: number;
}

export interface WebfetchDetails {
	url: string;
	finalUrl: string;
	status: number;
	statusText: string;
	ok: boolean;
	contentType: string;
	contentKind: ContentKind;
	requestedFormat?: WebfetchFormat;
	appliedFormat: WebfetchFormat;
	timeoutSeconds: number;
	responseBytes: number;
	responseTruncated: boolean;
	outputTruncation: ReturnType<typeof truncateToolText>;
	title?: string;
	warnings: string[];
}

const turndownService = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	bulletListMarker: "-",
});

function chooseOutputFormat(requested: WebfetchFormat | undefined, contentKind: ContentKind): WebfetchFormat {
	if (requested) return requested;
	return contentKind === "html" ? "markdown" : "text";
}

function cleanHtml(html: string): string {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "");
}

function decodeHtmlEntities(input: string): string {
	const named: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
	};

	return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
		if (entity.startsWith("#x") || entity.startsWith("#X")) {
			const code = Number.parseInt(entity.slice(2), 16);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		if (entity.startsWith("#")) {
			const code = Number.parseInt(entity.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		const lower = entity.toLowerCase();
		return named[lower] ?? match;
	});
}

function htmlToMarkdown(html: string): string {
	const cleaned = cleanHtml(html);
	const markdown = turndownService.turndown(cleaned);
	return normalizeWhitespace(markdown);
}

function markdownToText(markdown: string): string {
	const withoutCodeFences = markdown
		.replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-zA-Z0-9_-]*\n?/g, "").replace(/```/g, ""))
		.replace(/`([^`]+)`/g, "$1");

	const text = withoutCodeFences
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^>\s?/gm, "")
		.replace(/[*_~]/g, "");

	return normalizeWhitespace(text);
}

function extractTitle(html: string): string | undefined {
	const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
	if (!match?.[1]) return undefined;
	const decoded = decodeHtmlEntities(match[1]);
	const normalized = normalizeWhitespace(decoded);
	return normalized || undefined;
}

function normalizeForFormat(content: string, kind: ContentKind, format: WebfetchFormat): string {
	if (kind === "html") {
		if (format === "html") return content.trim();
		const markdown = htmlToMarkdown(content);
		if (format === "markdown") return markdown;
		return markdownToText(markdown);
	}

	if (format === "html") return content.trim();
	return normalizeWhitespace(content);
}

export async function executeWebfetch(
	params: WebfetchParamsInput,
	options?: {
		signal?: AbortSignal;
		fetchImpl?: typeof fetch;
	},
): Promise<{ content: { type: "text"; text: string }[]; details: WebfetchDetails }> {
	const fetchImpl = options?.fetchImpl ?? fetch;
	const parsedUrl = validateHttpUrl(params.url, "URL");
	const timeoutSeconds = clampTimeout(params.timeout);
	const requestedFormat = params.format;

	const timedSignal = createTimedSignal(options?.signal, timeoutSeconds);
	try {
		let response: Response;
		try {
			response = await fetchImpl(parsedUrl.toString(), {
				signal: timedSignal.signal,
				redirect: "follow",
				headers: {
					accept: "text/html, text/plain, application/json, application/xml;q=0.9, text/*;q=0.8, */*;q=0.1",
					"user-agent": createToolUserAgent("webfetch"),
				},
			});
		} catch (error) {
			if (timedSignal.didTimeout()) {
				throw new Error(`webfetch timed out after ${timeoutSeconds}s`);
			}
			throw new Error(`webfetch failed: ${error instanceof Error ? error.message : String(error)}`);
		}

		const contentType = parseContentType(response.headers.get("content-type"));
		const contentKind = detectContentKind(contentType.mime);
		const appliedFormat = chooseOutputFormat(requestedFormat, contentKind);
		const warnings: string[] = [];

		if (!isTextLikeMime(contentType.mime)) {
			warnings.push(`Unsupported non-text content type: ${contentType.raw || "unknown"}`);
			const summary = [
				`webfetch cannot normalize this URL because the response is not text-like (${contentType.raw || "unknown content type"}).`,
				"Try another URL or use a tool meant for binary downloads.",
			].join("\n");
			const outputTruncation = truncateToolText(summary);
			return {
				content: [{ type: "text", text: outputTruncation.content }],
				details: {
					url: parsedUrl.toString(),
					finalUrl: response.url || parsedUrl.toString(),
					status: response.status,
					statusText: response.statusText,
					ok: response.ok,
					contentType: contentType.raw || "",
					contentKind,
					requestedFormat,
					appliedFormat,
					timeoutSeconds,
					responseBytes: 0,
					responseTruncated: false,
					outputTruncation,
					warnings,
				},
			};
		}

		const bodyRead = await readBodyWithLimit(response.body, MAX_FETCH_BYTES, timedSignal.signal);
		const decodedBody = decodeBuffer(bodyRead.buffer, contentType.charset);
		const title = contentKind === "html" ? extractTitle(decodedBody) : undefined;
		const normalized = normalizeForFormat(decodedBody, contentKind, appliedFormat);
		const outputSource = normalized || "(empty response body)";
		const outputTruncation = truncateToolText(outputSource);

		if (bodyRead.truncated) {
			warnings.push(`Response exceeded ${Math.round(MAX_FETCH_BYTES / 1024)}KB and was truncated before normalization.`);
		}
		if (outputTruncation.truncated) {
			warnings.push("Normalized output was truncated for model context safety.");
		}
		if (!response.ok) {
			warnings.push(`HTTP ${response.status} ${response.statusText}`.trim());
		}
		if (!contentType.raw) {
			warnings.push("Response did not include a content-type header.");
		}

		const outputParts: string[] = [];
		if (warnings.length > 0) {
			outputParts.push(warnings.map((warning) => `[${warning}]`).join("\n"));
		}
		outputParts.push(outputTruncation.content);
		const truncationNotice = formatTruncationNotice(outputTruncation);
		if (truncationNotice) outputParts.push(truncationNotice);

		const details: WebfetchDetails = {
			url: parsedUrl.toString(),
			finalUrl: response.url || parsedUrl.toString(),
			status: response.status,
			statusText: response.statusText,
			ok: response.ok,
			contentType: contentType.raw,
			contentKind,
			requestedFormat,
			appliedFormat,
			timeoutSeconds,
			responseBytes: bodyRead.buffer.byteLength,
			responseTruncated: bodyRead.truncated,
			outputTruncation,
			title,
			warnings,
		};

		return {
			content: [{ type: "text", text: outputParts.filter(Boolean).join("\n\n") }],
			details,
		};
	} finally {
		timedSignal.cleanup();
	}
}

export function registerWebfetchTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "webfetch",
		label: "Web Fetch",
		description:
			"Fetch and normalize a single HTTP(S) URL in read-only mode. Supports markdown/text/html output with timeout and size limits.",
		promptSnippet: "Fetch one URL with webfetch and return model-friendly markdown/text/html output.",
		promptGuidelines: [
			"Use webfetch when you need to read a specific URL instead of composing ad hoc bash + curl pipelines.",
			'Use webfetch with format="markdown" or format="text" for readable extraction, and use format="html" only when raw markup is required.',
			"Use webfetch for one URL at a time; webfetch is read-only and does not perform recursive browsing.",
		],
		parameters: WebfetchParams,
		async execute(_toolCallId, params, signal) {
			return executeWebfetch(params, { signal });
		},
	});
}
