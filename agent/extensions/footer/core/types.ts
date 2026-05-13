import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type FooterSection = "a" | "b" | "c" | "x" | "y" | "z";
export type FooterLayoutName = "default" | "minimal" | "compact" | "full";

export interface FooterTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}

export interface FooterPlacement {
  row: string;
  section: FooterSection;
  order?: number;
}

export interface FooterRowDefinition {
  id: string;
  order?: number;
  componentSeparator: string;
  sectionSeparator: string;
}

export interface FooterLayoutDefinition {
  name: FooterLayoutName;
  rows: FooterRowDefinition[];
}

export interface FooterItemRenderContext {
  ctx: ExtensionContext;
  theme: FooterTheme;
  layoutName: FooterLayoutName;
  rowId: string;
  width: number;
}

export interface FooterInputEvent {
  text?: unknown;
}

export interface FooterBeforeAgentStartEvent {
  prompt: string;
}

export interface FooterToolResultEvent {
  toolName: string;
  input?: unknown;
}

export interface FooterThinkingLevelEvent {
  level: string;
  previousLevel?: string;
}

export interface FooterItem {
  owner: string;
  id: string;
  getPlacement(layoutName: FooterLayoutName): FooterPlacement | undefined;
  render(renderContext: FooterItemRenderContext): string | null;
  invalidate?(): void;
  onSessionStart?(ctx: ExtensionContext): void;
  onTurnStart?(): void;
  onTurnEnd?(): void;
  onModelSelect?(): void;
  onThinkingLevelSelect?(event: FooterThinkingLevelEvent): void;
  onToolResult?(event: FooterToolResultEvent): void;
  onInput?(event: FooterInputEvent, ctx: ExtensionContext): { action: "continue" } | undefined;
  onBeforeAgentStart?(event: FooterBeforeAgentStartEvent, ctx: ExtensionContext): void;
  onAgentEnd?(ctx: ExtensionContext): void;
  onSessionShutdown?(ctx: ExtensionContext): void;
}

export const FOOTER_REGISTER_EVENT = "footer:register";
export const FOOTER_UNREGISTER_EVENT = "footer:unregister";
export const FOOTER_INVALIDATE_EVENT = "footer:invalidate";
export const FOOTER_ACTIVATE_LAYOUT_EVENT = "footer:activate-layout";

export interface FooterRegisterEventPayload {
  item: FooterItem;
}

export interface FooterUnregisterEventPayload {
  owner: string;
  id?: string;
}

export interface FooterInvalidateEventPayload {
  owner?: string;
  id?: string;
}

export interface FooterActivateLayoutEventPayload {
  layoutName: FooterLayoutName;
}
