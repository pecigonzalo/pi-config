# footer

The footer extension is now a small footer manager. It owns the footer
surface, composes lualine-style sections, exposes a registration API for
other extensions, and can use the Starship CLI for the left side.

## Overview

- Rows are split into sections: `a`, `b`, `c`, `x`, `y`, `z`
- Built-in layouts: `default`, `minimal`, `compact`, `full`
- Built-in items: `starship`, `path`, `git`, `agent`, `model`, `thinking`,
  `context`, `tokens`, `token_in`, `token_out`, `cost`, `time_spent`
- Config lives in `~/.pi/agent/footer.jsonc` or `<project>/.pi/footer.jsonc`

## Registering a custom footer item

From another extension in `~/.pi/agent/extensions/`:

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  invalidateFooterItem,
  registerFooterItem,
  unregisterFooterItem,
} from "./footer/core/api"; // adjust the relative path if your extension lives in its own folder

export default function example(pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    registerFooterItem(pi, {
      owner: "example",
      id: "mode",
      getPlacement(layoutName) {
        return layoutName === "minimal"
          ? { row: "context", section: "x", order: 50 }
          : { row: "context", section: "z", order: 50 };
      },
      render: ({ theme }) => theme.fg("accent", "demo"),
      onToolResult() {
        invalidateFooterItem(pi, "example", "mode");
      },
    });
  });

  pi.on("session_shutdown", async () => {
    unregisterFooterItem(pi, "example", "mode");
  });
}
```

A working example lives in:

- `agent/extensions/footer/examples/custom-row-example.ts`

The public helper API is:

- `registerFooterItem(...)`
- `unregisterFooterItem(...)`
- `invalidateFooterItem(...)`
- `activateFooterLayout(...)`

## Configuration

Example:

```jsonc
{
  "layout": "default",
  "starship": {
    "enabled": true,
    "command": "starship",
    "timeoutMs": 3000,
    "shell": "bash"
  },
  "layouts": {
    "minimal": {
      "items": {
        "tokens": { "enabled": false },
        "cost": { "enabled": false }
      }
    },
    "full": {
      "rows": {
        "context": {
          "componentSeparator": " · ",
          "sectionSeparator": " ❯ "
        }
      },
      "items": {
        "time_spent": { "section": "y", "order": 30 }
      }
    }
  }
}
```

### Layout override fields

- `layout`: active layout on session start
- `starship.enabled`: enable or disable the Starship item
- `starship.command`: command to execute
- `starship.timeoutMs`: subprocess timeout
- `starship.shell`: value passed as `STARSHIP_SHELL`
- `layouts.<name>.rows.<rowId>`: override row separators and order, or add a
  new custom row
- `layouts.<name>.items.<itemId>`: override `enabled`, `row`, `section`,
  `order`

## Custom rows

A footer item can target any row id, not just `context`. For a custom row to
render, define it in the active layout config.

Example:

```jsonc
{
  "layouts": {
    "default": {
      "rows": {
        "extra": {
          "order": 20,
          "componentSeparator": " · ",
          "sectionSeparator": " · "
        }
      }
    }
  }
}
```

Then place a custom item on `row: "extra"`.

## Commands

- `/widgets`: print or change the active layout for the current session

## Starship behavior

When Starship is enabled, the `starship` item renders the left side by
calling `starship prompt`. Once Starship output is available, built-in `path`
and `git` items are suppressed for that layout.

If Starship is missing or fails, the footer falls back to the built-in
`path` and `git` items.

## Built-in item IDs

- `starship`
- `path`
- `git`
- `agent`
- `model`
- `thinking`
- `context`
- `tokens`
- `token_in`
- `token_out`
- `cost`
- `time_spent`

## See also

- `agent/extensions/footer/core/api.ts`
- `agent/extensions/footer/config.ts`
- `agent/footer.jsonc`
