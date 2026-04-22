import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { complete, type Message } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";

interface ModelRef {
  provider: string;
  id: string;
}

interface FooterConfigFile {
  enabled?: boolean;
  model?: string | Partial<ModelRef>;
  smallModel?: string | Partial<ModelRef>;
  small_model?: string | Partial<ModelRef>;
  prompt?: string;
  fallbackToCurrentModel?: boolean;
  maxPromptChars?: number;
  maxTitleChars?: number;
  setSessionName?: boolean;
  titlePrefix?: string;
}

interface FooterSettings {
  enabled: boolean;
  model?: ModelRef;
  prompt: string;
  fallbackToCurrentModel: boolean;
  maxPromptChars: number;
  maxTitleChars: number;
  setSessionName: boolean;
  titlePrefix: string;
}

const DEFAULT_PROMPT = `Generate a concise title for this coding task.

Rules:
- 3 to 7 words
- no quotes
- no markdown
- no ending punctuation
- specific to the user request
- if the request is short or ambiguous, still produce the best useful title you can
- never ask for more information
- output the title only`;

const DEFAULTS: FooterSettings = {
  enabled: true,
  model: { provider: "github-copilot", id: "claude-haiku-4.5" },
  prompt: DEFAULT_PROMPT,
  fallbackToCurrentModel: true,
  maxPromptChars: 4_000,
  maxTitleChars: 80,
  setSessionName: true,
  titlePrefix: "pi - ",
};

function parseJsonc(text: string): unknown {
  let noComments = "";
  let inString = false;
  let stringQuote = "";
  let escaping = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      noComments += ch;
      if (escaping) {
        escaping = false;
      } else if (ch === "\\") {
        escaping = true;
      } else if (ch === stringQuote) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      noComments += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      if (i < text.length) noComments += "\n";
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length - 1 && !(text[i] === "*" && text[i + 1] === "/"))
        i++;
      i++;
      continue;
    }

    noComments += ch;
  }

  let cleaned = "";
  inString = false;
  stringQuote = "";
  escaping = false;

  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];

    if (inString) {
      cleaned += ch;
      if (escaping) {
        escaping = false;
      } else if (ch === "\\") {
        escaping = true;
      } else if (ch === stringQuote) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      cleaned += ch;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments[j])) j++;
      if (
        j < noComments.length &&
        (noComments[j] === "}" || noComments[j] === "]")
      ) {
        continue;
      }
    }

    cleaned += ch;
  }

  return JSON.parse(cleaned);
}

