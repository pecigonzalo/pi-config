import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createMessageConnection,
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
} from "vscode-languageserver-protocol/node.js";
import type { Diagnostic, DocumentSymbol, Hover, Location, LocationLink, SymbolInformation } from "vscode-languageserver-protocol";

/** Event emitted when an LSP manager service is available. */
export const LSP_MANAGER_READY_EVENT = "lsp-manager:ready";

/** Event emitted when an LSP manager service is shutting down. */
export const LSP_MANAGER_SHUTDOWN_EVENT = "lsp-manager:shutdown";

/** Event emitted by consumers to request the current LSP manager service. */
export const LSP_MANAGER_REQUEST_EVENT = "lsp-manager:request";

export interface LspManagerServiceRequest {
  respond(service: LspManagerService | undefined): void;
}

const INIT_TIMEOUT_MS = 30_000;
const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 3_000;
const MAX_OPEN_FILES = 40;

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
  signal?: AbortSignal;
}

/** Reusable service exposed by the lsp-manager extension. */
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
  listeners: Map<string, Set<() => void>>;
  openFiles: Map<string, OpenDocumentState>;
  closed: boolean;
}

const SERVER_DEFINITIONS: ServerDefinition[] = [
  {
    id: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
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
    return absolute;
  }
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

function diagnosticToItem(file: string, diagnostic: Diagnostic): LspDiagnosticItem {
  const code = diagnostic.code == null ? undefined : String(diagnostic.code);
  return {
    file,
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
    severity: severityName(diagnostic.severity),
    message: diagnostic.message,
    source: diagnostic.source,
    code,
  };
}

function filterBySeverity(items: LspDiagnosticItem[], severity: LspDiagnosticsOptions["severity"]): LspDiagnosticItem[] {
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

function normalizeDocumentSymbols(result: DocumentSymbol[] | SymbolInformation[] | null | undefined, fallbackFile: string): LspDocumentSymbol[] {
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

function documentSymbolToDocumentSymbols(symbol: DocumentSymbol, file: string, container?: string): LspDocumentSymbol[] {
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
  const children = symbol.children?.flatMap((child) => documentSymbolToDocumentSymbols(child, file, symbol.name)) ?? [];
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
  return withAbort(new Promise<T>((resolvePromise, rejectPromise) => {
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
  }), signal);
}

function collectUniqueClients<T>(clients: Iterable<T>, pendingClients: Iterable<T>): T[] {
  return [...new Set([...clients, ...pendingClients])];
}

/** LSP service implementation backed by stdio language servers. */
export class DefaultLspManagerService implements LspManagerService {
  private readonly clients = new Map<string, LspClientState>();
  private readonly pendingClients = new Set<LspClientState>();
  private readonly spawning = new Map<string, Promise<LspClientState | undefined>>();
  private shuttingDown = false;

  constructor(private readonly cwd: string) {}

  supportsFile(filePath: string): boolean {
    if (this.shuttingDown) return false;
    const absolutePath = this.resolvePath(filePath);
    const server = serverForFile(absolutePath);
    return !!server && commandExists(server.command);
  }

  async warmup(filePath: string, options: LspRequestOptions = {}): Promise<boolean> {
    if (this.shuttingDown || isAborted(options.signal)) return false;
    const client = await this.getClientForFile(filePath, options.signal).catch(() => undefined);
    return !!client && !isAborted(options.signal);
  }

  async touchFile(filePath: string, options: LspTouchOptions = {}): Promise<LspFileDiagnostics> {
    const absolutePath = this.resolvePath(filePath);
    if (this.shuttingDown || isAborted(options.signal)) {
      return { file: absolutePath, status: "error", diagnostics: [], error: "LSP manager is shutting down." };
    }
    const server = serverForFile(absolutePath);
    if (!server) {
      return { file: absolutePath, status: "unsupported", diagnostics: [], error: `No LSP server configured for ${extname(absolutePath) || "file"}.` };
    }
    if (!existsSync(absolutePath)) {
      return { file: absolutePath, status: "error", diagnostics: [], error: "File does not exist." };
    }

    const client = await this.getClientForFile(absolutePath, options.signal).catch(() => undefined);
    if (!client) {
      return { file: absolutePath, status: "unsupported", diagnostics: [], error: `${server.command} is not available or failed to initialize.` };
    }

    if (options.waitForDiagnostics === false) {
      this.openOrUpdate(client, server, absolutePath);
      return { file: absolutePath, status: "ok", diagnostics: [] };
    }

    const responded = await this.openOrUpdateAndWait(client, server, absolutePath, options.timeoutMs ?? DEFAULT_DIAGNOSTIC_TIMEOUT_MS, options.signal);
    const diagnostics = (client.diagnostics.get(absolutePath) ?? []).map((diagnostic) => diagnosticToItem(absolutePath, diagnostic));
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
      const server = serverForFile(absolutePath);
      if (!server) {
        results.push({ file: absolutePath, status: "unsupported", diagnostics: [], error: `No LSP server configured for ${extname(absolutePath) || "file"}.` });
        continue;
      }
      if (!existsSync(absolutePath)) {
        results.push({ file: absolutePath, status: "error", diagnostics: [], error: "File does not exist." });
        continue;
      }

      const client = await this.getClientForFile(absolutePath, options.signal).catch(() => undefined);
      if (!client) {
        results.push({ file: absolutePath, status: "unsupported", diagnostics: [], error: `${server.command} is not available or failed to initialize.` });
        continue;
      }

      const responded = await this.openOrUpdateAndWait(client, server, absolutePath, timeoutMs, options.signal);
      const rawDiagnostics = client.diagnostics.get(absolutePath) ?? [];
      const diagnostics = filterBySeverity(rawDiagnostics.map((diagnostic) => diagnosticToItem(absolutePath, diagnostic)), options.severity);
      results.push({
        file: absolutePath,
        status: responded || rawDiagnostics.length > 0 ? "ok" : "timeout",
        diagnostics,
        error: responded || rawDiagnostics.length > 0 ? undefined : "LSP did not publish diagnostics before timeout.",
      });
    }

    return results;
  }

  async definition(filePath: string, position: LspPosition, options: LspRequestOptions = {}): Promise<LspLocation[]> {
    if (this.shuttingDown || isAborted(options.signal)) return [];
    const loaded = await this.loadSyncedFile(filePath, options.signal);
    if (!loaded || this.shuttingDown || loaded.client.closed || isAborted(options.signal)) return [];
    const result = await withAbort(loaded.client.connection.sendRequest(DefinitionRequest.type, {
      textDocument: { uri: loaded.uri },
      position: positionToLsp(position),
    }), options.signal).catch(() => undefined);
    return normalizeLocations(result);
  }

  async references(filePath: string, position: LspPosition, options: LspRequestOptions = {}): Promise<LspLocation[]> {
    if (this.shuttingDown || isAborted(options.signal)) return [];
    const loaded = await this.loadSyncedFile(filePath, options.signal);
    if (!loaded || this.shuttingDown || loaded.client.closed || isAborted(options.signal)) return [];
    const result = await withAbort(loaded.client.connection.sendRequest(ReferencesRequest.type, {
      textDocument: { uri: loaded.uri },
      position: positionToLsp(position),
      context: { includeDeclaration: true },
    }), options.signal).catch(() => undefined);
    return normalizeLocations(result);
  }

  async hover(filePath: string, position: LspPosition, options: LspRequestOptions = {}): Promise<LspHoverInfo | undefined> {
    if (this.shuttingDown || isAborted(options.signal)) return undefined;
    const loaded = await this.loadSyncedFile(filePath, options.signal);
    if (!loaded || this.shuttingDown || loaded.client.closed || isAborted(options.signal)) return undefined;
    const result = await withAbort(loaded.client.connection.sendRequest(HoverRequest.type, {
      textDocument: { uri: loaded.uri },
      position: positionToLsp(position),
    }), options.signal).catch(() => undefined);
    if (!result?.contents) return undefined;
    const contents = hoverContentsToText(result.contents).trim();
    if (!contents) return undefined;
    return { file: loaded.absolutePath, line: position.line, column: position.column, contents };
  }

  async documentSymbols(filePath: string, options: LspRequestOptions = {}): Promise<LspDocumentSymbol[]> {
    if (this.shuttingDown || isAborted(options.signal)) return [];
    const loaded = await this.loadSyncedFile(filePath, options.signal);
    if (!loaded || this.shuttingDown || loaded.client.closed || isAborted(options.signal)) return [];
    const result = await withAbort(loaded.client.connection.sendRequest(DocumentSymbolRequest.type, {
      textDocument: { uri: loaded.uri },
    }), options.signal).catch(() => undefined);
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
          diagnostics: [...client.diagnostics.values()].reduce((sum, diagnostics) => sum + diagnostics.length, 0),
          root: client.root,
        });
      }
    }
    return items;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const clients = collectUniqueClients(this.clients.values(), this.pendingClients.values());
    this.clients.clear();
    this.pendingClients.clear();
    this.spawning.clear();

    await Promise.all(clients.map((client) => this.shutdownClient(client)));
  }

  private resolvePath(filePath: string): string {
    return normalizePath(resolve(this.cwd, filePath));
  }

  private sendNotification(client: LspClientState, method: unknown, params?: unknown): void {
    if (this.shuttingDown || client.closed) return;
    try {
      void Promise.resolve(client.connection.sendNotification(method as never, params as never)).catch(() => undefined);
    } catch {
      // Ignore writes racing with LSP process shutdown.
    }
  }

  private clientKey(server: ServerDefinition, root: string): string {
    return `${server.id}:${root}`;
  }

  private async getClientForFile(filePath: string, signal?: AbortSignal): Promise<LspClientState | undefined> {
    if (this.shuttingDown || isAborted(signal)) return undefined;
    const absolutePath = this.resolvePath(filePath);
    const server = serverForFile(absolutePath);
    if (!server) return undefined;
    if (!commandExists(server.command)) return undefined;

    const root = findNearestRoot(absolutePath, this.cwd, server.rootMarkers);
    if (!root) return undefined;

    const key = this.clientKey(server, root);
    const existing = this.clients.get(key);
    if (existing && !existing.closed) return existing;

    let spawning = this.spawning.get(key);
    if (!spawning) {
      spawning = this.startClient(server, root, signal);
      this.spawning.set(key, spawning);
      spawning.finally(() => this.spawning.delete(key));
    }

    const client = await withAbort(spawning, signal).catch(() => undefined);
    if (this.shuttingDown || isAborted(signal)) {
      if (client) await this.shutdownClient(client);
      return undefined;
    }
    if (client) this.clients.set(key, client);
    return client;
  }

  private async startClient(server: ServerDefinition, root: string, signal?: AbortSignal): Promise<LspClientState | undefined> {
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
      };

      connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
        const file = uriToPath(params.uri);
        client.diagnostics.set(file, params.diagnostics ?? []);
        for (const listener of client.listeners.get(file) ?? []) {
          listener();
        }
      });
      connection.onError(() => undefined);
      connection.onClose(() => {
        client.closed = true;
      });
      child.on("exit", () => {
        client.closed = true;
      });
      child.on("error", () => {
        client.closed = true;
      });

      connection.listen();
      this.pendingClients.add(client);
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
      if (this.shuttingDown || isAborted(signal)) {
        await this.shutdownClient(client);
        return undefined;
      }
      this.sendNotification(client, InitializedNotification.type, {});
      return client;
    } catch {
      if (child) child.kill();
      return undefined;
    } finally {
      for (const client of this.pendingClients) {
        if (client.process === child) this.pendingClients.delete(client);
      }
    }
  }

  private openOrUpdate(client: LspClientState, server: ServerDefinition, absolutePath: string): void {
    if (this.shuttingDown || client.closed) return;
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
  }

  private async loadSyncedFile(filePath: string, signal?: AbortSignal): Promise<{ client: LspClientState; server: ServerDefinition; absolutePath: string; uri: string } | undefined> {
    if (this.shuttingDown || isAborted(signal)) return undefined;
    const absolutePath = this.resolvePath(filePath);
    if (!existsSync(absolutePath)) return undefined;
    const server = serverForFile(absolutePath);
    if (!server) return undefined;
    const client = await this.getClientForFile(absolutePath, signal).catch(() => undefined);
    if (!client || isAborted(signal)) return undefined;
    this.openOrUpdate(client, server, absolutePath);
    return { client, server, absolutePath, uri: pathToFileURL(absolutePath).href };
  }

  private async openOrUpdateAndWait(
    client: LspClientState,
    server: ServerDefinition,
    absolutePath: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.shuttingDown || client.closed || isAborted(signal)) return false;
    const wait = this.waitForDiagnostics(client, absolutePath, timeoutMs, signal);
    this.openOrUpdate(client, server, absolutePath);
    return wait;
  }

  private waitForDiagnostics(client: LspClientState, absolutePath: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (isAborted(signal)) return Promise.resolve(false);
    return new Promise((resolvePromise) => {
      if (this.shuttingDown || client.closed || isAborted(signal)) {
        resolvePromise(false);
        return;
      }
      let settled = false;
      const listeners = client.listeners.get(absolutePath) ?? new Set<() => void>();
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
      const listener = () => finish(true);
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
    client.closed = true;
    try {
      await Promise.race([
        client.connection.sendRequest("shutdown"),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 1000)),
      ]);
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
    client.process.kill();
  }
}

export const __test__ = {
  commandExists,
  diagnosticToItem,
  filterBySeverity,
  findNearestRoot,
  collectUniqueClients,
  isAborted,
  normalizePath,
  serverForFile,
  severityName,
  withAbort,
};
