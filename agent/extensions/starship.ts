/**
 * Starship-inspired pi status bar
 *
 * Renders the status bar inside the editor's top border — just like
 * pi-powerline-footer and your shell prompt — not in the footer below.
 *
 *   [status line]
 *    ────────────────────────────
 *    ❯  your prompt here
 *    ────────────────────────────
 *
 * Segments: path · git · model · thinking · context · tokens · cost
 * Styled to match ~/.config/starship.toml aesthetics.
 * Inspired by https://www.npmjs.com/package/pi-powerline-footer
 *
 * Commands:
 *   /starship              – show current preset
 *   /starship <preset>     – switch preset (default / minimal / compact / full)
 *
 * Nerd Fonts auto-detected via TERM_PROGRAM / GHOSTTY_RESOURCES_DIR.
 * Override: POWERLINE_NERD_FONTS=1  (force on)  or  =0  (force off).
 */

import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";

import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { spawn } from "node:child_process";
import { basename } from "node:path";

// ─── Nerd Font Detection ─────────────────────────────────────────────────────
// Same heuristic as pi-powerline-footer / oh-my-pi.

function detectNerdFonts(): boolean {
  if (process.env.POWERLINE_NERD_FONTS === "1") return true;
  if (process.env.POWERLINE_NERD_FONTS === "0") return false;
  if (process.env.GHOSTTY_RESOURCES_DIR) return true;            // Ghostty (survives tmux)
  const term = (process.env.TERM_PROGRAM ?? "").toLowerCase();
  return ["iterm", "wezterm", "kitty", "ghostty", "alacritty"].some(t => term.includes(t));
}

const NERD = detectNerdFonts();

// ─── Icons ───────────────────────────────────────────────────────────────────
// Nerd Font codepoints match your starship.toml where possible.

const I = {
  dir:       NERD ? "\uF115"  : "",          // nf-fa-folder_open
  branch:    NERD ? "\uE0A0"  : "⎇",         // nf-pl-branch  ← same as starship symbol = " "
  staged:          "+",
  unstaged:        "!",                       // starship default git_status symbols
  untracked:       "u",
  model:     NERD ? "\uEC19"  : "◈",          // nf-md-chip
  ctx:       NERD ? "\uE70F"  : "ctx",        // nf-dev-database
  cost:      NERD ? "\uF155"  : "$",          // nf-fa-dollar
  tokIn:     NERD ? "\uF090"  : "↑",          // nf-fa-sign_in
  tokOut:    NERD ? "\uF08B"  : "↓",          // nf-fa-sign_out
  time:      NERD ? "\uF017"  : "⏱",          // nf-fa-clock_o
} as const;

// ─── Separators ──────────────────────────────────────────────────────────────

const SEP_THIN = " ❯ ";   // matches your starship/shell prompt glyph
const SEP_DOT  = " · ";

// ─── Custom hex colors ───────────────────────────────────────────────────────
// Palette from pi-powerline-footer / oh-my-pi dark theme.

