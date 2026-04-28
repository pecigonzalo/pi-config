import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { spawn } from "node:child_process";
import { basename } from "node:path";

function detectNerdFonts(): boolean {
  if (process.env.POWERLINE_NERD_FONTS === "1") return true;
  if (process.env.POWERLINE_NERD_FONTS === "0") return false;
  if (process.env.GHOSTTY_RESOURCES_DIR) return true;
  const term = (process.env.TERM_PROGRAM ?? "").toLowerCase();
  return ["iterm", "wezterm", "kitty", "ghostty", "alacritty"].some((t) => term.includes(t));
}

const NERD = detectNerdFonts();

const I = {
  dir: NERD ? "\uF115" : "",
  branch: NERD ? "\uE0A0" : "⎇",
  model: NERD ? "\uEC19" : "◈",
  agent: NERD ? "\uF007" : "@",
  ctx: NERD ? "\uE70F" : "ctx",
  cost: NERD ? "\uF155" : "$",
  tokIn: NERD ? "\uF090" : "↑",
  tokOut: NERD ? "\uF08B" : "↓",
  time: NERD ? "\uF017" : "⏱",
} as const;

const SEP_THIN = " ❯ ";
const SEP_DOT = " · ";

function hexFg(color: string, text: string): string {
  const h = color.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

const C_PATH = "#00afaf";
const C_MODEL = "#d787af";
const RAINBOW = ["#b281d6", "#d787af", "#febc38", "#e4c00f", "#89d281", "#00afaf", "#178fb9"];

function rainbow(text: string): string {
  let out = "";
  let i = 0;
  for (const ch of text) {
    out += ch === " " || ch === ":" || ch === "." || ch === "/" ? ch : hexFg(RAINBOW[i++ % RAINBOW.length], ch);
  }
  return out;
}

interface GitState {
  branch: string | null;
  staged: number;
  unstaged: number;
  untracked: number;
  ts: number;
}

let gitCache: GitState | null = null;
let gitPending = false;
let gitGeneration = 0;
const GIT_TTL = 1_000;

function gitRun(args: string[], timeoutMs = 300): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timeoutHandle);
      resolve(v);
    };

    p.stdout.on("data", (d) => {
      out += d;
    });
    p.on("close", (code) => finish(code === 0 ? out.trim() : null));
    p.on("error", () => finish(null));

    const timeoutHandle = setTimeout(() => {
      p.kill();
      finish(null);
    }, timeoutMs);
  });
}

