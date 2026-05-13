import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createSessionContextItems } from "./builtins/context-items";
import { createStarshipItems } from "./builtins/starship-item";
import { createLegacyChromeController } from "./compat/legacy-chrome";
import { FooterConfigController } from "./config";
import { FooterManager } from "./core/manager";
import { footerLayoutNames, footerLayouts } from "./layouts";
import {
  createSessionContextController,
  parseContextPreset,
} from "./session-context";
import { createStarshipController } from "./starship";

export default function footer(pi: ExtensionAPI) {
  const config = new FooterConfigController();
  const footerManager = new FooterManager(pi, createLegacyChromeController());
  footerManager.setLayouts(footerLayouts);

  const sessionContext = createSessionContextController(pi);
  const starship = createStarshipController(config);

  sessionContext.setRequestRender(() => footerManager.invalidate("footer"));
  starship.setRequestRender(() => footerManager.invalidate("footer"));

  for (const item of createStarshipItems(starship, config))
    footerManager.registerItem(item);
  for (const item of createSessionContextItems(
    sessionContext,
    config,
    starship,
  ))
    footerManager.registerItem(item);

  pi.on("session_start", async (_event, ctx) => {
    config.onSessionStart(ctx);
    footerManager.setLayouts(config.getResolvedLayouts(footerLayouts));
    footerManager.activateLayout(config.getActiveLayoutName());
    footerManager.onSessionStart(ctx);
  });

  pi.on("tool_result", async (event) => {
    footerManager.onToolResult(event as { toolName: string; input?: unknown });
  });

  pi.on("turn_start", async (_event, ctx) => {
    footerManager.onTurnStart(ctx);
  });

  pi.on("turn_end", async () => {
    footerManager.onTurnEnd();
  });

  pi.on("model_select", async () => {
    footerManager.onModelSelect();
  });

  pi.on("thinking_level_select", async (event) => {
    footerManager.onThinkingLevelSelect(
      event as { level: string; previousLevel?: string },
    );
  });

  pi.registerCommand("footer", {
    description:
      "Switch footer layout preset: default / minimal / compact / full",
    getArgumentCompletions: () =>
      footerLayoutNames.map((preset) => ({ value: preset, label: preset })),
    handler: async (args, ctx) => {
      const preset = parseContextPreset(args ?? "");
      if (!preset) {
        const current = footerManager.getActiveLayoutName();
        const requested = (args ?? "").trim();
        if (!requested) {
          ctx.ui.notify(
            `Preset: ${current}  (options: ${footerLayoutNames.join(" · ")})`,
            "info",
          );
        } else {
          ctx.ui.notify(
            `Unknown preset \"${requested}\". Options: ${footerLayoutNames.join(" · ")}`,
            "warning",
          );
        }
        return;
      }

      footerManager.activateLayout(preset);
      ctx.ui.notify(`Footer layout → ${preset}`, "info");
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    footerManager.onSessionShutdown(ctx);
  });
}
