import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { FooterLayoutName } from "./core/types";
import { footerLayoutNames } from "./layouts";

function detectNerdFonts(): boolean {
  if (process.env.POWERLINE_NERD_FONTS === "1") return true;
  if (process.env.POWERLINE_NERD_FONTS === "0") return false;
  if (process.env.GHOSTTY_RESOURCES_DIR) return true;
  const term = (process.env.TERM_PROGRAM ?? "").toLowerCase();
  return ["iterm", "wezterm", "kitty", "ghostty", "alacritty"].some((value) => term.includes(value));
}

const nerdFontsEnabled = detectNerdFonts();

const icons = {
  dir: nerdFontsEnabled ? "\uF115" : "",
  branch: nerdFontsEnabled ? "\uE0A0" : "⎇",
  model: nerdFontsEnabled ? "\uEC19" : "◈",
  agent: nerdFontsEnabled ? "\uF007" : "@",
  ctx: nerdFontsEnabled ? "\uE70F" : "ctx",
  cost: nerdFontsEnabled ? "\uF155" : "$",
  tokIn: nerdFontsEnabled ? "\uF090" : "↑",
  tokOut: nerdFontsEnabled ? "\uF08B" : "↓",
  time: nerdFontsEnabled ? "\uF017" : "⏱",
} as const;

const pathColor = "#00afaf";
const modelColor = "#d787af";
const rainbowColors = ["#b281d6", "#d787af", "#febc38", "#e4c00f", "#89d281", "#00afaf", "#178fb9"];