function hexFg(color: string, text: string): string {
  const h = color.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

const C_PATH  = "#00afaf";   // teal   – similar feel to starship's "fg:blue"
const C_MODEL = "#d787af";   // mauve  – oh-my-pi model color

// Rainbow stops for high/xhigh thinking (Claude Code ultrathink-inspired)
const RAINBOW = ["#b281d6","#d787af","#febc38","#e4c00f","#89d281","#00afaf","#178fb9"];

function rainbow(text: string): string {
  let out = ""; let i = 0;
  for (const ch of text) {
    out += (ch === " " || ch === ":" || ch === "." || ch === "/")
      ? ch
      : hexFg(RAINBOW[i++ % RAINBOW.length], ch);
  }
  return out;
}

// ─── Git Status (async background fetch, synchronous render) ─────────────────
// Pattern from git-status.ts in pi-powerline-footer:
// render() returns cached value immediately; background fetch updates cache
// and calls onRefresh() to trigger a re-render.

interface GitState {
  branch:    string | null;
  staged:    number;
  unstaged:  number;
  untracked: number;
  ts:        number;
}

let _gitCache: GitState | null = null;
let _gitPending = false;
let _gitGen = 0;          // incremented on invalidation to discard stale fetches
const GIT_TTL = 1_000;   // ms – matches pi-powerline-footer

function gitRun(args: string[], timeoutMs = 300): Promise<string | null> {
  return new Promise(resolve => {
    const p = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let done = false;
    const finish = (v: string | null) => {
      if (done) return; done = true; clearTimeout(t); resolve(v);
    };
    p.stdout.on("data", d => { out += d; });
    p.on("close", c => finish(c === 0 ? out.trim() : null));
    p.on("error", () => finish(null));
    const t = setTimeout(() => { p.kill(); finish(null); }, timeoutMs);
  });
}

async function gitFetch(): Promise<GitState> {
  // Branch (empty string = detached HEAD)
  let branch = await gitRun(["branch", "--show-current"]);
  if (branch === "") {
    const sha = await gitRun(["rev-parse", "--short", "HEAD"]);
    branch = sha ? `${sha} (detached)` : "detached";
  }

  // Status counts – matching starship [git_status] defaults
  const raw = await gitRun(["status", "--porcelain"], 500) ?? "";
  let staged = 0, unstaged = 0, untracked = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const x = line[0], y = line[1];
    if (x === "?" && y === "?") { untracked++; continue; }
    if (x && x !== " " && x !== "?") staged++;
    if (y && y !== " ") unstaged++;
  }

  return { branch, staged, unstaged, untracked, ts: Date.now() };
}

/** Synchronous read from cache; triggers background refresh and calls onRefresh when done. */
function gitGet(onRefresh: () => void): GitState {
  const now = Date.now();
  if (_gitCache && now - _gitCache.ts < GIT_TTL) return _gitCache;

  if (!_gitPending) {
    _gitPending = true;
    const gen = ++_gitGen;
    gitFetch().then(state => {
      if (gen === _gitGen) { _gitCache = state; onRefresh(); }
      _gitPending = false;
    }).catch(() => { _gitPending = false; });
  }

  // Return stale while refreshing, or empty for non-git dirs on first call
  return _gitCache ?? { branch: null, staged: 0, unstaged: 0, untracked: 0, ts: 0 };
}

function gitInvalidate() { _gitCache = null; _gitGen++; }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n <    1_000) return `${n}`;
  if (n <   10_000) return `${(n / 1_000).toFixed(1)}k`;
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

/** Last N path components with "…/" prefix – matches starship truncation_length=3. */
function fmtPath(cwd: string, mode: "basename" | "abbreviated" | "full"): string {
  const home = process.env.HOME ?? "";
  const path = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
  if (mode === "basename") return basename(cwd) || path;
  if (mode === "full")     return path;
  // abbreviated – starship: truncation_symbol="…/" truncation_length=3
  const parts = path.split("/").filter(Boolean);
  if (path.startsWith("~")) parts[0] = "~";
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : path;
}

// ─── Presets ─────────────────────────────────────────────────────────────────

type SegmentId =
  | "path" | "git" | "model" | "thinking"
  | "context" | "tokens" | "token_in" | "token_out"
  | "cost" | "time_spent";

type PathMode = "basename" | "abbreviated" | "full";
type Preset   = "default" | "minimal" | "compact" | "full";

interface PresetDef { segments: SegmentId[]; pathMode: PathMode; sep: string; }

const PRESETS: Record<Preset, PresetDef> = {
  default: {
    segments: ["path", "git", "model", "thinking", "context", "tokens", "cost"],
    pathMode: "basename", sep: SEP_THIN,
  },
  minimal: {
    segments: ["path", "git", "context"],
    pathMode: "basename", sep: SEP_DOT,
  },
  compact: {
    segments: ["path", "git", "model", "context", "cost"],
    pathMode: "abbreviated", sep: SEP_THIN,
  },
  full: {
    segments: ["path", "git", "model", "thinking", "context", "token_in", "token_out", "cost", "time_spent"],
    pathMode: "abbreviated", sep: SEP_THIN,
  },
};

// ─── Status line builder ──────────────────────────────────────────────────────

