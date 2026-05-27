import { relative } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
  LSP_MANAGER_READY_EVENT,
  LSP_MANAGER_SERVICE_KEY,
  type LspDiagnosticItem,
  type LspFileDiagnostics,
  type LspManagerService,
} from "../lsp-manager/service";

const CODE_HINTS_MESSAGE_TYPE = "code-hints";
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_HINTS = 20;

interface CodeHintsDetails {
  files: string[];
  hintCount: number;
  timedOut: string[];
}

interface CodeHintsOptions {
  enabled: boolean;
  includeTimeouts: boolean;
}

type DiagnosticFingerprint = string;
type CodeHintsCommandResult = { status: string; changed: boolean };

function getLspService(pi: ExtensionAPI): LspManagerService | undefined {
  const registry = pi.events as unknown as Record<string, unknown>;
  const service = registry[LSP_MANAGER_SERVICE_KEY];
  return isLspManagerService(service) ? service : undefined;
}

function isLspManagerService(value: unknown): value is LspManagerService {
  return !!value && typeof value === "object" && typeof (value as LspManagerService).diagnostics === "function";
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function defaultOptions(): CodeHintsOptions {
  return {
    enabled: true,
    includeTimeouts: false,
  };
}

function formatStatus(options: CodeHintsOptions, state: { lspAvailable: boolean; touchedFiles: number }): string {
  return [
    "Code hints:",
    `- enabled: ${options.enabled ? "yes" : "no"}`,
    `- LSP service: ${state.lspAvailable ? "connected" : "missing"}`,
    `- timeout details: ${options.includeTimeouts ? "shown when errors are reported" : "hidden"}`,
    `- touched files in current loop: ${state.touchedFiles}`,
    "",
    "Commands: /code-hints on, /code-hints off, /code-hints debug on, /code-hints debug off, /code-hints reset",
  ].join("\n");
}

function applyCommand(args: string, options: CodeHintsOptions, reset: () => void, status: () => string): CodeHintsCommandResult {
  const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const command = tokens[0] ?? "status";

  if (command === "status" || command === "help") {
    return { status: status(), changed: false };
  }
  if (command === "on" || command === "enable") {
    options.enabled = true;
    return { status: status(), changed: true };
  }
  if (command === "off" || command === "disable") {
    options.enabled = false;
    reset();
    return { status: status(), changed: true };
  }
  if (command === "debug" || command === "timeouts") {
    const value = tokens[1] ?? "status";
    if (value === "on" || value === "enable" || value === "true") {
      options.includeTimeouts = true;
      return { status: status(), changed: true };
    }
    if (value === "off" || value === "disable" || value === "false") {
      options.includeTimeouts = false;
      return { status: status(), changed: true };
    }
    return { status: `${status()}\n\nUsage: /code-hints debug on|off`, changed: false };
  }
  if (command === "reset") {
    reset();
    return { status: status(), changed: true };
  }

  return { status: `${status()}\n\nUnknown code-hints command: ${command}`, changed: false };
}

function shouldSkipAgentEnd(event: { messages?: unknown[] }): boolean {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  return messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    const record = message as { role?: unknown; stopReason?: unknown };
    return record.role === "assistant" && (record.stopReason === "aborted" || record.stopReason === "error");
  });
}

function formatHintLine(cwd: string, hint: LspDiagnosticItem): string {
  const file = relative(cwd, hint.file) || hint.file;
  const source = hint.source ? ` [${hint.source}]` : "";
  const code = hint.code ? ` ${hint.code}` : "";
  return `- ${file}:${hint.line}:${hint.column} ${hint.severity}${source}${code}: ${hint.message.split("\n")[0]}`;
}

function diagnosticFingerprint(hint: LspDiagnosticItem): DiagnosticFingerprint {
  return [hint.file, hint.line, hint.column, hint.severity, hint.source ?? "", hint.code ?? "", hint.message].join("\u0000");
}

