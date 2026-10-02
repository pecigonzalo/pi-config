import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createMessageConnection,
	ConfigurationRequest,
	DidChangeTextDocumentNotification,
	DidCloseTextDocumentNotification,
	DidOpenTextDocumentNotification,
	DidSaveTextDocumentNotification,
	InitializedNotification,
	DefinitionRequest,
	DocumentSymbolRequest,
	HoverRequest,
	InitializeRequest,
	PublishDiagnosticsNotification,
	ReferencesRequest,
	StreamMessageReader,
	StreamMessageWriter,
	type MessageConnection,
} from "vscode-languageserver-protocol/node";
import type {
	ConfigurationParams,
	Diagnostic,
	DocumentSymbol,
	Hover,
	Location,
	LocationLink,
	SymbolInformation,
} from "vscode-languageserver-protocol";
import type {
	LspDiagnosticItem,
	LspDiagnosticSeverity,
	LspDiagnosticsOptions,
	LspDocumentSymbol,
	LspFileDiagnostics,
	LspHoverInfo,
	LspLocation,
	LspManagerService,
	LspPosition,
	LspRequestOptions,
	LspStatusItem,
	LspTouchOptions,
} from "./contract";

export { LSP_MANAGER_READY_EVENT, LSP_MANAGER_REQUEST_EVENT, LSP_MANAGER_SHUTDOWN_EVENT } from "./contract";
export type {
	LspDiagnosticItem,
	LspDiagnosticSeverity,
	LspDiagnosticStatus,
	LspDiagnosticsOptions,
	LspDocumentSymbol,
	LspFileDiagnostics,
	LspHoverInfo,
	LspLocation,
	LspManagerService,
	LspManagerServiceRequest,
	LspPosition,
	LspRequestOptions,
	LspStatusItem,
	LspTouchOptions,
} from "./contract";

const INIT_TIMEOUT_MS = 30_000;
const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 3_000;
const DEFAULT_SEMANTIC_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_FILE_BYTES = 1_048_576;
const PROCESS_EXIT_TIMEOUT_MS = 1_000;
const MAX_OPEN_FILES = 40;
const DEFAULT_MAX_CLIENTS = 8;
const DEFAULT_CLIENT_IDLE_TIMEOUT_MS = 10 * 60_000;
const CONFIGURATION_SECTION_ROOTS = new Set([
	"gopls",
	"javascript",
	"javascriptreact",
	"pyright",
	"python",
	"rust-analyzer",
	"rust_analyzer",
	"terraform",
	"terraform-ls",
	"typescript",
	"typescriptreact",
]);

interface ServerDefinition {
	id: string;
	command: string;
	args: string[];
	extensions: string[];
	rootMarkers: string[];
	languageId: (filePath: string) => string;
}

interface OpenDocumentState {
	version: number;
	lastUsedAt: number;
}

interface LspClientState {
	id: string;
	root: string;
	command: string;
	process: ChildProcessWithoutNullStreams;
	connection: MessageConnection;
	diagnostics: Map<string, Diagnostic[]>;
	listeners: Map<string, Set<(received: boolean) => void>>;
	openFiles: Map<string, OpenDocumentState>;
	closed: boolean;
	lastUsedAt: number;
	idleTimer?: ReturnType<typeof setTimeout>;
}

const SERVER_DEFINITIONS: ServerDefinition[] = [
	{
		id: "typescript",
		command: "typescript-language-server",
		args: ["--stdio"],
		extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
		// package.json is intentionally not a marker: every package in a JS monorepo
		// has one, which started a language server per package. tsconfig.json and
		// jsconfig.json are the actual TypeScript project markers.
		rootMarkers: ["tsconfig.json", "jsconfig.json"],
		languageId: (filePath) => {
			const ext = extname(filePath).toLowerCase();
			if (ext === ".tsx") return "typescriptreact";
			if (ext === ".jsx") return "javascriptreact";
			if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
			return "typescript";
		},
	},
	{
		id: "python",
		command: "pyright-langserver",
		args: ["--stdio"],
		extensions: [".py", ".pyi"],
		rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt", ".git"],
		languageId: () => "python",
	},
	{
		id: "go",
		command: "gopls",
		args: [],
		extensions: [".go"],
		rootMarkers: ["go.mod", ".git"],
		languageId: () => "go",
	},
	{
		id: "rust",
		command: "rust-analyzer",
		args: [],
		extensions: [".rs"],
		rootMarkers: ["Cargo.toml", ".git"],
		languageId: () => "rust",
	},
	{
		id: "terraform",
		command: "terraform-ls",
		args: ["serve"],
		extensions: [".tf", ".tfvars", ".tfcomponent.hcl", ".tfstack.hcl", ".tfdeploy.hcl", ".tfquery.hcl"],
		rootMarkers: [".terraform", ".terraform.lock.hcl", "terraform.tf", "main.tf", ".git"],
		languageId: (filePath) => {
			const lowerPath = filePath.toLowerCase();
			if (lowerPath.endsWith(".tfvars")) return "terraform-vars";
			if (lowerPath.endsWith(".tfcomponent.hcl") || lowerPath.endsWith(".tfstack.hcl")) return "terraform-stack";
			if (lowerPath.endsWith(".tfdeploy.hcl")) return "terraform-deploy";
			if (lowerPath.endsWith(".tfquery.hcl")) return "terraform-search";
			return "terraform";
		},
	},
];

