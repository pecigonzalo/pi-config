import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createSessionContextPart, parseContextPreset, sessionContextPresets } from "./session-context";
import { createSessionTitlePart } from "./session-title";

export default function footer(pi: ExtensionAPI) {
  const sessionContext = createSessionContextPart(pi);
  const sessionTitle = createSessionTitlePart(pi);

  const hideLegacyFooter = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    // Override built-in/legacy footer rendering while this extension is active.
    ctx.ui.setFooter(() => ({
      render() {
        return [];
      },
      invalidate() {},
    }));
  };

  const installFooterWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    hideLegacyFooter(ctx);
    ctx.ui.setWidget("starship", undefined);

    ctx.ui.setWidget(
      "footer",
      (tui) => {
        const requestRender = () => tui.requestRender();
        sessionContext.setRequestRender(requestRender);
        sessionTitle.setRequestRender(requestRender);

        return {
          render(width: number): string[] {
            return [sessionContext.buildLine(ctx, width), sessionTitle.buildLine(ctx.ui.theme, width)];
          },
          invalidate() {},
        };
      },
      { placement: "belowEditor" },
    );

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new CustomEditor(tui, theme, keybindings);
      const originalRender = editor.render.bind(editor);

      editor.render = (width: number): string[] => {
        const contentWidth = Math.max(1, width - 2);
        return originalRender(contentWidth).map((line) => ` ${line.padEnd(contentWidth)} `);
      };

      return editor;
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    installFooterWidget(ctx);
    sessionContext.onSessionStart();
    sessionTitle.onSessionStart(ctx);
  });

  pi.on("tool_result", async (event) => {
    sessionContext.onToolResult(event as { toolName: string; input?: unknown });
  });

  pi.on("turn_start", async (_event, ctx) => {
    hideLegacyFooter(ctx);
    sessionContext.onTurnStart();
  });

  pi.on("turn_end", async () => {
    sessionContext.onTurnEnd();
  });

  pi.on("model_select", async () => {
    sessionContext.onModelSelect();
  });

  pi.on("input", async (event, ctx) => sessionTitle.onInput(event as { text?: unknown }, ctx));

  pi.on("before_agent_start", (event, ctx) => {
    sessionTitle.onBeforeAgentStart(event as { prompt: string }, ctx);
    return undefined;
  });

  pi.on("agent_end", async (_event, ctx) => {
    hideLegacyFooter(ctx);
    sessionTitle.onAgentEnd(ctx);
  });

  pi.registerCommand("widgets", {
    description: "Switch footer context preset: default / minimal / compact / full",
    getArgumentCompletions: () => sessionContextPresets.map((preset) => ({ value: preset, label: preset })),
    handler: async (args, ctx) => {
      const preset = parseContextPreset(args ?? "");
      if (!preset) {
        const current = sessionContext.getPreset();
        const requested = (args ?? "").trim();
        if (!requested) {
          ctx.ui.notify(`Preset: ${current}  (options: ${sessionContextPresets.join(" · ")})`, "info");
        } else {
          ctx.ui.notify(`Unknown preset \"${requested}\". Options: ${sessionContextPresets.join(" · ")}`, "warning");
        }
        return;
      }

      sessionContext.setPreset(preset);
      ctx.ui.notify(`Footer context → ${preset}`, "info");
    },
  });

  pi.registerCommand("footer-regenerate", {
    description: "Regenerate the current footer title",
    handler: async (args, ctx) => sessionTitle.onRegenerateCommand(args, ctx),
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    sessionContext.onSessionShutdown();
    sessionTitle.onSessionShutdown(ctx);
    if (ctx.hasUI) {
      ctx.ui.setFooter(undefined);
      ctx.ui.setWidget("starship", undefined);
      ctx.ui.setWidget("footer", undefined);
    }
  });
}