function collectErrorFingerprints(results: LspFileDiagnostics[]): Map<string, Set<DiagnosticFingerprint>> {
  const byFile = new Map<string, Set<DiagnosticFingerprint>>();
  for (const result of results) {
    if (result.status !== "ok") continue;
    const errors = result.diagnostics.filter((item) => item.severity === "error");
    byFile.set(result.file, new Set(errors.map(diagnosticFingerprint)));
  }
  return byFile;
}

function filterNewErrors(results: LspFileDiagnostics[], baseline: Map<string, Set<DiagnosticFingerprint>>): LspDiagnosticItem[] {
  return results.flatMap((result) => {
    const baselineForFile = baseline.get(result.file);
    if (!baselineForFile) return [];
    return result.diagnostics.filter((item) => item.severity === "error" && !baselineForFile.has(diagnosticFingerprint(item)));
  });
}

function formatReport(
  cwd: string,
  results: LspFileDiagnostics[],
  baseline: Map<string, Set<DiagnosticFingerprint>> = new Map(),
  options: { includeTimeouts?: boolean; requireBaseline?: boolean } = {},
): { content: string; details: CodeHintsDetails } | undefined {
  const hints = baseline.size > 0 || options.requireBaseline
    ? filterNewErrors(results, baseline)
    : results.flatMap((result) => result.diagnostics.filter((item) => item.severity === "error"));
  const timedOut = results.filter((result) => result.status === "timeout").map((result) => relative(cwd, result.file) || result.file);
  if (hints.length === 0) return undefined;

  const files = [...new Set(hints.map((hint) => relative(cwd, hint.file) || hint.file))];
  const visibleHints = hints.slice(0, MAX_HINTS);
  const omitted = hints.length - visibleHints.length;
  const header = hints.length === 1
    ? "Code hints found 1 new LSP error after this edit loop."
    : `Code hints found ${hints.length} new LSP errors after this edit loop.`;

  const lines = [
    header,
    "Edits were applied successfully; these diagnostics are new relative to the pre-edit baseline.",
    "",
    ...visibleHints.map((hint) => formatHintLine(cwd, hint)),
  ];

  if (omitted > 0) lines.push(`- ... ${omitted} more error(s) omitted.`);
  if (options.includeTimeouts && timedOut.length > 0) {
    lines.push("", `Timed out waiting for diagnostics from: ${timedOut.join(", ")}`);
  }

  return {
    content: lines.join("\n").trim(),
    details: {
      files,
      hintCount: hints.length,
      timedOut,
    },
  };
}

