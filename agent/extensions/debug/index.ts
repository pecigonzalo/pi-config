import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type TUI,
} from "@earendil-works/pi-tui";

type PromptMode = "current" | "last";

type LineStyle = "tools" | "heading" | "bullet" | "toolLine" | "plain";

interface PromptRequest {
  mode: PromptMode;
  raw: boolean;
  includeTools: boolean;
  help: boolean;
}

interface PromptSnapshot {
  label: string;
  prompt: string;
  capturedAt: number;
  source: string;
}

interface PromptDocument {
  title: string;
  body: string;
  promptLineCount: number;
  promptCharCount: number;
  toolCount: number;
}

const HELP_TEXT = [
  "Usage:",
  "  /debug [current|last] [raw] [no-tools]",
  "  /debug prompt [current|last] [raw] [no-tools]",
  "  /debug help",
  "",
  "Subcommands:",
  "  prompt    Show Pi's generated system prompt (default when prompt options are used).",
  "  help      Show this help.",
  "",
  "Prompt options:",
  "  current   Show ctx.getSystemPrompt() at command time (default).",
  "  last      Show the most recent prompt captured at agent_start.",
  "  raw       Omit the metadata header so the prompt can be copied as-is.",
  "  no-tools  Hide appended tool parameter schemas.",
  "",
  "Interactive overlay:",
  "  ↑↓/j/k scroll, PgUp/PgDn page, Home/End jump, c copy, Esc/q close.",
].join("\n");

function isPromptOption(word: string): boolean {
  const normalized = word.toLowerCase();
  return normalized === "current"
    || normalized === "now"
    || normalized === "last"
    || normalized === "previous"
    || normalized === "raw"
    || normalized === "tools"
    || normalized === "with-tools"
    || normalized === "no-tools"
    || normalized === "prompt-only";
}

function parsePromptArgs(args: string): PromptRequest {
  const words = args
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  let mode: PromptMode = "current";
  let raw = false;
  let includeTools = true;
  let help = false;

  const [subcommand, ...rest] = words;
  const normalizedSubcommand = subcommand?.toLowerCase();
  if (!normalizedSubcommand || normalizedSubcommand === "help" || normalizedSubcommand === "--help" || normalizedSubcommand === "-h") {
    return { mode, raw, includeTools, help: true };
  }

  const options = normalizedSubcommand === "prompt"
    ? rest
    : isPromptOption(normalizedSubcommand) ? words : undefined;
  if (!options) {
    return { mode, raw, includeTools, help: true };
  }

  for (const word of options) {
    const normalized = word.toLowerCase();
    if (normalized === "current" || normalized === "now") {
      mode = "current";
      continue;
    }
    if (normalized === "last" || normalized === "previous") {
      mode = "last";
      continue;
    }
    if (normalized === "raw") {
      raw = true;
      continue;
    }
    if (normalized === "tools" || normalized === "with-tools") {
      includeTools = true;
      continue;
    }
    if (normalized === "no-tools" || normalized === "prompt-only") {
      includeTools = false;
      continue;
    }
    if (normalized === "help" || normalized === "--help" || normalized === "-h") {
      help = true;
      continue;
    }

    help = true;
  }

  return { mode, raw, includeTools, help };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "undefined";
  } catch (error: unknown) {
    if (error instanceof Error) {
      return `[unserializable: ${error.message}]`;
    }
    return "[unserializable]";
  }
}

function buildToolLines(tools: readonly ToolInfo[]): string[] {
  if (tools.length === 0) {
    return ["Tool definitions", "", "No tools registered."];
  }

  const lines = [`Tool definitions (${tools.length} tools)`, ""];

  for (const tool of tools) {
    const source = tool.sourceInfo?.source ?? "unknown";
    const sourceText = source === "builtin" ? "built-in" : source === "sdk" ? "SDK" : source;

    lines.push(`name: ${tool.name}`);
    lines.push(`  description: ${tool.description}`);
    lines.push(`  source: ${sourceText}`);
    if (tool.promptGuidelines && tool.promptGuidelines.length > 0) {
      lines.push("  promptGuidelines:");
      for (const guideline of tool.promptGuidelines) {
        lines.push(`    - ${guideline}`);
      }
    }
    lines.push("  parameters:");

    for (const line of safeJson(tool.parameters).split("\n")) {
      lines.push(`    ${line}`);
    }

    lines.push("");
  }

  return lines;
}