function commandExists(command: string): boolean {
	const searchPaths = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
	const suffixes = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];

	for (const dir of searchPaths) {
		if (!dir) continue;
		for (const suffix of suffixes) {
			const candidate = join(dir, command + suffix.toLowerCase());
			if (existsSync(candidate)) return true;
			const upperCandidate = join(dir, command + suffix.toUpperCase());
			if (existsSync(upperCandidate)) return true;
		}
	}
	return false;
}

function normalizePath(filePath: string): string {
	const absolute = resolve(filePath);
	try {
		return realpathSync.native(absolute);
	} catch {
		// Realpath the deepest existing ancestor so nonexistent paths stay on the
		// same canonical prefix (e.g. /var vs /private/var) as existing ones.
		let current = absolute;
		const remainder: string[] = [];
		for (;;) {
			try {
				return join(realpathSync.native(current), ...remainder);
			} catch {
				const parent = dirname(current);
				if (parent === current) return absolute;
				remainder.unshift(basename(current));
				current = parent;
			}
		}
	}
}

function isWithinWorkspace(absolutePath: string, workspaceRoot: string): boolean {
	const rel = relative(workspaceRoot, absolutePath);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isFileTooLarge(absolutePath: string, maxFileBytes: number): boolean {
	if (maxFileBytes <= 0) return false;
	try {
		return statSync(absolutePath).size > maxFileBytes;
	} catch {
		return false;
	}
}

function workspaceValidationError(
	absolutePath: string,
	workspaceRoot: string,
	maxFileBytes: number,
): string | undefined {
	if (!isWithinWorkspace(absolutePath, workspaceRoot)) {
		return `Path is outside the session workspace (${workspaceRoot}).`;
	}
	return isFileTooLarge(absolutePath, maxFileBytes) ? tooLargeError(maxFileBytes) : undefined;
}

function tooLargeError(maxFileBytes: number): string {
	return `File is too large for LSP processing (limit ${maxFileBytes} bytes).`;
}

function uriToPath(uri: string): string {
	try {
		return normalizePath(fileURLToPath(uri));
	} catch {
		return normalizePath(decodeURIComponent(new URL(uri).pathname));
	}
}

function findNearestRoot(startPath: string, cwd: string, markers: string[]): string | undefined {
	let current = dirname(normalizePath(startPath));
	const stop = normalizePath(cwd);

	while (current.length >= stop.length) {
		for (const marker of markers) {
			if (existsSync(join(current, marker))) return current;
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return existsSync(stop) ? stop : undefined;
}

function serverForFile(filePath: string): ServerDefinition | undefined {
	const lowerPath = filePath.toLowerCase();
	return SERVER_DEFINITIONS.find((server) => server.extensions.some((extension) => lowerPath.endsWith(extension)));
}

function severityName(value: number | undefined): LspDiagnosticSeverity {
	if (value === 2) return "warning";
	if (value === 3) return "info";
	if (value === 4) return "hint";
	return "error";
}

function severityRank(value: LspDiagnosticSeverity): number {
	switch (value) {
		case "error":
			return 1;
		case "warning":
			return 2;
		case "info":
			return 3;
		case "hint":
			return 4;
	}
}

function diagnosticMessageToText(message: Diagnostic["message"]): string {
	return typeof message === "string" ? message : message.value;
}

function diagnosticToItem(file: string, diagnostic: Diagnostic): LspDiagnosticItem {
	const code = diagnostic.code == null ? undefined : String(diagnostic.code);
	return {
		file,
		line: diagnostic.range.start.line + 1,
		column: diagnostic.range.start.character + 1,
		severity: severityName(diagnostic.severity),
		message: diagnosticMessageToText(diagnostic.message),
		source: diagnostic.source,
		code,
	};
}

function filterBySeverity(
	items: LspDiagnosticItem[],
	severity: LspDiagnosticsOptions["severity"],
): LspDiagnosticItem[] {
	if (!severity || severity === "all") return items;
	const maxRank = severityRank(severity);
	return items.filter((item) => severityRank(item.severity) <= maxRank);
}

function positionToLsp(position: LspPosition): { line: number; character: number } {
	return {
		line: Math.max(0, Math.floor(position.line) - 1),
		character: Math.max(0, Math.floor(position.column) - 1),
	};
}

function normalizeLocations(result: Location | Location[] | LocationLink[] | null | undefined): LspLocation[] {
	if (!result) return [];
	const items = Array.isArray(result) ? result : [result];
	return items.flatMap((item) => {
		if (!item) return [];
		if ("uri" in item) {
			return [locationToLspLocation(item.uri, item.range)];
		}
		return [locationToLspLocation(item.targetUri, item.targetSelectionRange ?? item.targetRange)];
	});
}

function locationToLspLocation(uri: string, range: Location["range"]): LspLocation {
	const file = uriToPath(uri);
	return {
		file,
		line: range.start.line + 1,
		column: range.start.character + 1,
		endLine: range.end.line + 1,
		endColumn: range.end.character + 1,
	};
}

function normalizeDocumentSymbols(
	result: DocumentSymbol[] | SymbolInformation[] | null | undefined,
	fallbackFile: string,
): LspDocumentSymbol[] {
	if (!result) return [];
	const symbols: LspDocumentSymbol[] = [];
	for (const item of result) {
		if ("location" in item) {
			symbols.push(symbolInformationToDocumentSymbol(item));
		} else {
			symbols.push(...documentSymbolToDocumentSymbols(item, fallbackFile));
		}
	}
	return symbols;
}

function symbolInformationToDocumentSymbol(symbol: SymbolInformation): LspDocumentSymbol {
	const location = locationToLspLocation(symbol.location.uri, symbol.location.range);
	return {
		name: symbol.name,
		kind: symbolKindName(symbol.kind),
		file: location.file,
		line: location.line,
		column: location.column,
		endLine: location.endLine,
		endColumn: location.endColumn,
		container: symbol.containerName,
	};
}

function documentSymbolToDocumentSymbols(
	symbol: DocumentSymbol,
	file: string,
	container?: string,
): LspDocumentSymbol[] {
	const current = {
		name: symbol.name,
		kind: symbolKindName(symbol.kind),
		file,
		line: symbol.selectionRange.start.line + 1,
		column: symbol.selectionRange.start.character + 1,
		endLine: symbol.range.end.line + 1,
		endColumn: symbol.range.end.character + 1,
		container,
	};
	const children =
		symbol.children?.flatMap((child) => documentSymbolToDocumentSymbols(child, file, symbol.name)) ?? [];
	return [current, ...children];
}

function symbolKindName(kind: number): string {
	const names = [
		"unknown",
		"file",
		"module",
		"namespace",
		"package",
		"class",
		"method",
		"property",
		"field",
		"constructor",
		"enum",
		"interface",
		"function",
		"variable",
		"constant",
		"string",
		"number",
		"boolean",
		"array",
		"object",
		"key",
		"null",
		"enum_member",
		"struct",
		"event",
		"operator",
		"type_parameter",
	];
	return names[kind] ?? `symbol_${kind}`;
}

function hoverContentsToText(contents: Hover["contents"]): string {
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) {
		return contents
			.map((item) => (typeof item === "string" ? item : item.value))
			.filter(Boolean)
			.join("\n\n");
	}
	return contents.value;
}

function resolveWorkspaceConfiguration(params: ConfigurationParams): unknown[] {
	return params.items.map((item) => workspaceConfigurationForSection(item.section));
}

function workspaceConfigurationForSection(section: string | undefined): unknown {
	if (!section) return {};
	const sectionRoot = section.split(".", 1)[0];
	if (sectionRoot && CONFIGURATION_SECTION_ROOTS.has(sectionRoot)) return {};
	return null;
}

function abortError(): Error {
	return new Error("aborted");
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (isAborted(signal)) throw abortError();
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	throwIfAborted(signal);
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const onAbort = () => rejectPromise(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolvePromise(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				rejectPromise(error);
			},
		);
	});
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string, signal?: AbortSignal): Promise<T> {
	return withAbort(
		new Promise<T>((resolvePromise, rejectPromise) => {
			const timer = setTimeout(() => rejectPromise(new Error(`${label} timed out`)), timeoutMs);
			promise.then(
				(value) => {
					clearTimeout(timer);
					resolvePromise(value);
				},
				(error: unknown) => {
					clearTimeout(timer);
					rejectPromise(error);
				},
			);
		}),
		signal,
	);
}

