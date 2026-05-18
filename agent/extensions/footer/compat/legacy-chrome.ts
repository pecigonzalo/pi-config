import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface LegacyFooterData {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  onBranchChange(callback: () => void): () => void;
}

function renderLegacyFooterLine(width: number, left: string, right: string): string {
  if (width <= 0) return "";
  if (!left && !right) return "";

  if (!right) return truncateToWidth(left, width);
  if (!left) return truncateToWidth(right, width);

  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width);

  const maxLeftWidth = Math.max(0, width - rightWidth - 1);
  const fittedLeft = truncateToWidth(left, maxLeftWidth);
  const gapWidth = Math.max(1, width - visibleWidth(fittedLeft) - rightWidth);
  return truncateToWidth(`${fittedLeft}${" ".repeat(gapWidth)}${right}`, width);
}

function hideLegacyFooter(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  ctx.ui.setFooter((tui, theme, footerData: LegacyFooterData) => ({
    render(width: number) {
      const branch = footerData.getGitBranch();
      const statuses = [...footerData.getExtensionStatuses().values()].filter(Boolean);
      const left = branch ? theme.fg("dim", branch) : "";
      const right = statuses.join(theme.fg("dim", " · "));
      const line = renderLegacyFooterLine(width, left, right);
      return line ? [line] : [];
    },
    invalidate() {},
    dispose: footerData.onBranchChange(() => tui.requestRender()),
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
          if (width <= 0) return [];
          if (width === 1) return [" "];

          const contentWidth = Math.max(0, width - 2);
          const renderWidth = Math.max(1, contentWidth);
          return originalRender(renderWidth).map((line) => {
            const truncated = truncateToWidth(line, contentWidth);
            const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)));
            return ` ${truncated}${padding} `;
          });
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