export default function codeHintsExtension(pi: ExtensionAPI) {
  let lspService: LspManagerService | undefined;
  let generation = 0;
  let active = true;
  const options = defaultOptions();
  const touchedFiles = new Set<string>();
  const baselineByFile = new Map<string, Set<DiagnosticFingerprint>>();
  const baselinePromises = new Map<string, Promise<void>>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  pi.events.on(LSP_MANAGER_READY_EVENT, (service) => {
    if (isLspManagerService(service)) lspService = service;
  });

  const resetState = () => {
    touchedFiles.clear();
    baselineByFile.clear();
    baselinePromises.clear();
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    generation++;
  };

  const currentStatus = () => formatStatus(options, {
    lspAvailable: !!(lspService ?? getLspService(pi)),
    touchedFiles: touchedFiles.size,
  });

  pi.registerMessageRenderer(CODE_HINTS_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const text = messageText(message.content);
    const details = message.details as CodeHintsDetails | undefined;
    const hintCount = details?.hintCount ?? 0;
    const title = hintCount === 1 ? "Code hints: 1 error" : `Code hints: ${hintCount} errors`;
    const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
    const collapsed = hintCount > 0
      ? `${theme.fg("warning", title)}${details?.files.length ? theme.fg("dim", ` • ${details.files.join(", ")}`) : ""}`
      : theme.fg("muted", text.split("\n")[0] || "Code hints");
    const body = expanded ? text : collapsed;
    box.addChild(new Text(body, 0, 0));
    return box;
  });

  pi.on("session_start", async () => {
    active = true;
    lspService = getLspService(pi);
    resetState();
  });

  pi.on("agent_start", async () => {
    active = true;
    resetState();
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const input = event.input as { path?: unknown };
    if (typeof input.path !== "string") return;
    if (!active || !options.enabled) return;

    const service = lspService ?? getLspService(pi);
    if (!service?.supportsFile(input.path)) return;
    if (baselinePromises.has(input.path)) return;

    const promise = service.diagnostics([input.path], { severity: "error", timeoutMs: DEFAULT_TIMEOUT_MS })
      .then((results) => {
        const baseline = collectErrorFingerprints(results);
        for (const [file, fingerprints] of baseline) baselineByFile.set(file, fingerprints);
      })
      .catch(() => undefined);
    baselinePromises.set(input.path, promise);
    await promise;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    if (!isWriteToolResult(event) && !isEditToolResult(event)) return;
    const input = event.input as { path?: unknown };
    if (typeof input.path !== "string") return;
    if (!active || !options.enabled) return;

    const service = lspService ?? getLspService(pi);
    if (!service?.supportsFile(input.path)) return;
    touchedFiles.add(input.path);

    // Keep the LSP document cache warm without returning per-edit diagnostics.
    service.touchFile(input.path, { waitForDiagnostics: false }).catch(() => undefined);
    if (ctx.hasUI) ctx.ui.setStatus("code-hints", ctx.ui.theme.fg("dim", `hints: ${touchedFiles.size} touched`));
  });

  pi.on("agent_end", async (event, ctx) => {
    if (shouldSkipAgentEnd(event)) {
      touchedFiles.clear();
      baselineByFile.clear();
      baselinePromises.clear();
      return;
    }

    const files = [...touchedFiles];
    const pendingBaselines = files.map((file) => baselinePromises.get(file)).filter((promise): promise is Promise<void> => !!promise);
    touchedFiles.clear();
    const service = lspService ?? getLspService(pi);
    const currentGeneration = generation;
    const cwd = ctx.cwd;
    const includeTimeouts = options.includeTimeouts;
    if (ctx.hasUI) ctx.ui.setStatus("code-hints", undefined);
    if (!options.enabled || !service || files.length === 0) return;

    void (async () => {
      await Promise.all(pendingBaselines);
      if (!active || generation !== currentGeneration) return;
      const baselineSnapshot = new Map(baselineByFile);
      baselineByFile.clear();
      baselinePromises.clear();
      const results = await service.diagnostics(files, { severity: "error", timeoutMs: DEFAULT_TIMEOUT_MS }).catch(() => []);
      if (!active || generation !== currentGeneration) return;
      const report = formatReport(cwd, results, baselineSnapshot, { requireBaseline: true, includeTimeouts });
      if (!report) return;

      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        if (!active || generation !== currentGeneration) return;
        pi.sendMessage({
          customType: CODE_HINTS_MESSAGE_TYPE,
          content: report.content,
          display: true,
          details: report.details,
        });
      }, 0);
      pendingTimers.add(timer);
    })();
  });

  pi.on("session_shutdown", async () => {
    active = false;
    resetState();
  });

  const showCommandResult = (result: CodeHintsCommandResult, ctx: ExtensionCommandContext) => {
    if (ctx.hasUI) {
      ctx.ui.notify(result.status, "info");
      return;
    }
    pi.sendMessage({
      customType: CODE_HINTS_MESSAGE_TYPE,
      content: result.status,
      display: true,
      details: { files: [], hintCount: 0, timedOut: [] } satisfies CodeHintsDetails,
    });
  };

  pi.registerCommand("code-hints", {
    description: "Show or configure loop-end code hints",
    handler: async (args, ctx) => {
      const result = applyCommand(args, options, resetState, currentStatus);
      showCommandResult(result, ctx);
    },
  });
}

export const __test__ = {
  applyCommand,
  collectErrorFingerprints,
  defaultOptions,
  diagnosticFingerprint,
  filterNewErrors,
  formatHintLine,
  formatReport,
  formatStatus,
  getLspService,
  isLspManagerService,
  messageText,
  shouldSkipAgentEnd,
};