function collectUniqueClients<T>(...clientGroups: Iterable<T>[]): T[] {
	return [...new Set(clientGroups.flatMap((clients) => [...clients]))];
}

const processTerminations = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();

function processHasExited(child: ChildProcessWithoutNullStreams): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

function waitForProcessExit(child: ChildProcessWithoutNullStreams, timeoutMs?: number): Promise<boolean> {
	if (processHasExited(child)) return Promise.resolve(true);
	return new Promise<boolean>((resolvePromise) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const finish = (exited: boolean) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			child.removeListener("exit", onExit);
			resolvePromise(exited);
		};
		const onExit = () => finish(true);
		child.once("exit", onExit);
		if (processHasExited(child)) {
			finish(true);
			return;
		}
		if (timeoutMs !== undefined) {
			timer = setTimeout(() => finish(processHasExited(child)), timeoutMs);
			timer.unref?.();
		}
	});
}

function terminateProcess(child: ChildProcessWithoutNullStreams, timeoutMs = PROCESS_EXIT_TIMEOUT_MS): Promise<void> {
	const existing = processTerminations.get(child);
	if (existing) return existing;

	const termination = Promise.resolve().then(async () => {
		if (processHasExited(child)) return;
		child.kill("SIGTERM");
		if (await waitForProcessExit(child, timeoutMs)) return;
		if (!processHasExited(child)) child.kill("SIGKILL");
		await waitForProcessExit(child);
	});
	processTerminations.set(child, termination);
	return termination;
}

