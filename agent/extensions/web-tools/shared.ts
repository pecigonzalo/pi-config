import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_TIMEOUT_SECONDS = 15;
export const MAX_TIMEOUT_SECONDS = 120;
export const DEFAULT_FETCH_USER_AGENT = "pi-web-tools/0.1";
export const OUTPUT_MAX_LINES = Math.min(DEFAULT_MAX_LINES, 700);
export const OUTPUT_MAX_BYTES = Math.min(DEFAULT_MAX_BYTES, 30 * 1024);

export type ContentKind = "html" | "text" | "json" | "xml" | "unknown";

export interface TimedSignal {
	signal: AbortSignal;
	cleanup: () => void;
	didTimeout: () => boolean;
}

export interface ContentTypeInfo {
	mime: string;
	raw: string;
	charset?: string;
}

export function clampTimeout(timeout: number | undefined): number {
	if (typeof timeout !== "number" || !Number.isFinite(timeout)) return DEFAULT_TIMEOUT_SECONDS;
	return Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Math.floor(timeout)));
}

export function validateHttpUrl(rawUrl: string, label = "URL"): URL {
	const trimmed = rawUrl.trim();
	if (!trimmed) throw new Error(`${label} must not be empty`);

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`Invalid ${label.toLowerCase()}: ${rawUrl}`);
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`${label} must use http or https (got ${parsed.protocol})`);
	}
	return parsed;
}

export function normalizeWhitespace(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function clipText(text: string, maxChars: number): string {
	const normalized = normalizeWhitespace(text);
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function parseContentType(headerValue: string | null): ContentTypeInfo {
	if (!headerValue) return { mime: "", raw: "" };
	const raw = headerValue.trim();
	const [mimePart = "", ...parts] = raw.split(";");
	const mime = mimePart.trim().toLowerCase();

	let charset: string | undefined;
	for (const part of parts) {
		const [key, value] = part.split("=");
		if (key?.trim().toLowerCase() === "charset" && value) {
			charset = value.trim().replace(/^"|"$/g, "");
			break;
		}
	}

	return { mime, raw, charset };
}

export function detectContentKind(mime: string): ContentKind {
	if (!mime) return "unknown";
	if (mime.includes("html")) return "html";
	if (mime.includes("json") || mime.endsWith("+json")) return "json";
	if (mime.includes("xml") || mime.endsWith("+xml")) return "xml";
	if (mime.startsWith("text/")) return "text";
	return "unknown";
}

export function isTextLikeMime(mime: string): boolean {
	if (!mime) return true;
	if (mime.startsWith("text/")) return true;
	if (mime.includes("json") || mime.endsWith("+json")) return true;
	if (mime.includes("xml") || mime.endsWith("+xml")) return true;
	if (mime === "application/javascript" || mime === "application/x-javascript") return true;
	if (mime === "application/xhtml+xml") return true;
	if (mime === "image/svg+xml") return true;
	return false;
}

export function createTimedSignal(parentSignal: AbortSignal | undefined, timeoutSeconds: number): TimedSignal {
	const controller = new AbortController();
	let timedOut = false;

	const timeoutId = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutSeconds * 1000);

	const onAbort = () => controller.abort();
	if (parentSignal) {
		if (parentSignal.aborted) controller.abort();
		else parentSignal.addEventListener("abort", onAbort, { once: true });
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeoutId);
			parentSignal?.removeEventListener("abort", onAbort);
		},
		didTimeout: () => timedOut,
	};
}

export async function readBodyWithLimit(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	signal: AbortSignal,
): Promise<{ buffer: Buffer; truncated: boolean }> {
	if (!body) return { buffer: Buffer.alloc(0), truncated: false };

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let truncated = false;

	try {
		while (true) {
			if (signal.aborted) throw new Error("aborted");
			const { done, value } = await reader.read();
			if (done || !value) break;

			if (bytes + value.byteLength <= maxBytes) {
				chunks.push(value);
				bytes += value.byteLength;
				continue;
			}

			const remaining = maxBytes - bytes;
			if (remaining > 0) {
				chunks.push(value.slice(0, remaining));
				bytes += remaining;
			}

			truncated = true;
			break;
		}
	} finally {
		if (truncated) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}

	return { buffer: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), truncated };
}

export function decodeBuffer(buffer: Buffer, charset: string | undefined): string {
	if (buffer.length === 0) return "";

	if (charset) {
		try {
			return new TextDecoder(charset as any).decode(buffer);
		} catch {
			// Fall back to utf-8.
		}
	}

	return new TextDecoder("utf-8").decode(buffer);
}

export function truncateToolText(
	content: string,
	options?: { maxLines?: number; maxBytes?: number },
): TruncationResult {
	return truncateHead(content, {
		maxLines: options?.maxLines ?? OUTPUT_MAX_LINES,
		maxBytes: options?.maxBytes ?? OUTPUT_MAX_BYTES,
	});
}

export function formatTruncationNotice(truncation: TruncationResult): string {
	if (!truncation.truncated) return "";
	const omittedLines = truncation.totalLines - truncation.outputLines;
	const omittedBytes = truncation.totalBytes - truncation.outputBytes;
	return `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ${omittedLines} lines (${formatSize(omittedBytes)}) omitted.]`;
}

export function createToolUserAgent(toolName: string): string {
	return `${DEFAULT_FETCH_USER_AGENT} ${toolName}`;
}

export function normalizeDomainFilters(domains: string[] | undefined): string[] {
	if (!domains) return [];
	const normalized = new Set<string>();

	for (const domain of domains) {
		const trimmed = domain.trim().toLowerCase();
		if (!trimmed) continue;

		const host = trimmed
			.replace(/^https?:\/\//, "")
			.split("/")[0]
			?.replace(/:\d+$/, "");
		if (!host || !/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) {
			throw new Error(`Invalid domain filter: ${domain}`);
		}
		normalized.add(host);
	}

	return [...normalized];
}