function hexFg(color: string, text: string): string {
  const normalized = color.replace("#", "");
  const red = parseInt(normalized.slice(0, 2), 16);
  const green = parseInt(normalized.slice(2, 4), 16);
  const blue = parseInt(normalized.slice(4, 6), 16);
  return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[0m`;
}

function rainbow(text: string): string {
  let rendered = "";
  let colorIndex = 0;

  for (const char of text) {
    rendered += char === " " || char === ":" || char === "." || char === "/" ? char : hexFg(rainbowColors[colorIndex++ % rainbowColors.length], char);
  }

  return rendered;
}

interface GitState {
  branch: string | null;
  staged: number;
  unstaged: number;
  untracked: number;
  ts: number;
}

const gitCache = new Map<string, GitState>();
const gitPending = new Set<string>();
const gitGeneration = new Map<string, number>();
let gitEpoch = 0;
const gitTtlMs = 1_000;

function nextGitGeneration(cwd: string): number {
  const next = (gitGeneration.get(cwd) ?? 0) + 1;
  gitGeneration.set(cwd, next);
  return next;
}

function gitRun(cwd: string, args: string[], timeoutMs = 300): Promise<string | null> {
  return new Promise((resolve) => {
    const process = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let finished = false;

    const finish = (result: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    process.stdout.on("data", (data) => {
      output += data;
    });
    process.on("close", (code) => finish(code === 0 ? output.trim() : null));
    process.on("error", () => finish(null));

    const timeoutHandle = setTimeout(() => {
      process.kill();
      finish(null);
    }, timeoutMs);
  });
}

async function gitFetch(cwd: string): Promise<GitState> {
  let branch = await gitRun(cwd, ["branch", "--show-current"]);
  if (branch === "") {
    const sha = await gitRun(cwd, ["rev-parse", "--short", "HEAD"]);
    branch = sha ? `${sha} (detached)` : "detached";
  }

  const raw = (await gitRun(cwd, ["status", "--porcelain"], 500)) ?? "";
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of raw.split("\n")) {
    if (!line) continue;
    const x = line[0];
    const y = line[1];
    if (x === "?" && y === "?") {
      untracked++;
      continue;
    }
    if (x && x !== " " && x !== "?") staged++;
    if (y && y !== " ") unstaged++;
  }

  return { branch, staged, unstaged, untracked, ts: Date.now() };
}

function gitGet(cwd: string, onRefresh: () => void): GitState {
  const now = Date.now();
  const cached = gitCache.get(cwd);
  if (cached && now - cached.ts < gitTtlMs) return cached;

  if (!gitPending.has(cwd)) {
    gitPending.add(cwd);
    const generation = nextGitGeneration(cwd);
    const epoch = gitEpoch;
    void gitFetch(cwd)
      .then((state) => {
        if (epoch === gitEpoch && generation === gitGeneration.get(cwd)) {
          gitCache.set(cwd, state);
          onRefresh();
        }
      })
      .finally(() => {
        gitPending.delete(cwd);
      });
  }

  return cached ?? { branch: null, staged: 0, unstaged: 0, untracked: 0, ts: 0 };
}

function gitInvalidate(cwd?: string): void {
  if (cwd) {
    gitCache.delete(cwd);
    gitPending.delete(cwd);
    nextGitGeneration(cwd);
  } else {
    gitCache.clear();
    gitPending.clear();
    gitEpoch++;
  }
}

function fmtNum(value: number): string {
  if (value < 1_000) return `${value}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function fmtDuration(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m${seconds % 60}s`;
  return `${seconds}s`;
}

function fmtPath(cwd: string, mode: PathMode): string {
  const home = process.env.HOME ?? "";
  const normalized = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  if (mode === "basename") return basename(cwd) || normalized;
  if (mode === "full") return normalized;

  const parts = normalized.split("/").filter(Boolean);
  if (normalized.startsWith("~")) parts[0] = "~";
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : normalized;
}

function getDisplayedAgentName(pi: ExtensionAPI): string {
  if (process.env.PI_AGENT_NAME) return process.env.PI_AGENT_NAME;
  const flagValue = pi.getFlag("agent-name");
  if (typeof flagValue === "string" && flagValue.length > 0) return flagValue;
  return "default";
}

function getUsageTotals(ctx: ExtensionContext): { tokIn: number; tokOut: number; cost: number } {
  let tokIn = 0;
  let tokOut = 0;
  let cost = 0;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message as AssistantMessage;
    tokIn += message.usage?.input ?? 0;
    tokOut += message.usage?.output ?? 0;
    cost += message.usage?.cost?.total ?? 0;
  }

  return { tokIn, tokOut, cost };
}

export type SegmentId =
  | "path"
  | "git"
  | "agent"
  | "model"
  | "thinking"
  | "context"
  | "tokens"
  | "cost"
  | "time_spent";

export type PathMode = "basename" | "abbreviated" | "full";
export type Preset = FooterLayoutName;

export interface SessionContextRenderOptions {
  pathMode?: PathMode;
}

export interface SessionContextController {
  setRequestRender(requestRender: (() => void) | undefined): void;
  onSessionStart(): void;
  onTurnStart(): void;
  onTurnEnd(): void;
  onModelSelect(): void;
  onThinkingLevelSelect(): void;
  onToolResult(event: { toolName: string; input?: unknown }): void;
  onSessionShutdown(): void;
  renderSegment(ctx: ExtensionContext, segment: SegmentId, options?: SessionContextRenderOptions): string | null;
}

export function createSessionContextController(pi: ExtensionAPI): SessionContextController {
  let requestRender: (() => void) | undefined;
  let sessionStart = Date.now();

  return {
    setRequestRender(nextRequestRender) {
      requestRender = nextRequestRender;
    },

    onSessionStart() {
      sessionStart = Date.now();
      gitInvalidate();
      requestRender?.();
    },

    onTurnStart() {
      requestRender?.();
    },

    onTurnEnd() {
      gitInvalidate();
      requestRender?.();
    },

    onModelSelect() {
      requestRender?.();
    },

    onThinkingLevelSelect() {
      requestRender?.();
    },

    onToolResult(event) {
      if (event.toolName === "write" || event.toolName === "edit") {
        gitInvalidate();
        requestRender?.();
      }

      if (event.toolName === "bash") {
        const command = String((event as { input?: { command?: unknown } }).input?.command ?? "");
        if (/\bgit\s+(checkout|switch|merge|rebase|pull|reset)/.test(command)) {
          gitInvalidate();
          setTimeout(() => requestRender?.(), 150);
        }
      }
    },

    onSessionShutdown() {
      requestRender = undefined;
    },

    renderSegment(ctx, segment, options) {
      const theme = ctx.ui.theme;
      const { tokIn, tokOut, cost } = getUsageTotals(ctx);
      const usage = ctx.getContextUsage?.();
      const ctxMax = ctx.model?.contextWindow;
      const ctxPct = usage && ctxMax ? Math.min(100, (usage.tokens / ctxMax) * 100) : null;
      const thinkingLevel = pi.getThinkingLevel();
      const git = gitGet(ctx.cwd, () => requestRender?.());

      switch (segment) {
        case "path": {
          const label = fmtPath(ctx.cwd, options?.pathMode ?? "basename");
          return hexFg(pathColor, icons.dir ? `${icons.dir} ${label}` : label);
        }

        case "git": {
          if (!git.branch) return null;
          let rendered = theme.fg("dim", `${icons.branch} ${git.branch}`);
          const indicators: string[] = [];
          if (git.staged > 0) indicators.push(theme.fg("success", "+"));
          if (git.unstaged > 0) indicators.push(theme.fg("warning", "!"));
          if (git.untracked > 0) indicators.push(theme.fg("muted", "?"));
          if (indicators.length > 0) rendered += ` ${theme.fg("dim", "[")}${indicators.join("")}${theme.fg("dim", "]")}`;
          return rendered;
        }

        case "agent": {
          const label = getDisplayedAgentName(pi) || "default";
          return theme.fg(label === "default" ? "dim" : "accent", `${icons.agent} ${label}`.trim());
        }

        case "model": {
          if (!ctx.model) return null;
          let id = ctx.model.id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
          if (id.length > 22) id = `${id.slice(0, 21)}…`;
          return hexFg(modelColor, `${icons.model} ${ctx.model.provider}/${id}`);
        }

        case "thinking": {
          if (thinkingLevel === "off") return null;
          const label: Record<string, string> = {
            minimal: "min",
            low: "low",
            medium: "med",
            high: "high",
            xhigh: "xhi",
          };
          const value = `think:${label[thinkingLevel] ?? thinkingLevel}`;
          const colors = {
            minimal: "thinkingMinimal",
            low: "thinkingLow",
            medium: "thinkingMedium",
            high: "thinkingHigh",
            xhigh: "thinkingXhigh",
          } as const;
          const color = colors[thinkingLevel as keyof typeof colors] ?? "muted";
          return thinkingLevel === "high" || thinkingLevel === "xhigh"
            ? rainbow(value)
            : theme.fg(color, value);
        }

        case "context": {
          if (ctxPct === null) return null;
          const color = ctxPct >= 90 ? "error" : ctxPct >= 70 ? "warning" : "dim";
          const label = ctxMax ? `${ctxPct.toFixed(1)}%/${fmtNum(ctxMax)}` : `${ctxPct.toFixed(1)}%`;
          return theme.fg(color, `${icons.ctx} ${label}`);
        }

        case "tokens":
          return tokIn || tokOut ? theme.fg("muted", `${icons.tokIn} ${fmtNum(tokIn)} ${icons.tokOut} ${fmtNum(tokOut)}`) : null;

        case "cost":
          return cost ? theme.fg("text", `${icons.cost}${cost.toFixed(3)}`) : null;

        case "time_spent": {
          const elapsed = Date.now() - sessionStart;
          return elapsed >= 1_000 ? theme.fg("dim", `${icons.time} ${fmtDuration(elapsed)}`) : null;
        }
      }
    },
  };
}

export const sessionContextPresets: Preset[] = footerLayoutNames;

export function parseContextPreset(value: string): Preset | undefined {
  const normalized = value.trim().toLowerCase();
  return sessionContextPresets.find((preset) => preset === normalized);
}