function markClientClosed(
	client: LspClientState,
	clients: Map<string, LspClientState>,
	pendingClients: Set<LspClientState>,
): void {
	client.closed = true;
	if (client.idleTimer) {
		clearTimeout(client.idleTimer);
		client.idleTimer = undefined;
	}
	const key = `${client.id}:${client.root}`;
	if (clients.get(key) === client) clients.delete(key);
	pendingClients.delete(client);
	for (const listeners of client.listeners.values()) {
		for (const listener of listeners) listener(false);
	}
	client.listeners.clear();
	client.openFiles.clear();
	client.diagnostics.clear();
}

function registerClientLifecycle(
	client: LspClientState,
	clients: Map<string, LspClientState>,
	pendingClients: Set<LspClientState>,
	ownedClients: Set<LspClientState>,
): void {
	const closeClient = () => markClientClosed(client, clients, pendingClients);
	const closeAndTerminate = () => {
		closeClient();
		void terminateProcess(client.process).catch(() => undefined);
	};
	const releaseOwnership = () => {
		closeClient();
		ownedClients.delete(client);
	};
	client.connection.onClose(closeAndTerminate);
	client.process.on("error", closeAndTerminate);
	client.process.on("exit", releaseOwnership);
	client.process.on("close", releaseOwnership);
}

/** LSP service implementation backed by stdio language servers. */
export class DefaultLspManagerService implements LspManagerService {
	private readonly clients = new Map<string, LspClientState>();
	private readonly pendingClients = new Set<LspClientState>();
	private readonly ownedClients = new Set<LspClientState>();
	private readonly spawning = new Map<string, Promise<LspClientState | undefined>>();
	private shuttingDown = false;
	private shutdownPromise: Promise<void> | undefined;

	private readonly workspaceRoot: string;
	private readonly maxFileBytes: number;
	private readonly maxClients: number;
	private readonly idleTimeoutMs: number;

	constructor(
		private readonly cwd: string,
		options: { workspaceRoot?: string; maxFileBytes?: number; maxClients?: number; idleTimeoutMs?: number } = {},
	) {
		this.workspaceRoot = normalizePath(options.workspaceRoot ?? cwd);
		this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
		this.maxClients = Math.max(1, options.maxClients ?? DEFAULT_MAX_CLIENTS);
		this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_CLIENT_IDLE_TIMEOUT_MS;
	}

	supportsFile(filePath: string): boolean {
		if (this.shuttingDown) return false;
		const absolutePath = this.resolvePath(filePath);
		if (!isWithinWorkspace(absolutePath, this.workspaceRoot)) return false;
		const server = serverForFile(absolutePath);
		return !!server && commandExists(server.command);
	}

	async warmup(filePath: string, options: LspRequestOptions = {}): Promise<boolean> {
		if (this.shuttingDown || isAborted(options.signal)) return false;
		const absolutePath = this.resolvePath(filePath);
		if (!isWithinWorkspace(absolutePath, this.workspaceRoot) || isFileTooLarge(absolutePath, this.maxFileBytes))
			return false;
		const client = await this.getClientForFile(absolutePath, options.signal).catch(() => undefined);
		return !!client && !isAborted(options.signal);
	}

	async touchFile(filePath: string, options: LspTouchOptions = {}): Promise<LspFileDiagnostics> {
		const absolutePath = this.resolvePath(filePath);
		if (this.shuttingDown || isAborted(options.signal)) {
			return { file: absolutePath, status: "error", diagnostics: [], error: "LSP manager is shutting down." };
		}
		const workspaceIssue = workspaceValidationError(absolutePath, this.workspaceRoot, this.maxFileBytes);
		if (workspaceIssue) {
			return { file: absolutePath, status: "error", diagnostics: [], error: workspaceIssue };
		}
		const server = serverForFile(absolutePath);
		if (!server) {
			return {
				file: absolutePath,
				status: "unsupported",
				diagnostics: [],
				error: `No LSP server configured for ${extname(absolutePath) || "file"}.`,
			};
		}
		if (!existsSync(absolutePath)) {
			return { file: absolutePath, status: "error", diagnostics: [], error: "File does not exist." };
		}

		const client = await this.getClientForFile(absolutePath, options.signal).catch(() => undefined);
		if (!client) {
			return {
				file: absolutePath,
				status: "unsupported",
				diagnostics: [],
				error: `${server.command} is not available or failed to initialize.`,
			};
		}

		if (options.waitForDiagnostics === false) {
			const opened = this.openOrUpdate(client, server, absolutePath);
			if (opened === "too-large") {
				return {
					file: absolutePath,
					status: "error",
					diagnostics: [],
					error: tooLargeError(this.maxFileBytes),
				};
			}
			return { file: absolutePath, status: "ok", diagnostics: [] };
		}

		const outcome = await this.openOrUpdateAndWait(
			client,
			server,
			absolutePath,
			options.timeoutMs ?? DEFAULT_DIAGNOSTIC_TIMEOUT_MS,
			options.signal,
		);
		if (outcome === "too-large") {
			return { file: absolutePath, status: "error", diagnostics: [], error: tooLargeError(this.maxFileBytes) };
		}
		const responded = outcome === "ok";
		const diagnostics = (client.diagnostics.get(absolutePath) ?? []).map((diagnostic) =>
			diagnosticToItem(absolutePath, diagnostic),
		);
		return {
			file: absolutePath,
			status: responded || diagnostics.length > 0 ? "ok" : "timeout",
			diagnostics,
			error: responded || diagnostics.length > 0 ? undefined : "LSP did not publish diagnostics before timeout.",
		};
	}