function buildStatusLine(
  ctx: ExtensionContext,
  footerData: any,
  pi: ExtensionAPI,
  preset: Preset,
  sessionStart: number,
  width: number,
  requestRenderFn: (() => void) | undefined,
): string {
  // ctx.ui.theme has the semantic .fg() method; the `theme` parameter in
  // setEditorComponent is the pi-tui editor border theme and does NOT have .fg().
  const theme = ctx.ui.theme;
  const pd = PRESETS[preset];

  // Git – synchronous from cache; background refresh triggers a re-render
  const git    = gitGet(() => requestRenderFn?.());
  const branch = footerData.getGitBranch?.() ?? git.branch;

  // Session usage stats
  let tokIn = 0, tokOut = 0, cost = 0;
  for (const e of ctx.sessionManager.getBranch()) {
    if (e.type === "message" && e.message.role === "assistant") {
      const m = e.message as AssistantMessage;
      tokIn  += m.usage?.input       ?? 0;
      tokOut += m.usage?.output      ?? 0;
      cost   += m.usage?.cost?.total ?? 0;
    }
  }

  // Context window usage
  const usage  = ctx.getContextUsage?.();
  const ctxMax = ctx.model?.contextWindow;
  const ctxPct = usage && ctxMax ? Math.min(100, (usage.tokens / ctxMax) * 100) : null;

  // Thinking level
  const thinkLevel = pi.getThinkingLevel();

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
        // Branch in fg:240-ish gray – matching [git_branch] style = "fg:240"
        s = theme.fg("dim", `${I.branch} ${branch}`);
        // Status – starship [git_status] style: `[ main [+2 !1 ?5]]`
        const ind: string[] = [];
        if (git.staged    > 0) ind.push(theme.fg("success", "+"));
        if (git.unstaged  > 0) ind.push(theme.fg("warning", "!"));
        if (git.untracked > 0) ind.push(theme.fg("muted",   "?"));
        if (ind.length) s += " " + theme.fg("dim", "[") + ind.join("") + theme.fg("dim", "]");
        break;
      }

      case "model": {
        if (!ctx.model) break;
        let id = ctx.model.id
          .replace(/^claude-/, "")
          .replace(/-\d{8}$/, "");   // strip date suffix like -20250514
        if (id.length > 22) id = id.slice(0, 21) + "…";
        s = hexFg(C_MODEL, `${I.model} ${ctx.model.provider}/${id}`);
        break;
      }

      case "thinking": {
        if (thinkLevel === "off") break;
        const label: Record<string, string> = {
          minimal: "min", low: "low", medium: "med", high: "high", xhigh: "xhi",
        };
        const str = `think:${label[thinkLevel] ?? thinkLevel}`;
        const piColors: Record<string, string> = {
          minimal: "thinkingMinimal", low: "thinkingLow",
          medium: "thinkingMedium",  high: "thinkingHigh", xhigh: "thinkingXhigh",
        };
        s = (thinkLevel === "high" || thinkLevel === "xhigh")
          ? rainbow(str)
          : theme.fg(piColors[thinkLevel] ?? "muted", str);
        break;
      }

      case "context": {
        if (ctxPct === null) break;
        const col = ctxPct >= 90 ? "error" : ctxPct >= 70 ? "warning" : "dim";
        const label = ctxMax
          ? `${ctxPct.toFixed(1)}%/${fmtNum(ctxMax)}`
          : `${ctxPct.toFixed(1)}%`;
        s = theme.fg(col, `${I.ctx} ${label}`);
        break;
      }

      case "tokens": {
        if (!tokIn && !tokOut) break;
        s = theme.fg("muted", `${I.tokIn} ${fmtNum(tokIn)} ${I.tokOut} ${fmtNum(tokOut)}`);
        break;
      }

      case "token_in":  { if (tokIn)  s = theme.fg("muted", `${I.tokIn} ${fmtNum(tokIn)}`);  break; }
      case "token_out": { if (tokOut) s = theme.fg("muted", `${I.tokOut} ${fmtNum(tokOut)}`); break; }

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
  return " " + truncateToWidth(parts.join(pd.sep), width - 2) + " ";
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let preset: Preset = "default";
  let requestRender: (() => void) | undefined;
  let sessionStart = Date.now();

  // Invalidate git on file mutations or branch-changing bash commands
  pi.on("tool_result", async event => {
    if (event.toolName === "write" || event.toolName === "edit") {
      gitInvalidate();
    }
    if (event.toolName === "bash") {
      const cmd = String((event as any).input?.command ?? "");
      if (/\bgit\s+(checkout|switch|merge|rebase|pull|reset)/.test(cmd)) {
        gitInvalidate();
        setTimeout(() => requestRender?.(), 150);
      }
    }
  });

  pi.on("turn_start",   async () => { requestRender?.(); });
  pi.on("turn_end",     async () => { gitInvalidate(); requestRender?.(); });
  pi.on("model_select", async () => { requestRender?.(); });

  pi.on("session_start", async (_ev, ctx) => {
    sessionStart = Date.now();
    gitInvalidate();
    installStatusBar(ctx);
  });

  pi.registerCommand("starship", {
    description: "Switch Starship status bar preset: default / minimal / compact / full",
    getArgumentCompletions: () =>
      (["default", "minimal", "compact", "full"] as Preset[])
        .map(p => ({ value: p, label: p })),
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase() as Preset;
      if (!arg) {
        ctx.ui.notify(`Preset: ${preset}  (options: default · minimal · compact · full)`, "info");
        return;
      }
      if (!(arg in PRESETS)) {
        ctx.ui.notify(`Unknown preset "${arg}". Options: default · minimal · compact · full`, "warning");
        return;
      }
      preset = arg;
      installStatusBar(ctx);
      ctx.ui.notify(`Starship → ${preset}`, "info");
    },
  });

  // ── Status bar injected into the editor border ────────────────────────────

  function installStatusBar(ctx: ExtensionContext) {
    let footerDataRef: any = null;

    // setFooter is used purely to get footerDataRef (git branch + onBranchChange).
    // render() returns [] so nothing appears in the actual footer below the editor.
    ctx.ui.setFooter((tui, _theme, footerData) => {
      footerDataRef = footerData;
      requestRender = () => tui.requestRender();

      const unsub = footerData.onBranchChange(() => {
        gitInvalidate();
        tui.requestRender();
      });

      return {
        dispose: unsub,
        invalidate() {},
        render(): string[] { return []; },
      };
    });

    // Replace the editor with one that injects the status bar above its top border.
    // This matches the pi-powerline-footer layout:
    //
    //   [status line]
    //    ────────────────────────────
    //    ❯  your prompt here
    //    ────────────────────────────
    //
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new CustomEditor(tui, theme, keybindings);
      const origRender = editor.render.bind(editor);

      editor.render = (width: number): string[] => {
        // Fall back to default render if too narrow or footer not yet wired
        if (width < 15 || !footerDataRef) return origRender(width);

        // Build the status line (full width)
        const statusLine = buildStatusLine(
          ctx, footerDataRef, pi, preset, sessionStart, width, requestRender,
        );

        // Render the inner editor at width-3 to leave room for " ❯ " prompt prefix
        const contentWidth = Math.max(1, width - 3);
        const lines = origRender(contentWidth);
        if (lines.length === 0) return lines;

        // Locate the bottom border line (last line matching ─────)
        let bottomIdx = lines.length - 1;
        for (let i = lines.length - 1; i >= 1; i--) {
          const plain = (lines[i] ?? "").replace(/\x1b\[[0-9;]*m/g, "");
          if (/^[\s]*─{3,}/.test(plain)) { bottomIdx = i; break; }
        }

        // Prompt glyph matches your shell: ❯
        const promptFg = `\x1b[38;2;200;200;200m❯\x1b[0m`;
        const promptPfx = ` ${promptFg} `;
        const contPfx   = "   ";

        const out: string[] = [];

        // 1. Status bar line
        out.push(statusLine);

        // 2. Editor content (skip original top/bottom border lines)
        for (let i = 1; i < bottomIdx; i++) {
          out.push((i === 1 ? promptPfx : contPfx) + (lines[i] ?? ""));
        }

        // Edge case: single-line editor (no content between borders)
        if (bottomIdx <= 1) {
          out.push(promptPfx + " ".repeat(contentWidth));
        }

        // 3. Lines after bottom border (footer placeholder rows, etc.)
        for (let i = bottomIdx + 1; i < lines.length; i++) {
          out.push(lines[i] ?? "");
        }

        return out;
      };

      return editor;
    });
  }
}
