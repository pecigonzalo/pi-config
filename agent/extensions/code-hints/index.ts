import { relative } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
const MIN_TURN_FLUSH_INTERVAL_MS = 10_000;
const MAX_DIRTY_AGE_MS = 30_000;
const MAX_HINTS = 20;

type CodeHintsMode = "report" | "nudge" | "ask" | "auto";
type CodeHintsAudience = "report" | "nudge" | "auto-fix" | "command";
type CodeHintsDelivery = "steer" | "nextTurn" | "followUp";
type CodeHintsFlushReason = "turn" | "final";

interface CodeHintsDetails {
  files: string[];
  hintCount: number;
  timedOut: string[];
  mode?: CodeHintsMode;
  audience?: CodeHintsAudience;
}

interface CodeHintsOptions {
  enabled: boolean;
  includeTimeouts: boolean;
  mode: CodeHintsMode;
}

type DiagnosticFingerprint = string;
type CodeHintsCommandResult = { status: string; changed: boolean };

interface CodeHintsInputEvent {
  source?: string;
  streamingBehavior?: "steer" | "followUp";
}

function getLspService(pi: ExtensionAPI): LspManagerService | undefined {
  const registry = pi.events as unknown as Record<string, unknown>;
  const service = registry[LSP_MANAGER_SERVICE_KEY];
  return isLspManagerService(service) ? service : undefined;
}

function isLspManagerService(value: unknown): value is LspManagerService {
  return !!value && typeof value === "object" && typeof (value as LspManagerService).diagnostics === "function";
}

function shouldResetRemediationFollowUp(event: CodeHintsInputEvent): boolean {
  return event.source !== "extension" && event.streamingBehavior === undefined;
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
    mode: "nudge",
  };
}

function isCodeHintsMode(value: string): value is CodeHintsMode {
  return value === "report" || value === "nudge" || value === "ask" || value === "auto";
}

function modeDescription(mode: CodeHintsMode): string {
  switch (mode) {
    case "report":
      return "show diagnostics only";
    case "nudge":
      return "show diagnostics and queue a next-turn reminder";
    case "ask":
      return "ask before running a focused follow-up fix";
    case "auto":
      return "automatically run one focused follow-up fix";
  }
}