	async diagnostics(filePaths: string[], options: LspDiagnosticsOptions = {}): Promise<LspFileDiagnostics[]> {
		if (this.shuttingDown || isAborted(options.signal)) {
			return filePaths.map((filePath) => ({
				file: this.resolvePath(filePath),
				status: "error",
				diagnostics: [],
				error: "LSP manager is shutting down.",
			}));
		}
		const timeoutMs = options.timeoutMs ?? DEFAULT_DIAGNOSTIC_TIMEOUT_MS;
		const results: LspFileDiagnostics[] = [];

		for (const filePath of [...new Set(filePaths)]) {
			if (isAborted(options.signal)) break;
			const absolutePath = this.resolvePath(filePath);
			const workspaceIssue = workspaceValidationError(absolutePath, this.workspaceRoot, this.maxFileBytes);
			if (workspaceIssue) {
				results.push({ file: absolutePath, status: "error", diagnostics: [], error: workspaceIssue });
				continue;
			}
			const server = serverForFile(absolutePath);
			if (!server) {
				results.push({
					file: absolutePath,
					status: "unsupported",
					diagnostics: [],
					error: `No LSP server configured for ${extname(absolutePath) || "file"}.`,
				});
				continue;
			}
			if (!existsSync(absolutePath)) {
				results.push({ file: absolutePath, status: "error", diagnostics: [], error: "File does not exist." });
				continue;
			}

			const client = await this.getClientForFile(absolutePath, options.signal).catch(() => undefined);
			if (!client) {
				results.push({
					file: absolutePath,
					status: "unsupported",
					diagnostics: [],
					error: `${server.command} is not available or failed to initialize.`,
				});
				continue;
			}

			const outcome = await this.openOrUpdateAndWait(client, server, absolutePath, timeoutMs, options.signal);
			const rawDiagnostics = client.diagnostics.get(absolutePath) ?? [];
			const diagnostics = filterBySeverity(
				rawDiagnostics.map((diagnostic) => diagnosticToItem(absolutePath, diagnostic)),
				options.severity,
			);
			if (outcome === "too-large") {
				results.push({
					file: absolutePath,
					status: "error",
					diagnostics: [],
					error: tooLargeError(this.maxFileBytes),
				});
				continue;
			}
			const responded = outcome === "ok";
			results.push({
				file: absolutePath,
				status: responded || rawDiagnostics.length > 0 ? "ok" : "timeout",
				diagnostics,
				error:
					responded || rawDiagnostics.length > 0
						? undefined
						: "LSP did not publish diagnostics before timeout.",
			});
		}

		return results;
	}

	async definition(filePath: string, position: LspPosition, options: LspRequestOptions = {}): Promise<LspLocation[]> {
		if (this.shuttingDown || isAborted(options.signal)) return [];
		const loaded = await this.loadSyncedFile(filePath, options.signal);
		if (!loaded || this.shuttingDown || loaded.client.closed || isAborted(options.signal)) return [];
		const result = await withTimeout(
			loaded.client.connection.sendRequest(DefinitionRequest.type, {
				textDocument: { uri: loaded.uri },
				position: positionToLsp(position),
			}),
			options.timeoutMs ?? DEFAULT_SEMANTIC_TIMEOUT_MS,
			`${loaded.client.id} definition`,
			options.signal,
		).catch(() => undefined);
		return normalizeLocations(result);
	}

	async references(filePath: string, position: LspPosition, options: LspRequestOptions = {}): Promise<LspLocation[]> {
		if (this.shuttingDown || isAborted(options.signal)) return [];
		const loaded = await this.loadSyncedFile(filePath, options.signal);
		if (!loaded || this.shuttingDown || loaded.client.closed || isAborted(options.signal)) return [];
		const result = await withTimeout(
			loaded.client.connection.sendRequest(ReferencesRequest.type, {
				textDocument: { uri: loaded.uri },
				position: positionToLsp(position),
				context: { includeDeclaration: true },
			}),
			options.timeoutMs ?? DEFAULT_SEMANTIC_TIMEOUT_MS,
			`${loaded.client.id} references`,
			options.signal,
		).catch(() => undefined);
		return normalizeLocations(result);
	}

