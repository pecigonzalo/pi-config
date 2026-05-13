import type { FooterLayoutDefinition, FooterLayoutName } from "./core/types";

const layoutsByName: Record<FooterLayoutName, FooterLayoutDefinition> = {
  default: {
    name: "default",
    rows: [
      {
        id: "context",
        order: 10,
        componentSeparator: " ❯ ",
        sectionSeparator: " ❯ ",
      },
    ],
  },
  minimal: {
    name: "minimal",
    rows: [
      {
        id: "context",
        order: 10,
        componentSeparator: " · ",
        sectionSeparator: " · ",
      },
    ],
  },
  compact: {
    name: "compact",
    rows: [
      {
        id: "context",
        order: 10,
        componentSeparator: " ❯ ",
        sectionSeparator: " ❯ ",
      },
    ],
  },
  full: {
    name: "full",
    rows: [
      {
        id: "context",
        order: 10,
        componentSeparator: " ❯ ",
        sectionSeparator: " ❯ ",
      },
    ],
  },
};

export const footerLayoutNames: FooterLayoutName[] = ["default", "minimal", "compact", "full"];
export const footerLayouts: FooterLayoutDefinition[] = footerLayoutNames.map((name) => layoutsByName[name]);
