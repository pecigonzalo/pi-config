import { relative } from "node:path";
import { captureSignature } from "./extractors";
import type { Definition, SourceFile } from "./types";

export const LSP_MANAGER_REQUEST_EVENT = "lsp-manager:request";

export interface LspPosition {
	line: number;
	column: number;
}

export interface LspLocation {
	file: string;
	line: number;
	column: number;
	endLine?: number;
	endColumn?: number;
}

export interface LspHoverInfo {
	file: string;
	line: number;
	column: number;
	contents: string;
}

export interface LspDocumentSymbol {
	name: string;
	kind: string;
	file: string;
	line: number;
	column: number;
	endLine?: number;
	endColumn?: number;
	container?: string;
}

export interface LspRequestOptions {
	signal?: AbortSignal;
}

export interface LspManagerService {
	supportsFile?(filePath: string): boolean;
	definition(filePath: string, position: LspPosition, options?: LspRequestOptions): Promise<LspLocation[]>;
	references(filePath: string, position: LspPosition, options?: LspRequestOptions): Promise<LspLocation[]>;
	hover(filePath: string, position: LspPosition, options?: LspRequestOptions): Promise<LspHoverInfo | undefined>;
	documentSymbols?(filePath: string, options?: LspRequestOptions): Promise<LspDocumentSymbol[]>;
}

interface LspManagerServiceRequest {
	respond(service: LspManagerService | undefined): void;
}

export function getLspService(pi: { events: unknown }): LspManagerService | undefined {
	const eventBus = pi.events as { emit?: (channel: string, data: unknown) => void };
	if (typeof eventBus.emit !== "function") return undefined;
	let service: unknown;
	eventBus.emit(LSP_MANAGER_REQUEST_EVENT, {
		respond(value: LspManagerService | undefined) {
			service = value;
		},
	} satisfies LspManagerServiceRequest);
	if (!service || typeof service !== "object") return undefined;
	const candidate = service as Partial<LspManagerService>;
	if (
		typeof candidate.definition === "function" &&
		typeof candidate.references === "function" &&
		typeof candidate.hover === "function"
	) {
		return candidate as LspManagerService;
	}
	return undefined;
}

export function formatRelativeLocation(cwd: string, file: string, line: number, column: number): string {
	const displayFile = relative(cwd, file) || file;
	return `${displayFile}:${line}:${column}`;
}

export function formatLspLocations(cwd: string, header: string, locations: LspLocation[]): string {
	if (locations.length === 0) return `${header}\nNo LSP locations found.`;
	const out = [header, `Showing ${locations.length} location(s).`, ""];
	for (const location of locations.slice(0, 100)) {
		const start = formatRelativeLocation(cwd, location.file, location.line, location.column);
		const end = location.endLine && location.endColumn ? `-${location.endLine}:${location.endColumn}` : "";
		out.push(`- ${start}${end}`);
	}
	if (locations.length > 100) out.push(`- ... ${locations.length - 100} more location(s) omitted.`);
	return out.join("\n");
}

export function hydrateLspDocumentSymbols(file: SourceFile, text: string, symbols: LspDocumentSymbol[]): Definition[] {
	if (symbols.length === 0) return [];
	const lines = text.split(/\r?\n/);
	return symbols.flatMap((symbol) => {
		if (!isMappableLspDocumentSymbol(symbol)) return [];
		const kind = normalizeLspSymbolKind(symbol.kind);
		const line = Math.max(0, symbol.line - 1);
		return [
			{
				name: symbol.name,
				kind,
				file: file.relPath,
				line,
				column: Math.max(0, symbol.column - 1),
				text: lines[line]?.trimEnd() ?? symbol.name,
				signatureLines: captureSignature(lines, line, file.language),
				score: 0,
				backend: "lsp-document-symbol" as const,
				container: symbol.container,
			},
		];
	});
}

export function identifierAtPosition(text: string, line: number, column: number): string | undefined {
	const lines = text.split(/\r?\n/);
	const sourceLine = lines[Math.max(0, Math.floor(line) - 1)];
	if (!sourceLine) return undefined;
	const cursor = Math.max(0, Math.min(sourceLine.length, Math.floor(column) - 1));
	const identifierRe = /[A-Za-z_$][A-Za-z0-9_$]*/g;
	for (const match of sourceLine.matchAll(identifierRe)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (cursor >= start && cursor <= end) return match[0];
	}
	return undefined;
}

export function isMappableLspDocumentSymbol(symbol: LspDocumentSymbol): boolean {
	return shouldIncludeLspSymbol(normalizeLspSymbolKind(symbol.kind), symbol);
}

function shouldIncludeLspSymbol(kind: string, symbol: LspDocumentSymbol): boolean {
	if (["class", "enum", "function", "interface", "method", "module", "namespace", "struct"].includes(kind))
		return true;
	return !symbol.container && ["const", "variable"].includes(kind);
}

function normalizeLspSymbolKind(kind: string): string {
	const lower = kind.toLowerCase();
	if (lower === "constructor") return "method";
	if (lower === "constant") return "const";
	if (lower === "property" || lower === "field") return "property";
	return lower;
}