	async hover(
		filePath: string,
		position: LspPosition,
		options: LspRequestOptions = {},
	): Promise<LspHoverInfo | undefined> {
		if (this.shuttingDown || isAborted(options.signal)) return undefined;
		const loaded = await this.loadSyncedFile(filePath, options.signal);
		if (!loaded || this.shuttingDown || loaded.client.closed || isAborted(options.signal)) return undefined;
		const result = await withTimeout(
			loaded.client.connection.sendRequest(HoverRequest.type, {
				textDocument: { uri: loaded.uri },
				position: positionToLsp(position),
			}),
			options.timeoutMs ?? DEFAULT_SEMANTIC_TIMEOUT_MS,
			`${loaded.client.id} hover`,
			options.signal,
		).catch(() => undefined);
		if (!result?.contents) return undefined;
		const contents = hoverContentsToText(result.contents).trim();
		if (!contents) return undefined;
		return { file: loaded.absolutePath, line: position.line, column: position.column, contents };
	}

	async documentSymbols(filePath: string, options: LspRequestOptions = {}): Promise<LspDocumentSymbol[]> {
		if (this.shuttingDown || isAborted(options.signal)) return [];
		const loaded = await this.loadSyncedFile(filePath, options.signal);
		if (!loaded || this.shuttingDown || loaded.client.closed || isAborted(options.signal)) return [];
		const result = await withTimeout(
			loaded.client.connection.sendRequest(DocumentSymbolRequest.type, {
				textDocument: { uri: loaded.uri },
			}),
			options.timeoutMs ?? DEFAULT_SEMANTIC_TIMEOUT_MS,
			`${loaded.client.id} documentSymbols`,
			options.signal,
		).catch(() => undefined);
		return normalizeDocumentSymbols(result, loaded.absolutePath);
	}