function formatPromptDocument(
  snapshot: PromptSnapshot,
  request: PromptRequest,
  tools: readonly ToolInfo[],
): PromptDocument {
  const promptLines = snapshot.prompt.split("\n");
  const sections = request.raw
    ? [snapshot.prompt]
    : [
        `Pi system prompt (${snapshot.label})`,
        `Captured: ${new Date(snapshot.capturedAt).toISOString()}`,
        `Source: ${snapshot.source}`,
        `Length: ${snapshot.prompt.length} characters, ${promptLines.length} lines`,
        `Tool schemas: ${request.includeTools ? `${tools.length} appended` : "hidden"}`,
        "",
        "---",
        "",
        snapshot.prompt,
      ];

  if (request.includeTools) {
    sections.push("", "────────────────────────────────────────", "", ...buildToolLines(tools));
  }

  return {
    title: `Pi system prompt: ${snapshot.label}`,
    body: sections.join("\n"),
    promptLineCount: promptLines.length,
    promptCharCount: snapshot.prompt.length,
    toolCount: request.includeTools ? tools.length : 0,
  };
}

function lineStyle(line: string): LineStyle {
  if (line.startsWith("Tool definitions") || line.startsWith("Available tools:")) return "tools";
  if (/^#+\s/.test(line) || line.startsWith("Pi system prompt")) return "heading";
  if (line.startsWith("- ")) return "bullet";
  if (line.startsWith("  ") || line.startsWith("    ")) return "toolLine";
  return "plain";
}

function styleLine(theme: Theme, text: string, style: LineStyle, continuation: boolean): string {
  if (continuation) {
    return style === "bullet" ? theme.fg("muted", text) : theme.fg("dim", text);
  }

  switch (style) {
    case "tools":
    case "heading":
      return theme.fg("accent", theme.bold(text));
    case "bullet":
      return theme.fg("muted", text);
    case "toolLine":
      return theme.fg("dim", text);
    case "plain":
      return text;
    default:
      return text;
  }
}

async function showPromptDocument(document: PromptDocument, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    console.log(document.body);
    return;
  }

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => new PromptOverlay(tui, theme, document, done),
    {
      overlay: true,
      overlayOptions: {
        width: "95%",
        maxHeight: "92%",
        anchor: "center",
        margin: 0,
      },
    },
  );
}

function currentSnapshot(ctx: ExtensionCommandContext): PromptSnapshot {
  return {
    label: "current",
    prompt: ctx.getSystemPrompt(),
    capturedAt: Date.now(),
    source: "ctx.getSystemPrompt() from the command handler",
  };
}

function showHelp(ctx: ExtensionCommandContext): void {
  if (ctx.hasUI) {
    ctx.ui.notify(HELP_TEXT, "info");
    return;
  }

  console.log(HELP_TEXT);
}

const DEBUG_COMPLETIONS = [
  { value: "current",  label: "current: show current system prompt (default)" },
  { value: "last",     label: "last: show prompt captured at last agent_start" },
  { value: "raw",      label: "raw: show raw JSON prompt" },
  { value: "tools",    label: "tools: include tool parameter schemas" },
  { value: "no-tools", label: "no-tools: hide tool parameter schemas" },
  { value: "help",     label: "help: show usage" },
] as const;

function registerDebugCommand(pi: ExtensionAPI, getLastSnapshot: () => PromptSnapshot | undefined): void {
  pi.registerCommand("debug", {
    description: "Debug Pi runtime state",
    getArgumentCompletions: (prefix) =>
      DEBUG_COMPLETIONS.filter((s) => s.value.startsWith(prefix.trim())),
    handler: async (args, ctx) => {
      const request = parsePromptArgs(args);
      if (request.help) {
        showHelp(ctx);
        return;
      }

      await ctx.waitForIdle();

      const snapshot = request.mode === "last" ? getLastSnapshot() : currentSnapshot(ctx);
      if (!snapshot) {
        const message = "No agent_start prompt has been captured yet; showing the current prompt instead.";
        if (ctx.hasUI) {
          ctx.ui.notify(message, "warning");
        } else {
          console.warn(message);
        }
      }

      const document = formatPromptDocument(snapshot ?? currentSnapshot(ctx), request, pi.getAllTools());
      await showPromptDocument(document, ctx);
    },
  });
}

interface DisplayLine {
  text: string;
  originalLine: string;
  continuation: boolean;
}