function readJsonFile(filePath: string): unknown | undefined {
  try {
    return parseJsonc(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

function parseModelRef(value: unknown): ModelRef | undefined {
  if (typeof value === "string") {
    const slash = value.indexOf("/");
    if (slash <= 0 || slash === value.length - 1) return undefined;
    return {
      provider: value.slice(0, slash).trim(),
      id: value.slice(slash + 1).trim(),
    };
  }

  if (!value || typeof value !== "object") return undefined;

  const provider =
    typeof (value as { provider?: unknown }).provider === "string"
      ? (value as { provider: string }).provider.trim()
      : "";
  const id =
    typeof (value as { id?: unknown }).id === "string"
      ? (value as { id: string }).id.trim()
      : "";

  if (!provider || !id) return undefined;
  return { provider, id };
}

function clampPositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function loadSettings(cwd: string): FooterSettings {
  const global =
    (readJsonFile(path.join(getAgentDir(), "footer.jsonc")) ?? {}) as FooterConfigFile;
  const project =
    (readJsonFile(path.join(cwd, ".pi", "footer.jsonc")) ?? {}) as FooterConfigFile;
  const merged = { ...global, ...project };

  return {
    enabled:
      typeof merged.enabled === "boolean" ? merged.enabled : DEFAULTS.enabled,
    model:
      parseModelRef(merged.model ?? merged.smallModel ?? merged.small_model) ??
      DEFAULTS.model,
    prompt:
      typeof merged.prompt === "string" && merged.prompt.trim()
        ? merged.prompt.trim()
        : DEFAULTS.prompt,
    fallbackToCurrentModel:
      typeof merged.fallbackToCurrentModel === "boolean"
        ? merged.fallbackToCurrentModel
        : DEFAULTS.fallbackToCurrentModel,
    maxPromptChars: clampPositiveInt(
      merged.maxPromptChars,
      DEFAULTS.maxPromptChars,
    ),
    maxTitleChars: clampPositiveInt(
      merged.maxTitleChars,
      DEFAULTS.maxTitleChars,
    ),
    setSessionName:
      typeof merged.setSessionName === "boolean"
        ? merged.setSessionName
        : DEFAULTS.setSessionName,
    titlePrefix:
      typeof merged.titlePrefix === "string"
        ? merged.titlePrefix
        : DEFAULTS.titlePrefix,
  };
}

function getFallbackTitle(prompt: string, maxTitleChars: number): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  const title = (firstLine ?? "New task").replace(/\s+/g, " ").trim();
  return title.length > maxTitleChars
    ? title.slice(0, maxTitleChars).trim()
    : title;
}

function normalizeTitle(raw: string, maxTitleChars: number): string {
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";

  const withoutPrefix = firstLine.replace(/^title\s*:\s*/i, "");
  const withoutQuotes = withoutPrefix.replace(/^["'`]+|["'`]+$/g, "");
  const collapsed = withoutQuotes.replace(/\s+/g, " ").trim();
  const withoutPunctuation = collapsed.replace(/[.!?]+$/g, "").trim();

  if (!withoutPunctuation) return "";
  return withoutPunctuation.length > maxTitleChars
    ? withoutPunctuation.slice(0, maxTitleChars).trim()
    : withoutPunctuation;
}

function isBadGeneratedTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.includes("need more information")) return true;
  if (normalized.includes("need more context")) return true;
  if (normalized.includes("please provide")) return true;
  if (normalized.includes("cannot generate")) return true;
  if (normalized.includes("can't generate")) return true;
  if (normalized.includes("insufficient information")) return true;
  if (normalized.endsWith("?")) return true;
  return false;
}

function applyFooter(
  ctx: ExtensionContext,
  title: string,
  settings: FooterSettings,
) {
  if (!ctx.hasUI) return;

  const renderLine = (theme: {
    fg: (name: string, text: string) => string;
    bold: (text: string) => string;
  }) => {
    const prompt = theme.fg("dim", "❯");
    return ` ${prompt} ${theme.fg("accent", theme.bold(title))}`;
  };

  ctx.ui.setFooter((_tui, theme) => ({
    render() {
      return [renderLine(theme)];
    },
    invalidate() { },
  }));

  ctx.ui.setTitle(`${settings.titlePrefix}${title}`);
}

function clearFooter(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  ctx.ui.setFooter(() => ({
    render() {
      return [];
    },
    invalidate() { },
  }));
}

function shouldSkipInput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return /^[!/$]/.test(trimmed);
}

function getTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } => {
      return (
        !!item &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string"
      );
    })
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function getLatestUserPrompt(ctx: ExtensionContext): string {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message") continue;
    if (entry.message.role !== "user") continue;
    const text = getTextContent(entry.message.content).trim();
    if (text) return text;
  }
  return "";
}

async function generateTitle(
  ctx: ExtensionContext,
  prompt: string,
  settings: FooterSettings,
  signal: AbortSignal,
): Promise<string | undefined> {
  const configuredModel = settings.model
    ? ctx.modelRegistry.find(settings.model.provider, settings.model.id)
    : undefined;
  const candidates = [
    configuredModel,
    settings.fallbackToCurrentModel ? ctx.model : undefined,
  ].filter(
    (model, index, all): model is NonNullable<typeof model> =>
      Boolean(model) && all.indexOf(model) === index,
  );

  for (const model of candidates) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) continue;

    const message: Message = {
      role: "user",
      content: [
        { type: "text", text: prompt.slice(0, settings.maxPromptChars) },
      ],
      timestamp: Date.now(),
    };

    const result = await complete(
      model,
      {
        systemPrompt: settings.prompt,
        messages: [message],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal,
      },
    );

    if (result.stopReason === "aborted") return undefined;

    const title = normalizeTitle(
      result.content
        .filter(
          (item): item is { type: "text"; text: string } =>
            item.type === "text",
        )
        .map((item) => item.text)
        .join("\n"),
      settings.maxTitleChars,
    );

    if (title && !isBadGeneratedTitle(title)) return title;
  }

  return undefined;
}