	status(): LspStatusItem[] {
		const clientsById = new Map<string, LspClientState[]>();
		for (const client of this.clients.values()) {
			const bucket = clientsById.get(client.id) ?? [];
			bucket.push(client);
			clientsById.set(client.id, bucket);
		}

		const items: LspStatusItem[] = [];
		for (const server of SERVER_DEFINITIONS) {
			const clients = clientsById.get(server.id) ?? [];
			if (clients.length === 0) {
				items.push({
					id: server.id,
					command: server.command,
					extensions: [...server.extensions],
					available: commandExists(server.command),
					running: false,
					openFiles: 0,
					diagnostics: 0,
				});
				continue;
			}

			for (const client of clients) {
				items.push({
					id: client.id,
					command: client.command,
					extensions: [...server.extensions],
					available: commandExists(server.command),
					running: !client.closed,
					openFiles: client.openFiles.size,
					diagnostics: [...client.diagnostics.values()].reduce(
						(sum, diagnostics) => sum + diagnostics.length,
						0,
					),
					root: client.root,
				});
			}
		}
		return items;
	}

	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.shuttingDown = true;
		this.shutdownPromise = (async () => {
			const clients = collectUniqueClients(
				this.clients.values(),
				this.pendingClients.values(),
				this.ownedClients.values(),
			);
			this.clients.clear();
			this.pendingClients.clear();
			this.spawning.clear();
			await Promise.all(clients.map((client) => this.shutdownClient(client)));
		})();
		return this.shutdownPromise;
	}

	private resolvePath(filePath: string): string {
		return normalizePath(resolve(this.cwd, filePath));
	}

	private sendNotification(client: LspClientState, method: unknown, params?: unknown): void {
		if (this.shuttingDown || client.closed) return;
		try {
			void Promise.resolve(client.connection.sendNotification(method as never, params as never)).catch(
				() => undefined,
			);
		} catch {
			// Ignore writes racing with LSP process shutdown.
		}
	}

	private touchClient(client: LspClientState): void {
		client.lastUsedAt = Date.now();
		if (client.idleTimer) clearTimeout(client.idleTimer);
		client.idleTimer = setTimeout(() => {
			client.idleTimer = undefined;
			if (client.closed || this.shuttingDown) return;
			void this.shutdownClient(client).catch(() => undefined);
		}, this.idleTimeoutMs);
		client.idleTimer.unref?.();
	}

	private evictClientsForCapacity(): void {
		while (this.clients.size >= this.maxClients) {
			let oldest: LspClientState | undefined;
			for (const client of this.clients.values()) {
				if (!oldest || client.lastUsedAt < oldest.lastUsedAt) oldest = client;
			}
			if (!oldest) return;
			void this.shutdownClient(oldest).catch(() => undefined);
		}
	}

	private clientKey(server: ServerDefinition, root: string): string {
		return `${server.id}:${root}`;
	}

	private async getClientForFile(filePath: string, signal?: AbortSignal): Promise<LspClientState | undefined> {
		if (this.shuttingDown || isAborted(signal)) return undefined;
		const absolutePath = this.resolvePath(filePath);
		if (!isWithinWorkspace(absolutePath, this.workspaceRoot)) return undefined;
		const server = serverForFile(absolutePath);
		if (!server) return undefined;
		if (!commandExists(server.command)) return undefined;

		// Root each language server at its nearest project marker so multi-language
		// repos get the correct module root. TypeScript markers exclude package.json,
		// so a JS monorepo no longer starts a server per package. The client cap and
		// idle eviction bound how many servers stay alive.
		const root = findNearestRoot(absolutePath, this.cwd, server.rootMarkers);
		if (!root) return undefined;
		const key = this.clientKey(server, root);
		const existing = this.clients.get(key);
		if (existing && !existing.closed && !processHasExited(existing.process)) {
			this.touchClient(existing);
			return existing;
		}
		if (existing) this.clients.delete(key);

		let spawning = this.spawning.get(key);
		if (!spawning) {
			this.evictClientsForCapacity();
			spawning = this.startClient(server, root, signal);
			this.spawning.set(key, spawning);
			spawning.finally(() => this.spawning.delete(key));
		}

		const client = await withAbort(spawning, signal).catch(() => undefined);
		if (this.shuttingDown || isAborted(signal) || client?.closed || (client && processHasExited(client.process))) {
			if (client) await this.shutdownClient(client);
			return undefined;
		}
		if (client) {
			this.clients.set(key, client);
			this.touchClient(client);
		}
		return client;
	}

	private async startClient(
		server: ServerDefinition,
		root: string,
		signal?: AbortSignal,
	): Promise<LspClientState | undefined> {
		if (this.shuttingDown || isAborted(signal)) return undefined;
		let child: ChildProcessWithoutNullStreams | undefined;
		try {
			child = spawn(server.command, server.args, {
				cwd: root,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});

			child.stdin.on("error", () => undefined);
			child.stdout.on("error", () => undefined);
			child.stderr.on("data", () => undefined);

			const connection = createMessageConnection(
				new StreamMessageReader(child.stdout),
				new StreamMessageWriter(child.stdin),
			);

			const client: LspClientState = {
				id: server.id,
				root,
				command: server.command,
				process: child,
				connection,
				diagnostics: new Map(),
				listeners: new Map(),
				openFiles: new Map(),
				closed: false,
				lastUsedAt: Date.now(),
			};

			connection.onRequest(ConfigurationRequest.type, (params) => resolveWorkspaceConfiguration(params));
			connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
				const file = uriToPath(params.uri);
				client.diagnostics.set(file, params.diagnostics ?? []);
				for (const listener of client.listeners.get(file) ?? []) {
					listener(true);
				}
			});
			connection.onError(() => undefined);
			this.ownedClients.add(client);
			registerClientLifecycle(client, this.clients, this.pendingClients, this.ownedClients);

			this.pendingClients.add(client);
			if (this.shuttingDown) {
				await this.shutdownClient(client);
				return undefined;
			}
			connection.listen();
			await withTimeout(
				connection.sendRequest(InitializeRequest.method, {
					processId: process.pid,
					rootPath: root,
					rootUri: pathToFileURL(root).href,
					workspaceFolders: [{ name: "workspace", uri: pathToFileURL(root).href }],
					capabilities: {
						workspace: { configuration: true, workspaceFolders: true },
						textDocument: {
							synchronization: { didOpen: true, didChange: true, didSave: true, didClose: true },
							publishDiagnostics: { versionSupport: true },
							definition: {},
							references: {},
							hover: { contentFormat: ["markdown", "plaintext"] },
							documentSymbol: {
								hierarchicalDocumentSymbolSupport: true,
								symbolKind: { valueSet: Array.from({ length: 26 }, (_value, index) => index + 1) },
							},
						},
					},
				}),
				INIT_TIMEOUT_MS,
				`${server.id} initialize`,
				signal,
			);
			this.pendingClients.delete(client);
			if (this.shuttingDown || isAborted(signal) || client.closed || processHasExited(client.process)) {
				await this.shutdownClient(client);
				return undefined;
			}
			this.sendNotification(client, InitializedNotification.type, {});
			return client;
		} catch {
			if (child) await terminateProcess(child);
			return undefined;
		} finally {
			for (const client of this.pendingClients) {
				if (client.process === child) this.pendingClients.delete(client);
			}
		}
	}

	private openOrUpdate(
		client: LspClientState,
		server: ServerDefinition,
		absolutePath: string,
	): "ok" | "too-large" | "ignored" {
		if (this.shuttingDown || client.closed) return "ignored";
		if (isFileTooLarge(absolutePath, this.maxFileBytes)) return "too-large";
		const content = readFileSync(absolutePath, "utf-8");
		const uri = pathToFileURL(absolutePath).href;
		const languageId = server.languageId(absolutePath);
		const existing = client.openFiles.get(absolutePath);

		if (existing) {
			const version = existing.version + 1;
			client.openFiles.set(absolutePath, { version, lastUsedAt: Date.now() });
			this.sendNotification(client, DidChangeTextDocumentNotification.type, {
				textDocument: { uri, version },
				contentChanges: [{ text: content }],
			});
		} else {
			client.openFiles.set(absolutePath, { version: 1, lastUsedAt: Date.now() });
			this.sendNotification(client, DidOpenTextDocumentNotification.type, {
				textDocument: { uri, languageId, version: 1, text: content },
			});
			this.evictOpenFiles(client);
		}

		this.sendNotification(client, DidSaveTextDocumentNotification.type, {
			textDocument: { uri },
			text: content,
		});
		return "ok";
	}

	private async loadSyncedFile(
		filePath: string,
		signal?: AbortSignal,
	): Promise<{ client: LspClientState; server: ServerDefinition; absolutePath: string; uri: string } | undefined> {
		if (this.shuttingDown || isAborted(signal)) return undefined;
		const absolutePath = this.resolvePath(filePath);
		if (!existsSync(absolutePath)) return undefined;
		const workspaceIssue = workspaceValidationError(absolutePath, this.workspaceRoot, this.maxFileBytes);
		if (workspaceIssue) return undefined;
		const server = serverForFile(absolutePath);
		if (!server) return undefined;
		const client = await this.getClientForFile(absolutePath, signal).catch(() => undefined);
		if (!client || isAborted(signal)) return undefined;
		if (this.openOrUpdate(client, server, absolutePath) !== "ok") return undefined;
		return { client, server, absolutePath, uri: pathToFileURL(absolutePath).href };
	}

	private async openOrUpdateAndWait(
		client: LspClientState,
		server: ServerDefinition,
		absolutePath: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<"ok" | "too-large" | "timeout"> {
		if (this.shuttingDown || client.closed || isAborted(signal)) return "timeout";
		const opened = this.openOrUpdate(client, server, absolutePath);
		if (opened === "too-large") return "too-large";
		const responded = await this.waitForDiagnostics(client, absolutePath, timeoutMs, signal);
		return responded ? "ok" : "timeout";
	}

	private waitForDiagnostics(
		client: LspClientState,
		absolutePath: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<boolean> {
		if (isAborted(signal)) return Promise.resolve(false);
		return new Promise((resolvePromise) => {
			if (this.shuttingDown || client.closed || isAborted(signal)) {
				resolvePromise(false);
				return;
			}
			let settled = false;
			const listeners = client.listeners.get(absolutePath) ?? new Set<(received: boolean) => void>();
			let timer: ReturnType<typeof setTimeout>;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abortListener);
				listeners.delete(listener);
				if (listeners.size === 0) client.listeners.delete(absolutePath);
				resolvePromise(value);
			};
			const listener = (received: boolean) => finish(received);
			const abortListener = () => finish(false);
			timer = setTimeout(() => finish(false), timeoutMs);
			timer.unref?.();
			signal?.addEventListener("abort", abortListener, { once: true });
			listeners.add(listener);
			client.listeners.set(absolutePath, listeners);
		});
	}

	private evictOpenFiles(client: LspClientState): void {
		while (client.openFiles.size > MAX_OPEN_FILES) {
			let oldestPath: string | undefined;
			let oldestTime = Number.POSITIVE_INFINITY;
			for (const [filePath, state] of client.openFiles) {
				if (state.lastUsedAt < oldestTime) {
					oldestPath = filePath;
					oldestTime = state.lastUsedAt;
				}
			}
			if (!oldestPath) return;
			client.openFiles.delete(oldestPath);
			this.sendNotification(client, DidCloseTextDocumentNotification.type, {
				textDocument: { uri: pathToFileURL(oldestPath).href },
			});
		}
	}

	private async shutdownClient(client: LspClientState): Promise<void> {
		const wasClosed = client.closed;
		markClientClosed(client, this.clients, this.pendingClients);
		if (!wasClosed && !processHasExited(client.process)) {
			try {
				await withTimeout(
					Promise.resolve(client.connection.sendRequest("shutdown")),
					PROCESS_EXIT_TIMEOUT_MS,
					`${client.id} shutdown`,
				);
			} catch {
				// Ignore shutdown failures from already-dead language servers.
			}
			try {
				void Promise.resolve(client.connection.sendNotification("exit")).catch(() => undefined);
			} catch {
				// Ignore shutdown failures from already-dead language servers.
			}
			try {
				client.connection.end();
			} catch {
				// Ignore shutdown failures from already-dead language servers.
			}
		}
		await terminateProcess(client.process);
	}
}

export const __test__ = {
	commandExists,
	diagnosticToItem,
	filterBySeverity,
	findNearestRoot,
	collectUniqueClients,
	isAborted,
	isFileTooLarge,
	isWithinWorkspace,
	markClientClosed,
	normalizePath,
	processHasExited,
	registerClientLifecycle,
	resolveWorkspaceConfiguration,
	serverForFile,
	severityName,
	terminateProcess,
	tooLargeError,
	waitForProcessExit,
	withAbort,
	workspaceValidationError,
};
