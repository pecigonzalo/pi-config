/**
 * Shared contracts between lsp-manager and its consumers (code-hints,
 * code-intel). This module is dependency-free so consumers can import the
 * event names and service types without pulling in the service implementation
 * or vscode-languageserver-protocol.
 */

/** Emitted when an LSP manager service is available for the current session. */
export const LSP_MANAGER_READY_EVENT = "lsp-manager:ready";

/** Emitted when an LSP manager service is shutting down. */
export const LSP_MANAGER_SHUTDOWN_EVENT = "lsp-manager:shutdown";

/** Emitted by consumers to request the current LSP manager service. */
export const LSP_MANAGER_REQUEST_EVENT = "lsp-manager:request";

export interface LspManagerServiceRequest {
	respond(service: LspManagerService | undefined): void;
}

export type LspDiagnosticSeverity = "error" | "warning" | "info" | "hint";
export type LspDiagnosticStatus = "ok" | "unsupported" | "timeout" | "error";

export interface LspPosition {
	line: number;
	column: number;
}

export interface LspDiagnosticItem {
	file: string;
	line: number;
	column: number;
	severity: LspDiagnosticSeverity;
	message: string;
	source?: string;
	code?: string;
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

export interface LspFileDiagnostics {
	file: string;
	status: LspDiagnosticStatus;
	diagnostics: LspDiagnosticItem[];
	error?: string;
}

export interface LspStatusItem {
	id: string;
	command: string;
	extensions: string[];
	available: boolean;
	running: boolean;
	openFiles: number;
	diagnostics: number;
	root?: string;
}

export interface LspDiagnosticsOptions {
	timeoutMs?: number;
	severity?: "error" | "warning" | "info" | "hint" | "all";
	signal?: AbortSignal;
}

export interface LspTouchOptions {
	waitForDiagnostics?: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface LspRequestOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

/**
 * Reusable service exposed by the lsp-manager extension.
 *
 * Semantic lookups (definition, references, hover, documentSymbols) resolve to
 * an empty result when the server fails or times out, so consumers can treat
 * them like "not found". Requests are bounded by a default timeout of 5s
 * unless `timeoutMs` is provided.
 */
export interface LspManagerService {
	supportsFile(filePath: string): boolean;
	warmup(filePath: string, options?: LspRequestOptions): Promise<boolean>;
	touchFile(filePath: string, options?: LspTouchOptions): Promise<LspFileDiagnostics>;
	diagnostics(filePaths: string[], options?: LspDiagnosticsOptions): Promise<LspFileDiagnostics[]>;
	definition(filePath: string, position: LspPosition, options?: LspRequestOptions): Promise<LspLocation[]>;
	references(filePath: string, position: LspPosition, options?: LspRequestOptions): Promise<LspLocation[]>;
	hover(filePath: string, position: LspPosition, options?: LspRequestOptions): Promise<LspHoverInfo | undefined>;
	documentSymbols(filePath: string, options?: LspRequestOptions): Promise<LspDocumentSymbol[]>;
	status(): LspStatusItem[];
	shutdown(): Promise<void>;
}