export default function footer(pi: ExtensionAPI) {
  let generation = 0;
  let inFlight: AbortController | undefined;
  let claimedTitle: string | undefined;
  let started = false;

  const maybeGenerate = (prompt: string, ctx: ExtensionContext) => {
    const settings = loadSettings(ctx.cwd);
    if (!settings.enabled) return;
    if (started) return;
    if (pi.getSessionName()?.trim()) return;
    if (shouldSkipInput(prompt)) return;

    started = true;
    const fallbackTitle = getFallbackTitle(prompt, settings.maxTitleChars);
    claimedTitle = fallbackTitle;
    applyFooter(ctx, fallbackTitle, settings);
    if (settings.setSessionName) pi.setSessionName(fallbackTitle);

    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    const currentGeneration = ++generation;

    void generateTitle(ctx, prompt, settings, controller.signal)
      .then((title) => {
        if (!title) return;
        if (controller.signal.aborted || currentGeneration !== generation)
          return;
        const currentName = pi.getSessionName()?.trim();
        if (currentName && claimedTitle && currentName !== claimedTitle) return;

        applyFooter(ctx, title, settings);
        if (settings.setSessionName) {
          pi.setSessionName(title);
          claimedTitle = title;
        }
      })
      .catch(() => {
        // Keep the fallback title when background generation fails.
      });
  };

  pi.on("session_start", async (_event, ctx) => {
    const settings = loadSettings(ctx.cwd);
    started = false;
    claimedTitle = undefined;
    if (!settings.enabled) {
      if (ctx.hasUI) ctx.ui.setFooter(undefined);
      return;
    }

    const existingTitle = pi.getSessionName()?.trim();
    if (existingTitle) {
      started = true;
      claimedTitle = existingTitle;
      applyFooter(ctx, existingTitle, settings);
      return;
    }

    clearFooter(ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (typeof event.text === "string") maybeGenerate(event.text, ctx);
    return { action: "continue" as const };
  });

  pi.on("before_agent_start", (event, ctx) => {
    maybeGenerate(event.prompt, ctx);
    return undefined;
  });

  pi.on("agent_end", async (_event, ctx) => {
    const settings = loadSettings(ctx.cwd);
    const currentTitle = pi.getSessionName()?.trim();
    if (settings.enabled && currentTitle) applyFooter(ctx, currentTitle, settings);
  });

  const regenerate = async (args: string, ctx: ExtensionContext) => {
    const settings = loadSettings(ctx.cwd);
    if (!settings.enabled) {
      ctx.ui.notify("footer extension is disabled", "warning");
      return;
    }

    const prompt =
      args.trim() || getLatestUserPrompt(ctx) || ctx.ui.getEditorText().trim();
    if (!prompt) {
      ctx.ui.notify("No prompt available to regenerate footer title", "warning");
      return;
    }

    const fallbackTitle = getFallbackTitle(prompt, settings.maxTitleChars);
    applyFooter(ctx, fallbackTitle, settings);
    if (settings.setSessionName) {
      pi.setSessionName(fallbackTitle);
      claimedTitle = fallbackTitle;
    }

    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    const currentGeneration = ++generation;
    started = true;

    const title = await generateTitle(
      ctx,
      prompt,
      settings,
      controller.signal,
    ).catch(() => undefined);
    if (!title) {
      ctx.ui.notify("Kept fallback footer title", "info");
      return;
    }
    if (controller.signal.aborted || currentGeneration !== generation) return;

    applyFooter(ctx, title, settings);
    if (settings.setSessionName) {
      pi.setSessionName(title);
      claimedTitle = title;
    }
    ctx.ui.notify(`Footer regenerated: ${title}`, "success");
  };

  pi.registerCommand("footer-regenerate", {
    description: "Regenerate the current footer title",
    handler: async (args, ctx) => regenerate(args, ctx),
  });


  pi.on("session_shutdown", async (_event, ctx) => {
    inFlight?.abort();
    inFlight = undefined;
    started = false;
    claimedTitle = undefined;
    if (ctx.hasUI) ctx.ui.setFooter(undefined);
  });
}