function formatStatus(options: CodeHintsOptions, state: { lspAvailable: boolean; touchedFiles: number }): string {
  return [
    "Code hints:",
    `- enabled: ${options.enabled ? "yes" : "no"}`,
    `- mode: ${options.mode} (${modeDescription(options.mode)})`,
    `- LSP service: ${state.lspAvailable ? "connected" : "missing"}`,
    `- timeout details: ${options.includeTimeouts ? "shown when errors are reported" : "hidden"}`,
    `- touched files in current loop: ${state.touchedFiles}`,
    "",
    "Commands: /code-hints on, /code-hints off, /code-hints mode report|nudge|ask|auto, /code-hints debug on|off, /code-hints reset",
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
  if (command === "mode") {
    const value = tokens[1];
    if (value && isCodeHintsMode(value)) {
      options.mode = value;
      return { status: status(), changed: true };
    }
    return { status: `${status()}\n\nUsage: /code-hints mode report|nudge|ask|auto`, changed: false };
  }
  if (isCodeHintsMode(command)) {
    options.mode = command;
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

interface CodeHintsReport {
  content: string;
  details: CodeHintsDetails;
  fingerprints: DiagnosticFingerprint[];
}

interface CodeHintsReportOptions {
  includeTimeouts?: boolean;
  requireBaseline?: boolean;
  excludeFingerprints?: Set<DiagnosticFingerprint>;
}

interface CodeHintsFlushTimingState {
  touchedFiles: number;
  flushInFlight: boolean;
  firstDirtyAt?: number;
  lastFlushAt?: number;
}

function formatReport(
  cwd: string,
  results: LspFileDiagnostics[],
  baseline: Map<string, Set<DiagnosticFingerprint>> = new Map(),
  options: CodeHintsReportOptions = {},
): CodeHintsReport | undefined {
  const candidateHints = baseline.size > 0 || options.requireBaseline
    ? filterNewErrors(results, baseline)
    : results.flatMap((result) => result.diagnostics.filter((item) => item.severity === "error"));
  const hints = candidateHints.filter((hint) => !options.excludeFingerprints?.has(diagnosticFingerprint(hint)));
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
    fingerprints: hints.map(diagnosticFingerprint),
  };
}

function shouldFlushAtTurn(state: CodeHintsFlushTimingState, now = Date.now()): boolean {
  if (state.touchedFiles === 0 || state.flushInFlight) return false;
  if (!state.lastFlushAt) return true;
  if (now - state.lastFlushAt >= MIN_TURN_FLUSH_INTERVAL_MS) return true;
  return state.firstDirtyAt !== undefined && now - state.firstDirtyAt >= MAX_DIRTY_AGE_MS;
}

function formatNudgePrompt(report: CodeHintsReport): string {
  return [
    `Code hints: the previous edit loop introduced ${report.details.hintCount} new LSP error(s).`,
    "Before continuing, address these if they are relevant to the user's task.",
    "",
    report.content,
  ].join("\n");
}

function formatFixPrompt(report: CodeHintsReport): string {
  return [
    `Code hints found ${report.details.hintCount} new LSP error(s) after the previous edit loop.`,
    "Run a focused follow-up fix for only these diagnostics.",
    "Avoid unrelated changes unless they are necessary to resolve the listed errors.",
    "After editing, verify the narrowest relevant checks.",
    "",
    report.content,
  ].join("\n");
}

function shouldKeepInModelContext(message: unknown): boolean {
  if (!message || typeof message !== "object") return true;
  const record = message as { role?: unknown; customType?: unknown; details?: unknown };
  if (record.role !== "custom" || record.customType !== CODE_HINTS_MESSAGE_TYPE) return true;
  const details = record.details && typeof record.details === "object" ? record.details as { audience?: unknown } : undefined;
  return details?.audience === "nudge" || details?.audience === "auto-fix";
}

export default function codeHintsExtension(pi: ExtensionAPI) {
  let lspService: LspManagerService | undefined;
  let generation = 0;
  let active = true;
  let remediationFollowUpUsed = false;
  const options = defaultOptions();
  const touchedFiles = new Set<string>();
  const baselineByFile = new Map<string, Set<DiagnosticFingerprint>>();
  const baselinePromises = new Map<string, Promise<void>>();
  const reportedFingerprints = new Set<DiagnosticFingerprint>();
  let dirtyGeneration = 0;
  let firstDirtyAt: number | undefined;
  let lastFlushAt: number | undefined;
  let flushInFlight: Promise<void> | undefined;

  pi.events.on(LSP_MANAGER_READY_EVENT, (service) => {
    if (isLspManagerService(service)) lspService = service;
  });

  const resetState = () => {
    touchedFiles.clear();
    baselineByFile.clear();
    baselinePromises.clear();
    reportedFingerprints.clear();
    dirtyGeneration = 0;
    firstDirtyAt = undefined;
    lastFlushAt = undefined;
    generation++;
  };

  const currentStatus = () => formatStatus(options, {
    lspAvailable: !!(lspService ?? getLspService(pi)),
    touchedFiles: touchedFiles.size,
  });

  const sendVisibleReport = (report: CodeHintsReport, mode: CodeHintsMode) => {
    pi.sendMessage({
      customType: CODE_HINTS_MESSAGE_TYPE,
      content: report.content,
      display: true,
      details: { ...report.details, mode, audience: "report" } satisfies CodeHintsDetails,
    });
  };

  const sendNudge = (report: CodeHintsReport, mode: CodeHintsMode, deliverAs: CodeHintsDelivery) => {
    pi.sendMessage({
      customType: CODE_HINTS_MESSAGE_TYPE,
      content: formatNudgePrompt(report),
      display: false,
      details: { ...report.details, mode, audience: "nudge" } satisfies CodeHintsDetails,
    }, { deliverAs });
  };

  const triggerFocusedFix = (
    report: CodeHintsReport,
    mode: CodeHintsMode,
    deliverAs: CodeHintsDelivery,
    triggerTurn: boolean,
  ) => {
    if (remediationFollowUpUsed) return;
    remediationFollowUpUsed = true;
    pi.sendMessage({
      customType: CODE_HINTS_MESSAGE_TYPE,
      content: formatFixPrompt(report),
      display: false,
      details: { ...report.details, mode, audience: "auto-fix" } satisfies CodeHintsDetails,
    }, { deliverAs, triggerTurn });
  };

  const handleReportMode = async (
    report: CodeHintsReport,
    mode: CodeHintsMode,
    ctx: ExtensionContext,
    currentGeneration: number,
    reason: CodeHintsFlushReason,
  ) => {
    sendVisibleReport(report, mode);
    for (const fingerprint of report.fingerprints) reportedFingerprints.add(fingerprint);

    const isFinal = reason === "final";
    if (mode === "nudge") {
      sendNudge(report, mode, isFinal ? "nextTurn" : "steer");
      return;
    }
    if (mode === "auto") {
      triggerFocusedFix(report, mode, isFinal ? "followUp" : "steer", isFinal);
      return;
    }
    if (mode === "ask" && !isFinal) {
      sendNudge(report, mode, "steer");
      return;
    }
    if (mode !== "ask" || remediationFollowUpUsed || !ctx.hasUI) return;

    const confirmed = await ctx.ui.confirm(
      "Code hints",
      `Found ${report.details.hintCount} new LSP error(s). Run a focused follow-up fix?`,
    );
    if (!confirmed || !active || generation !== currentGeneration) return;
    triggerFocusedFix(report, mode, "followUp", true);
  };

  const clearDirtyState = (ctx?: ExtensionContext) => {
    touchedFiles.clear();
    baselineByFile.clear();
    baselinePromises.clear();
    firstDirtyAt = undefined;
    if (ctx?.hasUI) ctx.ui.setStatus("code-hints", undefined);
  };

  const flushCodeHints = async (ctx: ExtensionContext, reason: CodeHintsFlushReason) => {
    if (flushInFlight) {
      await flushInFlight;
      if (reason !== "final" || touchedFiles.size === 0) return;
    }

    const service = lspService ?? getLspService(pi);
    const files = [...touchedFiles];
    if (!options.enabled || !service || files.length === 0) return;

    const currentGeneration = generation;
    const currentDirtyGeneration = dirtyGeneration;
    const pendingBaselines = files.map((file) => baselinePromises.get(file)).filter((promise): promise is Promise<void> => !!promise);
    const cwd = ctx.cwd;
    const includeTimeouts = options.includeTimeouts;
    const mode = options.mode;

    flushInFlight = (async () => {
      await Promise.all(pendingBaselines);
      if (!active || generation !== currentGeneration || dirtyGeneration !== currentDirtyGeneration) return;

      const baselineSnapshot = new Map(baselineByFile);
      const results = await service.diagnostics(files, { severity: "error", timeoutMs: DEFAULT_TIMEOUT_MS }).catch(() => []);
      if (!active || generation !== currentGeneration || dirtyGeneration !== currentDirtyGeneration) return;

      const report = formatReport(cwd, results, baselineSnapshot, {
        requireBaseline: true,
        includeTimeouts,
        excludeFingerprints: reportedFingerprints,
      });
      clearDirtyState(ctx);
      lastFlushAt = Date.now();
      if (!report) return;
      await handleReportMode(report, mode, ctx, currentGeneration, reason);
    })();

    try {
      await flushInFlight;
    } finally {
      flushInFlight = undefined;
    }
  };

  pi.on("context", async (event) => ({
    messages: event.messages.filter(shouldKeepInModelContext),
  }));

  pi.on("input", async (event) => {
    if (shouldResetRemediationFollowUp(event)) remediationFollowUpUsed = false;
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

    const baselineGeneration = generation;
    const promise = service.diagnostics([input.path], { severity: "error", timeoutMs: DEFAULT_TIMEOUT_MS })
      .then((results) => {
        if (!active || generation !== baselineGeneration) return;
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
    if (touchedFiles.size === 0) firstDirtyAt = Date.now();
    touchedFiles.add(input.path);
    dirtyGeneration++;

    // Keep the LSP document cache warm without returning per-edit diagnostics.
    service.touchFile(input.path, { waitForDiagnostics: false }).catch(() => undefined);
    if (ctx.hasUI) ctx.ui.setStatus("code-hints", ctx.ui.theme.fg("dim", `hints: ${touchedFiles.size} touched`));
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!shouldFlushAtTurn({
      touchedFiles: touchedFiles.size,
      flushInFlight: !!flushInFlight,
      firstDirtyAt,
      lastFlushAt,
    })) return;

    await flushCodeHints(ctx, "turn");
  });

  pi.on("agent_end", async (event, ctx) => {
    if (shouldSkipAgentEnd(event)) {
      clearDirtyState(ctx);
      return;
    }

    await flushCodeHints(ctx, "final");
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
      details: { files: [], hintCount: 0, timedOut: [], audience: "command" } satisfies CodeHintsDetails,
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
  formatFixPrompt,
  formatHintLine,
  formatNudgePrompt,
  formatReport,
  formatStatus,
  getLspService,
  isLspManagerService,
  isCodeHintsMode,
  messageText,
  modeDescription,
  shouldFlushAtTurn,
  shouldKeepInModelContext,
  shouldResetRemediationFollowUp,
  shouldSkipAgentEnd,
};
