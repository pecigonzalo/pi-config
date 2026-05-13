import { z } from "zod";
import { FOOTER_LAYOUT_NAMES, FOOTER_SECTIONS } from "./constants";

export const footerLayoutNameSchema = z
  .enum(FOOTER_LAYOUT_NAMES)
  .describe("Active footer layout name.");
export const footerSectionSchema = z
  .enum(FOOTER_SECTIONS)
  .describe("Footer section id. `a`-`c` are left-aligned; `x`-`z` are right-aligned.");

export const footerStarshipConfigFileSchema = z.object({
  enabled: z.boolean().describe("Enable or disable the Starship item.").catch(undefined).optional(),
  command: z
    .string()
    .trim()
    .min(1)
    .describe("Command used to invoke Starship.")
    .catch(undefined)
    .optional(),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .describe("Maximum time to wait for the Starship process in milliseconds.")
    .catch(undefined)
    .optional(),
  shell: z
    .string()
    .trim()
    .min(1)
    .describe("Value passed as STARSHIP_SHELL.")
    .catch(undefined)
    .optional(),
});

export const footerItemOverrideSchema = z.object({
  enabled: z.boolean().describe("Enable or disable the item for this layout.").catch(undefined).optional(),
  row: z.string().describe("Row id where the item should render.").catch(undefined).optional(),
  section: footerSectionSchema.describe("Footer section for this item.").catch(undefined).optional(),
  order: z.number().int().describe("Sort order within the row section.").catch(undefined).optional(),
});

export const footerRowOverrideSchema = z.object({
  order: z.number().int().describe("Row render order; lower numbers render first.").catch(undefined).optional(),
  componentSeparator: z
    .string()
    .describe("Separator used between items inside the same section.")
    .catch(undefined)
    .optional(),
  sectionSeparator: z
    .string()
    .describe("Separator used between left-side sections and, by default, right-side sections.")
    .catch(undefined)
    .optional(),
  rightSectionSeparator: z
    .string()
    .describe("Optional separator used only between right-side sections (`x`, `y`, `z`).")
    .catch(undefined)
    .optional(),
});

export const footerLayoutOverrideSchema = z.object({
  items: z
    .record(z.string(), footerItemOverrideSchema.catch({}))
    .describe("Per-item overrides keyed by item id.")
    .catch(undefined)
    .optional(),
  rows: z
    .record(z.string(), footerRowOverrideSchema.catch({}))
    .describe("Per-row overrides keyed by row id.")
    .catch(undefined)
    .optional(),
});

export const footerLayoutsOverrideSchema = z.object({
  default: footerLayoutOverrideSchema.catch(undefined).optional(),
  minimal: footerLayoutOverrideSchema.catch(undefined).optional(),
  compact: footerLayoutOverrideSchema.catch(undefined).optional(),
  full: footerLayoutOverrideSchema.catch(undefined).optional(),
});

export const footerConfigFileSchema = z.object({
  $schema: z.string().describe("Optional JSON Schema reference used by editors.").catch(undefined).optional(),
  layout: footerLayoutNameSchema.describe("Active layout when a session starts.").catch(undefined).optional(),
  starship: footerStarshipConfigFileSchema.describe("Starship command settings.").catch(undefined).optional(),
  layouts: footerLayoutsOverrideSchema.describe("Per-layout row and item overrides.").catch(undefined).optional(),
});

export const footerStarshipSettingsSchema = z.object({
  enabled: z.boolean(),
  command: z.string().trim().min(1),
  timeoutMs: z.number().int().positive(),
  shell: z.string().trim().min(1),
});

export const footerLayoutOverrideResolvedSchema = z.object({
  items: z.record(z.string(), footerItemOverrideSchema),
  rows: z.record(z.string(), footerRowOverrideSchema),
});

export const footerConfigSchema = z.object({
  layout: footerLayoutNameSchema,
  starship: footerStarshipSettingsSchema,
  layouts: z.object({
    default: footerLayoutOverrideResolvedSchema.optional(),
    minimal: footerLayoutOverrideResolvedSchema.optional(),
    compact: footerLayoutOverrideResolvedSchema.optional(),
    full: footerLayoutOverrideResolvedSchema.optional(),
  }),
});

export type FooterConfigFile = z.infer<typeof footerConfigFileSchema>;
export type FooterLayoutsOverrideFile = z.infer<typeof footerLayoutsOverrideSchema>;
export type FooterLayoutOverrideFile = z.infer<typeof footerLayoutOverrideSchema>;
export type FooterStarshipSettings = z.infer<typeof footerStarshipSettingsSchema>;
export type FooterItemOverride = z.infer<typeof footerItemOverrideSchema>;
export type FooterRowOverride = z.infer<typeof footerRowOverrideSchema>;
export type FooterLayoutOverride = z.infer<typeof footerLayoutOverrideResolvedSchema>;
export type FooterConfig = z.infer<typeof footerConfigSchema>;

export const DEFAULT_FOOTER_CONFIG: FooterConfig = footerConfigSchema.parse({
  layout: "default",
  starship: {
    enabled: true,
    command: "starship",
    timeoutMs: 3_000,
    shell: "bash",
  },
  layouts: {},
});

export function createFooterJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(footerConfigFileSchema, { reused: "ref" }),
    $id: "https://pi.local/schemas/footer.schema.json",
    title: "Pi footer configuration",
    description: "Configuration for the footer extension.",
  };
}