async function gitFetch(): Promise<GitState> {
  let branch = await gitRun(["branch", "--show-current"]);
  if (branch === "") {
    const sha = await gitRun(["rev-parse", "--short", "HEAD"]);
    branch = sha ? `${sha} (detached)` : "detached";
  }

  const raw = (await gitRun(["status", "--porcelain"], 500)) ?? "";
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

function gitGet(onRefresh: () => void): GitState {
  const now = Date.now();
  if (gitCache && now - gitCache.ts < GIT_TTL) return gitCache;

  if (!gitPending) {
    gitPending = true;
    const generation = ++gitGeneration;
    void gitFetch()
      .then((state) => {
        if (generation === gitGeneration) {
          gitCache = state;
          onRefresh();
        }
      })
      .finally(() => {
        gitPending = false;
      });
  }

  return gitCache ?? { branch: null, staged: 0, unstaged: 0, untracked: 0, ts: 0 };
}

function gitInvalidate(): void {
  gitCache = null;
  gitGeneration++;
}

function fmtNum(n: number): string {
  if (n < 1_000) return `${n}`;
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1_000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${m % 60}m`;
  if (m > 0) return `${m}m${s % 60}s`;
  return `${s}s`;
}

function fmtPath(cwd: string, mode: PathMode): string {
  const home = process.env.HOME ?? "";
  const value = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  if (mode === "basename") return basename(cwd) || value;
  if (mode === "full") return value;

  const parts = value.split("/").filter(Boolean);
  if (value.startsWith("~")) parts[0] = "~";
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : value;
}

export type SegmentId =
  | "path"
  | "git"
  | "agent"
  | "model"
  | "thinking"
  | "context"
  | "tokens"
  | "token_in"
  | "token_out"
  | "cost"
  | "time_spent";

export type PathMode = "basename" | "abbreviated" | "full";
export type Preset = "default" | "minimal" | "compact" | "full";

interface PresetDef {
  segments: SegmentId[];
  pathMode: PathMode;
  sep: string;
}

const PRESETS: Record<Preset, PresetDef> = {
  default: {
    segments: ["path", "git", "agent", "model", "thinking", "context", "tokens", "cost"],
    pathMode: "basename",
    sep: SEP_THIN,
  },
  minimal: {
    segments: ["path", "git", "context"],
    pathMode: "basename",
    sep: SEP_DOT,
  },
  compact: {
    segments: ["path", "git", "agent", "model", "context", "cost"],
    pathMode: "abbreviated",
    sep: SEP_THIN,
  },
  full: {
    segments: ["path", "git", "agent", "model", "thinking", "context", "token_in", "token_out", "cost", "time_spent"],
    pathMode: "abbreviated",
    sep: SEP_THIN,
  },
};

function getDisplayedAgentName(pi: ExtensionAPI): string {
  if (process.env.PI_AGENT_NAME) return process.env.PI_AGENT_NAME;
  const flagValue = pi.getFlag("agent-name");
  if (typeof flagValue === "string" && flagValue.length > 0) return flagValue;
  return "default";
}

function buildStatusLine(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  preset: Preset,
  sessionStart: number,
  width: number,
  requestRender: (() => void) | undefined,
): string {
  const theme = ctx.ui.theme;
  const pd = PRESETS[preset];

  const git = gitGet(() => requestRender?.());
  const branch = git.branch;

  let tokIn = 0;
  let tokOut = 0;
  let cost = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const message = entry.message as AssistantMessage;
      tokIn += message.usage?.input ?? 0;
      tokOut += message.usage?.output ?? 0;
      cost += message.usage?.cost?.total ?? 0;
    }
  }

  const usage = ctx.getContextUsage?.();
  const ctxMax = ctx.model?.contextWindow;
  const ctxPct = usage && ctxMax ? Math.min(100, (usage.tokens / ctxMax) * 100) : null;

  const thinkLevel = pi.getThinkingLevel();
  const agentName = getDisplayedAgentName(pi);
  const parts: string[] = [];

  for (const seg of pd.segments) {
    let s = "";

    switch (seg) {
      case "path": {
        const label = fmtPath(ctx.cwd, pd.pathMode);
        s = hexFg(C_PATH, I.dir ? `${I.dir} ${label}` : label);
        break;
      }

      case "git": {
        if (!branch) break;
        s = theme.fg("dim", `${I.branch} ${branch}`);
        const ind: string[] = [];
        if (git.staged > 0) ind.push(theme.fg("success", "+"));
        if (git.unstaged > 0) ind.push(theme.fg("warning", "!"));
        if (git.untracked > 0) ind.push(theme.fg("muted", "?"));
        if (ind.length) s += ` ${theme.fg("dim", "[")}${ind.join("")}${theme.fg("dim", "]")}`;
        break;
      }

      case "agent": {
        const label = agentName || "default";
        s = theme.fg(label === "default" ? "dim" : "accent", `${I.agent} ${label}`.trim());
        break;
      }

      case "model": {
        if (!ctx.model) break;
        let id = ctx.model.id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
        if (id.length > 22) id = `${id.slice(0, 21)}…`;
        s = hexFg(C_MODEL, `${I.model} ${ctx.model.provider}/${id}`);
        break;
      }

      case "thinking": {
        if (thinkLevel === "off") break;
        const label: Record<string, string> = {
          minimal: "min",
          low: "low",
          medium: "med",
          high: "high",
          xhigh: "xhi",
        };
        const value = `think:${label[thinkLevel] ?? thinkLevel}`;
        const piColors: Record<string, string> = {
          minimal: "thinkingMinimal",
          low: "thinkingLow",
          medium: "thinkingMedium",
          high: "thinkingHigh",
          xhigh: "thinkingXhigh",
        };
        s = thinkLevel === "high" || thinkLevel === "xhigh" ? rainbow(value) : theme.fg(piColors[thinkLevel] ?? "muted", value);
        break;
      }

      case "context": {
        if (ctxPct === null) break;
        const color = ctxPct >= 90 ? "error" : ctxPct >= 70 ? "warning" : "dim";
        const label = ctxMax ? `${ctxPct.toFixed(1)}%/${fmtNum(ctxMax)}` : `${ctxPct.toFixed(1)}%`;
        s = theme.fg(color, `${I.ctx} ${label}`);
        break;
      }

      case "tokens": {
        if (!tokIn && !tokOut) break;
        s = theme.fg("muted", `${I.tokIn} ${fmtNum(tokIn)} ${I.tokOut} ${fmtNum(tokOut)}`);
        break;
      }

      case "token_in": {
        if (tokIn) s = theme.fg("muted", `${I.tokIn} ${fmtNum(tokIn)}`);
        break;
      }

      case "token_out": {
        if (tokOut) s = theme.fg("muted", `${I.tokOut} ${fmtNum(tokOut)}`);
        break;
      }

      case "cost": {
        if (!cost) break;
        s = theme.fg("text", `${I.cost}${cost.toFixed(3)}`);
        break;
      }

      case "time_spent": {
        const elapsed = Date.now() - sessionStart;
        if (elapsed < 1_000) break;
        s = theme.fg("dim", `${I.time} ${fmtDuration(elapsed)}`);
        break;
      }
    }

    if (s && visibleWidth(s) > 0) parts.push(s);
  }

  if (parts.length === 0) return " ".repeat(width);
  const contentWidth = Math.max(0, width - 2);
  const content = truncateToWidth(parts.join(pd.sep), contentWidth);
  return ` ${content} `;
}

export interface SessionContextPart {
  setRequestRender(requestRender: (() => void) | undefined): void;
  onSessionStart(): void;
  onTurnStart(): void;
  onTurnEnd(): void;
  onModelSelect(): void;
  onToolResult(event: { toolName: string; input?: unknown }): void;
  onSessionShutdown(): void;
  buildLine(ctx: ExtensionContext, width: number): string;
  getPreset(): Preset;
  setPreset(preset: Preset): void;
}

export function createSessionContextPart(pi: ExtensionAPI): SessionContextPart {
  let preset: Preset = "default";
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

    onToolResult(event) {
      if (event.toolName === "write" || event.toolName === "edit") {
        gitInvalidate();
        requestRender?.();
      }

      if (event.toolName === "bash") {
        const cmd = String((event as { input?: { command?: unknown } }).input?.command ?? "");
        if (/\bgit\s+(checkout|switch|merge|rebase|pull|reset)/.test(cmd)) {
          gitInvalidate();
          setTimeout(() => requestRender?.(), 150);
        }
      }
    },

    onSessionShutdown() {
      requestRender = undefined;
    },

    buildLine(ctx, width) {
      return buildStatusLine(ctx, pi, preset, sessionStart, width, requestRender);
    },

    getPreset() {
      return preset;
    },

    setPreset(nextPreset) {
      preset = nextPreset;
      requestRender?.();
    },
  };
}

export const sessionContextPresets: Preset[] = ["default", "minimal", "compact", "full"];

export function parseContextPreset(value: string): Preset | undefined {
  const normalized = value.trim().toLowerCase();
  return sessionContextPresets.find((preset) => preset === normalized);
}
