import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  DefaultLspManagerService,
  LSP_MANAGER_READY_EVENT,
  LSP_MANAGER_SERVICE_KEY,
  type LspManagerService,
} from "./service";

function publishService(pi: ExtensionAPI, service: LspManagerService): void {
  (pi.events as unknown as Record<string, unknown>)[LSP_MANAGER_SERVICE_KEY] = service;
  pi.events.emit(LSP_MANAGER_READY_EVENT, service);
}

function clearService(pi: ExtensionAPI, service: LspManagerService | undefined): void {
  const registry = pi.events as unknown as Record<string, unknown>;
  if (registry[LSP_MANAGER_SERVICE_KEY] === service) {
    delete registry[LSP_MANAGER_SERVICE_KEY];
  }
}

function getPublishedService(pi: ExtensionAPI): LspManagerService | undefined {
  const registry = pi.events as unknown as Record<string, unknown>;
  const service = registry[LSP_MANAGER_SERVICE_KEY];
  return service && typeof service === "object" && typeof (service as LspManagerService).status === "function"
    ? service as LspManagerService
    : undefined;
}

function formatStatus(service: LspManagerService | undefined): string {
  if (!service) return "LSP manager is not initialized.";
  const statuses = service.status();
  if (statuses.length === 0) return "LSP manager: no configured language servers.";
  return [
    "LSP servers:",
    ...statuses.map((status) => {
      const availability = status.available ? "installed" : "missing";
      const state = status.running ? "running" : "stopped";
      const suffix = status.running
        ? ` — ${status.openFiles} open file(s), ${status.diagnostics} diagnostic(s)`
        : "";
      const root = status.root ? `\n  root: ${status.root}` : "";
      return `- ${status.id}: ${state}, ${availability} (${status.command})${suffix}${root}`;
    }),
  ].join("\n");
}

export default function lspManagerExtension(pi: ExtensionAPI) {
  let service: LspManagerService | undefined;

  pi.registerMessageRenderer("lsp-manager-status", (message, _options, theme) => {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return new Text(theme.fg("muted", content), 0, 0);
  });

  pi.on("session_start", async (_event, ctx) => {
    if (service) await service.shutdown();
    service = new DefaultLspManagerService(ctx.cwd);
    publishService(pi, service);
    if (ctx.hasUI) {
      ctx.ui.setStatus("lsp-manager", ctx.ui.theme.fg("dim", "LSP: idle"));
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearService(pi, service);
    if (ctx.hasUI) ctx.ui.setStatus("lsp-manager", undefined);
    if (service) await service.shutdown();
    service = undefined;
  });

  const showStatus = async (_args: string, ctx: ExtensionCommandContext) => {
    const status = formatStatus(getPublishedService(pi) ?? service);
    if (ctx.hasUI) {
      ctx.ui.notify(status, "info");
    } else {
      pi.sendMessage({
        customType: "lsp-manager-status",
        content: status,
        display: true,
      });
    }
  };

  pi.registerCommand("lsp", {
    description: "Show LSP server status",
    handler: showStatus,
  });

  pi.registerCommand("lsp-manager", {
    description: "Show LSP manager status (alias for /lsp)",
    handler: showStatus,
  });
}

export const __test__ = {
  clearService,
  formatStatus,
  getPublishedService,
  publishService,
};