class PromptOverlay {
  private readonly lines: string[];
  private readonly fullText: string;
  private scrollOffset = 0;
  private copiedAt = 0;
  private totalDisplayLines = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly document: PromptDocument,
    private readonly done: () => void,
  ) {
    this.lines = document.body.split("\n");
    this.fullText = document.body;
  }

  handleInput(data: string): void {
    const visible = this.visibleLines();
    const total = Math.max(this.totalDisplayLines, this.lines.length);
    const maxOffset = Math.max(0, total - visible);
    let changed = false;

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      changed = true;
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scrollOffset = Math.min(maxOffset, this.scrollOffset + 1);
      changed = true;
    } else if (matchesKey(data, "pageUp")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - visible);
      changed = true;
    } else if (matchesKey(data, "pageDown")) {
      this.scrollOffset = Math.min(maxOffset, this.scrollOffset + visible);
      changed = true;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      changed = true;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxOffset;
      changed = true;
    } else if (matchesKey(data, "c")) {
      this.copyToClipboard();
      changed = true;
    } else if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.done();
      return;
    }

    if (changed) {
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const panelWidth = Math.max(20, width);
    const innerWidth = Math.max(1, panelWidth - 2);
    const contentWidth = Math.max(1, innerWidth - 2);
    const visible = this.visibleLines();
    const displayLines = this.buildDisplayLines(contentWidth);
    this.totalDisplayLines = displayLines.length;

    const maxOffset = Math.max(0, displayLines.length - visible);
    if (this.scrollOffset > maxOffset) {
      this.scrollOffset = maxOffset;
    }

    const output: string[] = [];
    const row = (content: string): string => {
      const padded = padToWidth(truncateToWidth(content, innerWidth, ""), innerWidth);
      return this.theme.fg("border", "│") + padded + this.theme.fg("border", "│");
    };

    output.push(this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`));
    output.push(row(this.headerText(innerWidth)));
    output.push(row(""));

    const end = Math.min(this.scrollOffset + visible, displayLines.length);
    for (let index = this.scrollOffset; index < end; index++) {
      const displayLine = displayLines[index];
      const styled = styleLine(
        this.theme,
        displayLine.text,
        lineStyle(displayLine.originalLine),
        displayLine.continuation,
      );
      output.push(row(` ${styled}`));
    }

    for (let index = end - this.scrollOffset; index < visible; index++) {
      output.push(row(""));
    }

    output.push(row(""));
    output.push(row(this.footerText(innerWidth, end, displayLines.length)));
    output.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));

    return output;
  }

  invalidate(): void {}

  private visibleLines(): number {
    const height = this.tui.terminal.rows;
    if (!height || height <= 0) return 30;
    return Math.max(1, Math.floor(height * 0.92) - 5);
  }

  private buildDisplayLines(contentWidth: number): DisplayLine[] {
    const displayLines: DisplayLine[] = [];

    for (const line of this.lines) {
      const wrapped = wrapTextWithAnsi(line, contentWidth);
      if (wrapped.length === 0) {
        displayLines.push({ text: "", originalLine: line, continuation: false });
        continue;
      }

      for (let index = 0; index < wrapped.length; index++) {
        displayLines.push({
          text: wrapped[index] ?? "",
          originalLine: line,
          continuation: index > 0,
        });
      }
    }

    return displayLines;
  }

  private headerText(width: number): string {
    const title = this.theme.fg("accent", this.theme.bold("System Prompt"));
    const stats = this.theme.fg(
      "dim",
      `${this.document.promptLineCount} lines, ${this.document.promptCharCount.toLocaleString()} chars, ${this.document.toolCount} tools`,
    );
    return truncateToWidth(` ${title}  ${stats}`, width, "…");
  }

  private footerText(width: number, end: number, total: number): string {
    const percent = total > 0 ? Math.round((this.scrollOffset / total) * 100) : 0;
    const footerLeft = `${Math.min(this.scrollOffset + 1, total)}-${end}/${total} (${percent}%)`;
    const copyLabel = Date.now() - this.copiedAt < 2_000 ? this.theme.fg("success", "copied") : "copy";
    const footerRight = `c ${copyLabel}  ↑↓/jk pgup/pgdn home/end  Esc/q`;
    const gap = Math.max(1, width - 1 - visibleWidth(footerLeft) - visibleWidth(footerRight));
    return truncateToWidth(
      ` ${this.theme.fg("dim", footerLeft)}${" ".repeat(gap)}${this.theme.fg("dim", footerRight)}`,
      width,
      "",
    );
  }

  private copyToClipboard(): void {
    const base64 = Buffer.from(this.fullText, "utf8").toString("base64");
    process.stdout.write(`\x1b]52;c;${base64}\x07`);
    this.copiedAt = Date.now();
  }
}

function padToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export default function debugExtension(pi: ExtensionAPI) {
  let lastAgentStartPrompt: PromptSnapshot | undefined;

  pi.on("agent_start", (_event, ctx) => {
    lastAgentStartPrompt = {
      label: "last",
      prompt: ctx.getSystemPrompt(),
      capturedAt: Date.now(),
      source: "ctx.getSystemPrompt() at agent_start",
    };
  });

  registerDebugCommand(pi, () => lastAgentStartPrompt);
}

export const __test__ = {
  DEBUG_COMPLETIONS,
  HELP_TEXT,
  parsePromptArgs,
  buildToolLines,
  formatPromptDocument,
  lineStyle,
};
