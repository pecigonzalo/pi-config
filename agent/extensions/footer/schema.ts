import { z } from "zod";
import { FOOTER_LAYOUT_NAMES, FOOTER_SECTIONS } from "./constants";

export const footerLayoutNameSchema = z
  .enum(FOOTER_LAYOUT_NAMES)
  .describe("Active footer layout name.");
export const footerSectionSchema = z
  .enum(FOOTER_SECTIONS)
  .describe("Footer section id. `a`-`c` are left-aligned; `x`-`z` are right-aligned.");

export const footerStarshipConfigFileSchema = z.object({
  enabled: z.boolean().describe("Enable or disable the Starship item.").optional().catch(undefined),
  command: z
    .string()
    .trim()
    .min(1)
    .describe("Command used to invoke Starship.")
    .optional()
    .catch(undefined),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .describe("Maximum time to wait for the Starship process in milliseconds.")
    .optional()
    .catch(undefined),
  shell: z
    .string()
    .trim()
    .min(1)
    .describe("Value passed as STARSHIP_SHELL.")
    .optional()
    .catch(undefined),
});

export const footerItemOverrideSchema = z.object({
  enabled: z.boolean().describe("Enable or disable the item for this layout.").optional().catch(undefined),
  row: z.string().describe("Row id where the item should render.").optional().catch(undefined),
  section: footerSectionSchema.describe("Footer section for this item.").optional().catch(undefined),
  order: z.number().int().describe("Sort order within the row section.").optional().catch(undefined),
});

export const footerRowOverrideSchema = z.object({
  order: z.number().int().describe("Row render order; lower numbers render first.").optional().catch(undefined),
  itemSeparator: z
    .string()
    .describe("Separator used between items inside the same section.")
    .optional()
    .catch(undefined),
  sectionSeparator: z
    .string()
    .describe("Separator used between left-side sections and, by default, right-side sections.")
    .optional()
    .catch(undefined),
  rightSectionSeparator: z
    .string()
    .describe("Optional separator used only between right-side sections (`x`, `y`, `z`).")
    .optional()
    .catch(undefined),
});

export const footerLayoutOverrideSchema = z.object({
  items: z
    .record(z.string(), footerItemOverrideSchema.catch({}))
    .describe("Per-item overrides keyed by item id.")
    .optional()
    .catch(undefined),
  rows: z
    .record(z.string(), footerRowOverrideSchema.catch({}))
    .describe("Per-row overrides keyed by row id.")
    .optional()
    .catch(undefined),
});

export const footerStatusFilterConfigFileSchema = z.object({
  keep: z
    .array(z.string().trim().min(1))
    .describe(
      "Optional status-key patterns to render. Supports `*` wildcards. When empty or omitted, all statuses are eligible.",
    )
    .optional()
    .catch(undefined),
  hide: z
    .array(z.string().trim().min(1))
    .describe("Status-key patterns to hide. Supports `*` wildcards and wins over `keep`.")
    .optional()
    .catch(undefined),
});

export const footerLayoutsOverrideSchema = z.object({
  default: footerLayoutOverrideSchema.optional().catch(undefined),
  minimal: footerLayoutOverrideSchema.optional().catch(undefined),
  compact: footerLayoutOverrideSchema.optional().catch(undefined),
  full: footerLayoutOverrideSchema.optional().catch(undefined),
});

export const footerConfigFileSchema = z.object({
  $schema: z.string().describe("Optional JSON Schema reference used by editors.").optional().catch(undefined),
  layout: footerLayoutNameSchema.describe("Active layout when a session starts.").optional().catch(undefined),
  starship: footerStarshipConfigFileSchema.describe("Starship command settings.").optional().catch(undefined),
  statuses: footerStatusFilterConfigFileSchema
    .describe("Filters for extension statuses rendered by the `extension-statuses` item.")
    .optional()
    .catch(undefined),
  layouts: footerLayoutsOverrideSchema.describe("Per-layout row and item overrides.").optional().catch(undefined),
});

export const footerStarshipSettingsSchema = z.object({
  enabled: z.boolean(),
  command: z.string().trim().min(1),
  timeoutMs: z.number().int().positive(),
  shell: z.string().trim().min(1),
});

export const footerStatusFilterSettingsSchema = z.object({
  keep: z.array(z.string().trim().min(1)),
  hide: z.array(z.string().trim().min(1)),
});

export const footerLayoutOverrideResolvedSchema = z.object({
  items: z.record(z.string(), footerItemOverrideSchema),
  rows: z.record(z.string(), footerRowOverrideSchema),
});

export const footerConfigSchema = z.object({
  layout: footerLayoutNameSchema,
  starship: footerStarshipSettingsSchema,
  statuses: footerStatusFilterSettingsSchema,
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
export type FooterStatusFilterSettings = z.infer<typeof footerStatusFilterSettingsSchema>;
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
  statuses: {
    keep: [],
    hide: [],
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
