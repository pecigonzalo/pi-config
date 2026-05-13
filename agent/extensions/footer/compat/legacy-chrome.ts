import { CustomEditor, type ExtensionContext } from "@mariozechner/pi-coding-agent";

function hideLegacyFooter(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  ctx.ui.setFooter(() => ({
    render() {
      return [];
    },
    invalidate() {},
  }));
}

export interface LegacyChromeController {
  install(ctx: ExtensionContext): void;
  refresh(ctx: ExtensionContext): void;
  uninstall(ctx: ExtensionContext): void;
}

export function createLegacyChromeController(): LegacyChromeController {
  let previousEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]> | undefined;
  let installed = false;

  return {
    install(ctx) {
      if (!ctx.hasUI) return;

      hideLegacyFooter(ctx);
      ctx.ui.setWidget("starship", undefined);

      if (installed) return;

      previousEditorFactory = ctx.ui.getEditorComponent();
      ctx.ui.setEditorComponent((tui, theme, keybindings) => {
        const editor = previousEditorFactory
          ? previousEditorFactory(tui, theme, keybindings)
          : new CustomEditor(tui, theme, keybindings);
        const originalRender = editor.render.bind(editor);

        editor.render = (width: number): string[] => {
          const contentWidth = Math.max(1, width - 2);
          return originalRender(contentWidth).map((line) => ` ${line.padEnd(contentWidth)} `);
        };

        return editor;
      });

      installed = true;
    },

    refresh(ctx) {
      if (!ctx.hasUI) return;
      hideLegacyFooter(ctx);
    },

    uninstall(ctx) {
      if (!ctx.hasUI) return;

      ctx.ui.setFooter(undefined);
      ctx.ui.setEditorComponent(previousEditorFactory);

      previousEditorFactory = undefined;
      installed = false;
    },
  };
}
