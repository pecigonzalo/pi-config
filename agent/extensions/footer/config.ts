import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { FOOTER_LAYOUT_NAMES } from "./constants";
import type { FooterLayoutDefinition, FooterLayoutName, FooterPlacement, FooterRowDefinition } from "./core/types";
import {
  DEFAULT_FOOTER_CONFIG,
  footerConfigFileSchema,
  footerConfigSchema,
  type FooterConfig,
  type FooterConfigFile,
  type FooterItemOverride,
  type FooterLayoutOverride,
  type FooterLayoutOverrideFile,
  type FooterRowOverride,
  type FooterStarshipSettings,
} from "./schema";

export type {
  FooterConfig,
  FooterConfigFile,
  FooterItemOverride,
  FooterLayoutOverride,
  FooterRowOverride,
  FooterStarshipSettings,
} from "./schema";

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
    return footerConfigFileSchema.parse(parsed);
  } catch {
    return {};
  }
}

function mergeItemOverride(
  base: FooterItemOverride | undefined,
  override: FooterItemOverride | undefined,
): FooterItemOverride | undefined {
  if (!base && !override) return undefined;

  return {
    enabled: override?.enabled ?? base?.enabled,
    row: override?.row ?? base?.row,
    section: override?.section ?? base?.section,
    order: override?.order ?? base?.order,
  };
}

function mergeRowOverride(
  base: FooterRowOverride | undefined,
  override: FooterRowOverride | undefined,
): FooterRowOverride | undefined {
  if (!base && !override) return undefined;

  return {
    order: override?.order ?? base?.order,
    itemSeparator: override?.itemSeparator ?? base?.itemSeparator,
    sectionSeparator: override?.sectionSeparator ?? base?.sectionSeparator,
    rightSectionSeparator: override?.rightSectionSeparator ?? base?.rightSectionSeparator,
  };
}

function mergeLayoutOverride(
  base: FooterLayoutOverride | undefined,
  override: FooterLayoutOverrideFile | undefined,
): FooterLayoutOverride | undefined {
  if (!base && !override) return undefined;

  const items: Record<string, FooterItemOverride> = { ...(base?.items ?? {}) };
  for (const [itemId, itemOverride] of Object.entries(override?.items ?? {})) {
    items[itemId] = mergeItemOverride(items[itemId], itemOverride) ?? {};
  }

  const rows: Record<string, FooterRowOverride> = { ...(base?.rows ?? {}) };
  for (const [rowId, rowOverride] of Object.entries(override?.rows ?? {})) {
    rows[rowId] = mergeRowOverride(rows[rowId], rowOverride) ?? {};
  }

  return {
    items,
    rows,
  };
}

function mergeLayouts(base: FooterConfig["layouts"], override: FooterConfigFile["layouts"] | undefined): FooterConfig["layouts"] {
  const layouts: FooterConfig["layouts"] = {};

  for (const layoutName of FOOTER_LAYOUT_NAMES) {
    const nextLayout = mergeLayoutOverride(base[layoutName], override?.[layoutName]);
    if (nextLayout) layouts[layoutName] = nextLayout;
  }

  return layouts;
}

function mergeFooterConfig(base: FooterConfig, override: FooterConfigFile): FooterConfig {
  return footerConfigSchema.parse({
    layout: override.layout ?? base.layout,
    starship: {
      enabled: override.starship?.enabled ?? base.starship.enabled,
      command: override.starship?.command ?? base.starship.command,
      timeoutMs: override.starship?.timeoutMs ?? base.starship.timeoutMs,
      shell: override.starship?.shell ?? base.starship.shell,
    },
    layouts: mergeLayouts(base.layouts, override.layouts),
  });
}

export function loadFooterConfig(cwd: string): FooterConfig {
  const extensionConfig = mergeFooterConfig(
    DEFAULT_FOOTER_CONFIG,
    readJsonFile(path.join(getAgentDir(), "extensions", "footer", "footer.jsonc")),
  );
  const globalConfig = mergeFooterConfig(extensionConfig, readJsonFile(path.join(getAgentDir(), "footer.jsonc")));
  return mergeFooterConfig(globalConfig, readJsonFile(path.join(cwd, ".pi", "footer.jsonc")));
}

export class FooterConfigController {
  private config: FooterConfig = DEFAULT_FOOTER_CONFIG;

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
          itemSeparator: rowOverride?.itemSeparator ?? row.itemSeparator,
          sectionSeparator: rowOverride?.sectionSeparator ?? row.sectionSeparator,
          rightSectionSeparator: rowOverride?.rightSectionSeparator ?? row.rightSectionSeparator,
        });
      }

      for (const [rowId, rowOverride] of Object.entries(override.rows)) {
        if (rowsById.has(rowId)) continue;
        rowsById.set(rowId, {
          id: rowId,
          order: rowOverride.order,
          itemSeparator: rowOverride.itemSeparator ?? " ",
          sectionSeparator: rowOverride.sectionSeparator ?? " ",
          rightSectionSeparator: rowOverride.rightSectionSeparator,
        });
      }

      return {
        name: layout.name,
        rows: [...rowsById.values()],
      };
    });
  }
}
