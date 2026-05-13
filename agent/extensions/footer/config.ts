import { getAgentDir, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  FooterLayoutDefinition,
  FooterLayoutName,
  FooterPlacement,
  FooterRowDefinition,
  FooterSection,
} from "./core/types";

interface FooterStarshipConfigFile {
  enabled?: boolean;
  command?: string;
  timeoutMs?: number;
  shell?: string;
}

interface FooterItemOverrideFile {
  enabled?: boolean;
  row?: string;
  section?: FooterSection;
  order?: number;
}

interface FooterRowOverrideFile {
  order?: number;
  componentSeparator?: string;
  sectionSeparator?: string;
}

interface FooterLayoutOverrideFile {
  items?: Record<string, FooterItemOverrideFile>;
  rows?: Record<string, FooterRowOverrideFile>;
}

interface FooterConfigFile {
  layout?: FooterLayoutName;
  starship?: FooterStarshipConfigFile;
  layouts?: Partial<Record<FooterLayoutName, FooterLayoutOverrideFile>>;
}

export interface FooterStarshipSettings {
  enabled: boolean;
  command: string;
  timeoutMs: number;
  shell: string;
}

export interface FooterItemOverride {
  enabled?: boolean;
  row?: string;
  section?: FooterSection;
  order?: number;
}

export interface FooterRowOverride {
  order?: number;
  componentSeparator?: string;
  sectionSeparator?: string;
}

export interface FooterLayoutOverride {
  items: Record<string, FooterItemOverride>;
  rows: Record<string, FooterRowOverride>;
}

export interface FooterConfig {
  layout: FooterLayoutName;
  starship: FooterStarshipSettings;
  layouts: Partial<Record<FooterLayoutName, FooterLayoutOverride>>;
}

const defaultFooterConfig: FooterConfig = {
  layout: "default",
  starship: {
    enabled: true,
    command: "starship",
    timeoutMs: 3_000,
    shell: "bash",
  },
  layouts: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonc(text: string): unknown {
  let noComments = "";
  let inString = false;
  let stringQuote = "";
  let escaping = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (inString) {
      noComments += char;
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === stringQuote) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringQuote = char;
      noComments += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      if (index < text.length) noComments += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length - 1 && !(text[index] === "*" && text[index + 1] === "/")) index++;
      index++;
      continue;
    }

    noComments += char;
  }

  let cleaned = "";
  inString = false;
  stringQuote = "";
  escaping = false;

  for (let index = 0; index < noComments.length; index++) {
    const char = noComments[index] ?? "";

    if (inString) {
      cleaned += char;
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === stringQuote) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringQuote = char;
      cleaned += char;
      continue;
    }

    if (char === ",") {
      let offset = index + 1;
      while (offset < noComments.length && /\s/.test(noComments[offset] ?? "")) offset++;
      if (offset < noComments.length && (noComments[offset] === "}" || noComments[offset] === "]")) {
        continue;
      }
    }

    cleaned += char;
  }

  return JSON.parse(cleaned);
}

function readJsonFile(filePath: string): FooterConfigFile {
  try {
    const parsed = parseJsonc(fs.readFileSync(filePath, "utf-8"));
    return isRecord(parsed) ? (parsed as FooterConfigFile) : {};
  } catch {
    return {};
  }
}

function clampPositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function parseLayoutName(value: unknown, fallback: FooterLayoutName): FooterLayoutName {
  return value === "default" || value === "minimal" || value === "compact" || value === "full" ? value : fallback;
}

function parseFooterSection(value: unknown, fallback?: FooterSection): FooterSection | undefined {
  return value === "a" || value === "b" || value === "c" || value === "x" || value === "y" || value === "z"
    ? value
    : fallback;
}

function parseRowOverride(value: unknown, fallback: FooterRowOverride = {}): FooterRowOverride {
  if (!isRecord(value)) return fallback;

  return {
    order: typeof value.order === "number" ? value.order : fallback.order,
    componentSeparator:
      typeof value.componentSeparator === "string" ? value.componentSeparator : fallback.componentSeparator,
    sectionSeparator: typeof value.sectionSeparator === "string" ? value.sectionSeparator : fallback.sectionSeparator,
  };
}

function parseItemOverride(value: unknown, fallback: FooterItemOverride = {}): FooterItemOverride {
  if (!isRecord(value)) return fallback;

  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : fallback.enabled,
    row: typeof value.row === "string" ? value.row : fallback.row,
    section: parseFooterSection(value.section, fallback.section),
    order: typeof value.order === "number" ? value.order : fallback.order,
  };
}

