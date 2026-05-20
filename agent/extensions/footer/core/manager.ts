import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderFooterLines } from "./layout";
import type {
  FooterActivateLayoutEventPayload,
  FooterInvalidateEventPayload,
  FooterItem,
  FooterLayoutDefinition,
  FooterLayoutName,
  FooterRegisterEventPayload,
  FooterTheme,
  FooterThinkingLevelEvent,
  FooterToolResultEvent,
  FooterUnregisterEventPayload,
} from "./types";
import {
  FOOTER_ACTIVATE_LAYOUT_EVENT,
  FOOTER_INVALIDATE_EVENT,
  FOOTER_REGISTER_EVENT,
  FOOTER_UNREGISTER_EVENT,
} from "./types";

function getItemKey(owner: string, id: string): string {
  return `${owner}:${id}`;
}

export class FooterManager {
  private readonly items = new Map<string, FooterItem>();
  private readonly layouts = new Map<FooterLayoutName, FooterLayoutDefinition>();
  private activeLayoutName: FooterLayoutName = "default";
  private currentCtx: ExtensionContext | undefined;
  private requestRender: (() => void) | undefined;

  constructor(private readonly pi: ExtensionAPI) {
    this.pi.events.on(FOOTER_REGISTER_EVENT, (payload) => {
      const { item } = payload as FooterRegisterEventPayload;
      this.registerItem(item);
    });

    this.pi.events.on(FOOTER_UNREGISTER_EVENT, (payload) => {
      const { owner, id } = payload as FooterUnregisterEventPayload;
      this.unregisterItem(owner, id);
    });

    this.pi.events.on(FOOTER_INVALIDATE_EVENT, (payload) => {
      const { owner, id } = (payload ?? {}) as FooterInvalidateEventPayload;
      this.invalidate(owner, id);
    });

    this.pi.events.on(FOOTER_ACTIVATE_LAYOUT_EVENT, (payload) => {
      const { layoutName } = payload as FooterActivateLayoutEventPayload;
      this.activateLayout(layoutName);
    });
  }

  setLayouts(layouts: FooterLayoutDefinition[]): void {
    this.layouts.clear();
    for (const layout of layouts) {
      this.layouts.set(layout.name, layout);
    }

    if (!this.layouts.has(this.activeLayoutName) && layouts[0]) {
      this.activeLayoutName = layouts[0].name;
    }

    this.requestRender?.();
  }

  getActiveLayoutName(): FooterLayoutName {
    return this.activeLayoutName;
  }

  activateLayout(layoutName: FooterLayoutName): boolean {
    if (!this.layouts.has(layoutName)) return false;
    this.activeLayoutName = layoutName;
    this.requestRender?.();
    return true;
  }

  registerItem(item: FooterItem): void {
    this.items.set(getItemKey(item.owner, item.id), item);
    if (this.currentCtx) item.onSessionStart?.(this.currentCtx);
    this.requestRender?.();
  }

  unregisterItem(owner: string, id?: string): void {
    const keys = id ? [getItemKey(owner, id)] : [...this.items.keys()].filter((key) => key.startsWith(`${owner}:`));
    for (const key of keys) {
      const item = this.items.get(key);
      if (item && this.currentCtx) item.onSessionShutdown?.(this.currentCtx);
      this.items.delete(key);
    }
    this.requestRender?.();
  }

  invalidate(owner?: string, id?: string): void {
    for (const item of this.items.values()) {
      if (owner && item.owner !== owner) continue;
      if (id && item.id !== id) continue;
      item.invalidate?.();
    }
    this.requestRender?.();
  }

  private getActiveLayout(): FooterLayoutDefinition {
    const layout = this.layouts.get(this.activeLayoutName);
    if (!layout) throw new Error(`Unknown footer layout: ${this.activeLayoutName}`);
    return layout;
  }

  mount(ctx: ExtensionContext): void {
    this.currentCtx = ctx;
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((_tui, theme) => {
      const nextRequestRender = () => _tui.requestRender();
      this.requestRender = nextRequestRender;

      return {
        render: (width: number): string[] => {
          return renderFooterLines(this.items.values(), this.getActiveLayout(), { ctx, theme: theme as FooterTheme, layoutName: this.activeLayoutName }, width);
        },
        invalidate: () => {
          this.invalidate();
        },
        dispose: () => {
          if (this.requestRender === nextRequestRender) this.requestRender = undefined;
        },
      };
    });

    this.requestRender?.();
  }

  unmount(ctx: ExtensionContext): void {
    if (ctx.hasUI) {
      ctx.ui.setFooter(undefined);
    }
    this.requestRender = undefined;
    this.currentCtx = undefined;
  }

  onSessionStart(ctx: ExtensionContext): void {
    this.currentCtx = ctx;
    this.mount(ctx);
    for (const item of this.items.values()) item.onSessionStart?.(ctx);
    this.requestRender?.();
  }

  onTurnStart(): void {
    for (const item of this.items.values()) item.onTurnStart?.();
    this.requestRender?.();
  }

  onTurnEnd(): void {
    for (const item of this.items.values()) item.onTurnEnd?.();
    this.requestRender?.();
  }

  onToolResult(event: FooterToolResultEvent): void {
    for (const item of this.items.values()) item.onToolResult?.(event);
    this.requestRender?.();
  }

  onModelSelect(): void {
    for (const item of this.items.values()) item.onModelSelect?.();
    this.requestRender?.();
  }

  onThinkingLevelSelect(event: FooterThinkingLevelEvent): void {
    for (const item of this.items.values()) item.onThinkingLevelSelect?.(event);
    this.requestRender?.();
  }

  onSessionShutdown(ctx: ExtensionContext): void {
    for (const item of this.items.values()) item.onSessionShutdown?.(ctx);
    this.unmount(ctx);
  }
}
