import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { CodeIntelDetails, CodeIntelParams } from "./types";

export function matchCount(text: string, re: RegExp): string | undefined {
	const match = text.match(re);
	if (!match) return;
	if (match[2]) return `${match[1]}/${match[2]}`;
	return match[1];
}

export function summarizeResult(params: Partial<CodeIntelParams>, text: string): string {
	const firstLine = text
		.split("\n")
		.find((line) => line.trim())
		?.trim();
	const scope = params.path ?? params.query ?? params.symbol ?? params.root;
	const prefix = scope ? `${scope}` : (firstLine ?? "complete");
	const counts = [
		matchCount(text, /Scanned (\d+) source file/),
		matchCount(text, /found (\d+) definition/),
		matchCount(text, /Showing (\d+) of (\d+) match/),
	]
		.filter(Boolean)
		.join(", ");
	return counts ? `${prefix} (${counts})` : prefix;
}

export function normalizeCodeIntelParams(params: CodeIntelParams): CodeIntelParams {
	const normalized: Partial<CodeIntelParams> = { action: params.action };
	for (const [key, value] of Object.entries(params)) {
		if (key === "action") continue;
		if (value === undefined || value === null) continue;
		if (typeof value === "string" && value === "") continue;
		if (typeof value === "number" && value === 0) continue;
		if (Array.isArray(value) && value.length === 0) continue;
		if (key === "sliceMode" && value === "any") continue;
		(normalized as Record<string, unknown>)[key] = value;
	}
	return normalized as CodeIntelParams;
}

export function buildDetails(params: Partial<CodeIntelParams>, text: string): CodeIntelDetails {
	const lines = text.split("\n");
	return {
		action: params.action,
		summary: summarizeResult(params, text),
		lineCount: lines.length,
		byteCount: Buffer.byteLength(text, "utf8"),
		firstLine: lines.find((line) => line.trim())?.trim(),
	};
}

export function textResult(text: string, details?: CodeIntelDetails) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

export function formatAction(action?: string): string {
	return action ?? "code_intel";
}

export function quoteArg(value: string): string {
	if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
	return JSON.stringify(value.length > 80 ? `${value.slice(0, 77)}...` : value);
}

export function formatCallHint(
	args: Partial<CodeIntelParams>,
	theme: { fg: (name: any, value: string) => string; bold: (value: string) => string },
): string {
	const action = formatAction(args.action);
	const parts: string[] = [];
	if (args.path) parts.push(`path=${quoteArg(args.path)}`);
	if (args.symbol) parts.push(`symbol=${quoteArg(args.symbol)}`);
	if (args.query) parts.push(`query=${quoteArg(args.query)}`);
	if (args.line !== undefined) parts.push(`line=${args.line}`);
	if (args.column !== undefined) parts.push(`column=${args.column}`);
	if (args.mapTokens !== undefined) parts.push(`mapTokens=${args.mapTokens}`);
	if (args.maxFiles !== undefined) parts.push(`maxFiles=${args.maxFiles}`);
	if (args.sliceMode) parts.push(`sliceMode=${args.sliceMode}`);
	if (args.include?.length) parts.push(`include=${quoteArg(args.include.join(","))}`);
	if (args.exclude?.length) parts.push(`exclude=${quoteArg(args.exclude.join(","))}`);
	if (args.root) parts.push(`root=${quoteArg(args.root)}`);

	let text = theme.fg("toolTitle", theme.bold("code_intel"));
	text += " " + theme.fg("accent", action);
	if (parts.length > 0) text += " " + theme.fg("muted", parts.join(" "));
	return text;
}

export function truncateForTool(text: string): string {
	const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncation.truncated) return text;
	return `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
		truncation.outputBytes,
	)} of ${formatSize(truncation.totalBytes)}).]`;
}

export function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

export function normalizePath(path: string): string {
	return path.split(/[/\\]/).join("/");
}

export function looksBinary(text: string): boolean {
	return text.includes("\0");
}