function parseLayoutOverrides(
  value: unknown,
  fallback: Partial<Record<FooterLayoutName, FooterLayoutOverride>> = {},
): Partial<Record<FooterLayoutName, FooterLayoutOverride>> {
  const result: Partial<Record<FooterLayoutName, FooterLayoutOverride>> = { ...fallback };
  if (!isRecord(value)) return result;

  for (const layoutName of ["default", "minimal", "compact", "full"] as const) {
    const override = value[layoutName];
    if (!isRecord(override)) continue;

    const nextRows: Record<string, FooterRowOverride> = { ...(fallback[layoutName]?.rows ?? {}) };
    if (isRecord(override.rows)) {
      for (const [rowId, rowValue] of Object.entries(override.rows)) {
        nextRows[rowId] = parseRowOverride(rowValue, nextRows[rowId]);
      }
    }

    const nextItems: Record<string, FooterItemOverride> = { ...(fallback[layoutName]?.items ?? {}) };
    if (isRecord(override.items)) {
      for (const [itemId, itemValue] of Object.entries(override.items)) {
        nextItems[itemId] = parseItemOverride(itemValue, nextItems[itemId]);
      }
    }

    result[layoutName] = {
      rows: nextRows,
      items: nextItems,
    };
  }

  return result;
}

function parseFooterConfig(raw: FooterConfigFile, fallback: FooterConfig = defaultFooterConfig): FooterConfig {
  const starship = isRecord(raw.starship) ? raw.starship : {};

  return {
    layout: parseLayoutName(raw.layout, fallback.layout),
    starship: {
      enabled: typeof starship.enabled === "boolean" ? starship.enabled : fallback.starship.enabled,
      command:
        typeof starship.command === "string" && starship.command.trim()
          ? starship.command.trim()
          : fallback.starship.command,
      timeoutMs: clampPositiveInt(starship.timeoutMs, fallback.starship.timeoutMs),
      shell:
        typeof starship.shell === "string" && starship.shell.trim() ? starship.shell.trim() : fallback.starship.shell,
    },
    layouts: parseLayoutOverrides(raw.layouts, fallback.layouts),
  };
}

export function loadFooterConfig(cwd: string): FooterConfig {
  const globalConfig = parseFooterConfig(readJsonFile(path.join(getAgentDir(), "footer.jsonc")), defaultFooterConfig);
  return parseFooterConfig(readJsonFile(path.join(cwd, ".pi", "footer.jsonc")), globalConfig);
}

export class FooterConfigController {
  private config: FooterConfig = defaultFooterConfig;

  onSessionStart(ctx: ExtensionContext): void {
    this.config = loadFooterConfig(ctx.cwd);
  }

  getActiveLayoutName(): FooterLayoutName {
    return this.config.layout;
  }

  getStarshipSettings(): FooterStarshipSettings {
    return this.config.starship;
  }

  resolvePlacement(
    itemId: string,
    layoutName: FooterLayoutName,
    fallback: FooterPlacement | undefined,
  ): FooterPlacement | undefined {
    const override = this.config.layouts[layoutName]?.items[itemId];
    if (override?.enabled === false) return undefined;
    if (!override) return fallback;

    const row = override.row ?? fallback?.row;
    const section = override.section ?? fallback?.section;
    const order = override.order ?? fallback?.order;

    return row && section ? { row, section, order } : fallback;
  }

  getResolvedLayouts(baseLayouts: FooterLayoutDefinition[]): FooterLayoutDefinition[] {
    return baseLayouts.map((layout) => {
      const override = this.config.layouts[layout.name];
      if (!override) return layout;

      const rowsById = new Map<string, FooterRowDefinition>();
      for (const row of layout.rows) {
        const rowOverride = override.rows[row.id];
        rowsById.set(row.id, {
          id: row.id,
          order: rowOverride?.order ?? row.order,
          componentSeparator: rowOverride?.componentSeparator ?? row.componentSeparator,
          sectionSeparator: rowOverride?.sectionSeparator ?? row.sectionSeparator,
        });
      }

      for (const [rowId, rowOverride] of Object.entries(override.rows)) {
        if (rowsById.has(rowId)) continue;
        rowsById.set(rowId, {
          id: rowId,
          order: rowOverride.order,
          componentSeparator: rowOverride.componentSeparator ?? " ",
          sectionSeparator: rowOverride.sectionSeparator ?? " ",
        });
      }

      return {
        name: layout.name,
        rows: [...rowsById.values()],
      };
    });
  }
}
