import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
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
	clipText,
	DEFAULT_TIMEOUT_SECONDS,
	MAX_TIMEOUT_SECONDS,
	WEB_TOOLS_NAMESPACE,
} from "./shared";

const MAX_FETCH_BYTES = 2 * 1024 * 1024; // 2MB raw response cap before normalization.

export const WebfetchParams = Type.Object(
	{
		url: Type.String({ description: "HTTP(S) URL to fetch" }),
		format: Type.Optional(
			StringEnum(["markdown", "text", "html"] as const, {
				description: "Response format (default: markdown for HTML, text otherwise)",
			}),
		),
		timeout: Type.Optional(
			Type.Number({
				description: `Timeout in seconds, integer (1..${MAX_TIMEOUT_SECONDS}, default ${DEFAULT_TIMEOUT_SECONDS})`,
			}),
		),
	},
	{ additionalProperties: false },
);

export type WebfetchFormat = "markdown" | "text" | "html";

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

export const WebfetchOutput = Type.Object(
	{
		url: Type.String({ description: "Requested URL" }),
		finalUrl: Type.String({ description: "URL after redirects" }),
		status: Type.Number({ description: "HTTP status code" }),
		ok: Type.Boolean({ description: "Whether the response status is 2xx" }),
		contentType: Type.String({ description: "Raw content-type header" }),
		contentKind: StringEnum(["html", "text", "json", "xml", "unknown"] as const, {
			description: "Content family inferred from the content type",
		}),
		appliedFormat: StringEnum(["markdown", "text", "html"] as const, {
			description: "Format actually returned to the model",
		}),
		title: Type.Optional(Type.String({ description: "Document title when the response is HTML" })),
		responseBytes: Type.Number({ description: "Bytes read from the response body" }),
		responseTruncated: Type.Boolean({ description: "Whether the raw body hit the size cap" }),
		warnings: Type.Array(Type.String(), { description: "Non-fatal issues encountered while fetching" }),
	},
	{ additionalProperties: false },
);

function toWebfetchOutput(details: WebfetchDetails): Static<typeof WebfetchOutput> {
	return {
		url: details.url,
		finalUrl: details.finalUrl,
		status: details.status,
		ok: details.ok,
		contentType: details.contentType,
		contentKind: details.contentKind,
		appliedFormat: details.appliedFormat,
		...(details.title ? { title: details.title } : {}),
		responseBytes: details.responseBytes,
		responseTruncated: details.responseTruncated,
		warnings: details.warnings,
	};
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

function safeCodePointToString(code: number): string | undefined {
	if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return undefined;
	try {
		return String.fromCodePoint(code);
	} catch {
		return undefined;
	}
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
			return safeCodePointToString(code) ?? match;
		}
		if (entity.startsWith("#")) {
			const code = Number.parseInt(entity.slice(1), 10);
			return safeCodePointToString(code) ?? match;
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
	params: Static<typeof WebfetchParams>,
	options?: {
		signal?: AbortSignal;
		fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
		onProgress?: (message: string) => void;
	},
): Promise<{
	content: { type: "text"; text: string }[];
	details: WebfetchDetails;
	structuredContent: Static<typeof WebfetchOutput>;
}> {
	const fetchImpl = options?.fetchImpl ?? fetch;
	const parsedUrl = validateHttpUrl(params.url, "URL");
	const timeoutSeconds = clampTimeout(params.timeout);
	const requestedFormat = params.format;

	const timedSignal = createTimedSignal(options?.signal, timeoutSeconds);
	try {
		options?.onProgress?.(`Fetching ${parsedUrl.toString()}...`);
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

		options?.onProgress?.(`HTTP ${response.status} received; normalizing...`);
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
			const details: WebfetchDetails = {
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
			};
			return {
				content: [{ type: "text", text: outputTruncation.content }],
				details,
				structuredContent: toWebfetchOutput(details),
			};
		}

		const bodyRead = await readBodyWithLimit(response.body, MAX_FETCH_BYTES, timedSignal.signal);
		const decodedBody = decodeBuffer(bodyRead.buffer, contentType.charset);
		const title = contentKind === "html" ? extractTitle(decodedBody) : undefined;
		const normalized = normalizeForFormat(decodedBody, contentKind, appliedFormat);
		const outputSource = normalized || "(empty response body)";
		const outputTruncation = truncateToolText(outputSource);

		if (bodyRead.truncated) {
			warnings.push(
				`Response exceeded ${Math.round(MAX_FETCH_BYTES / 1024)}KB and was truncated before normalization.`,
			);
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
			structuredContent: toWebfetchOutput(details),
		};
	} finally {
		timedSignal.cleanup();
	}
}

export function registerWebfetchTool(pi: ExtensionAPI) {
	const tool = defineTool<typeof WebfetchParams, WebfetchDetails | undefined>({
		name: "webfetch",
		label: "Web Fetch",
		description:
			"Fetch and normalize a single HTTP(S) URL in read-only mode. Supports markdown/text/html output with timeout and size limits.",
		promptSnippet: "Fetch and normalize a specific URL into readable markdown, text, or html.",
		promptGuidelines: [
			"Use webfetch when you already have a specific URL and need to inspect its contents.",
			'Use webfetch with format="markdown" or format="text" for readable extraction, and use format="html" only when raw markup is required.',
			"Use webfetch for one URL at a time; webfetch is read-only and does not perform search or recursive browsing.",
		],
		parameters: WebfetchParams,
		outputSchema: WebfetchOutput,
		namespace: WEB_TOOLS_NAMESPACE,
		annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
		async execute(_toolCallId, params, signal, onUpdate) {
			return executeWebfetch(params, {
				signal,
				onProgress: (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: undefined }),
			});
		},
		renderCall(args, theme) {
			const displayUrl = clipText(args?.url ?? "(missing url)", 100);
			return new Text(`${theme.fg("toolTitle", theme.bold("webfetch"))} ${theme.fg("accent", displayUrl)}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const textOutput = result.content
				.filter((item) => item.type === "text")
				.map((item) => item.text ?? "")
				.join("\n")
				.trim();
			const details = result.details;

			if (isPartial) {
				return new Text(theme.fg("warning", textOutput || "Fetching URL content..."), 0, 0);
			}

			if (!expanded) {
				const target = details?.title ?? details?.finalUrl ?? details?.url ?? "URL fetched";
				const format = details?.appliedFormat ? ` (${details.appliedFormat})` : "";
				const warnings = details?.warnings?.length
					? theme.fg(
							"warning",
							` · ${details.warnings.length} warning${details.warnings.length === 1 ? "" : "s"}`,
						)
					: "";
				return new Text(
					`${theme.fg("success", "✓")} ${theme.fg("toolOutput", target)}${theme.fg("muted", format)}${warnings}${theme.fg("dim", ` (${keyHint("app.tools.expand", "to expand")})`)}`,
					0,
					0,
				);
			}

			return new Text(theme.fg("toolOutput", textOutput || "(no output)"), 0, 0);
		},
	});
	pi.registerTool(tool);
}
