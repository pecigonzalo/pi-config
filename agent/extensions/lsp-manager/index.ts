import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	DefaultLspManagerService,
	LSP_MANAGER_READY_EVENT,
	LSP_MANAGER_REQUEST_EVENT,
	LSP_MANAGER_SHUTDOWN_EVENT,
	type LspManagerService,
	type LspManagerServiceRequest,
} from "./service";

function publishService(pi: ExtensionAPI, service: LspManagerService): void {
	pi.events.emit(LSP_MANAGER_READY_EVENT, service);
}

function clearService(pi: ExtensionAPI, service: LspManagerService | undefined): void {
	pi.events.emit(LSP_MANAGER_SHUTDOWN_EVENT, service);
}

function isServiceRequest(value: unknown): value is LspManagerServiceRequest {
	return !!value && typeof value === "object" && typeof (value as LspManagerServiceRequest).respond === "function";
}

function registerServiceResponder(pi: ExtensionAPI, getService: () => LspManagerService | undefined): () => void {
	return pi.events.on(LSP_MANAGER_REQUEST_EVENT, (request) => {
		if (isServiceRequest(request)) request.respond(getService());
	});
}

function requestService(pi: ExtensionAPI): LspManagerService | undefined {
	let service: LspManagerService | undefined;
	pi.events.emit(LSP_MANAGER_REQUEST_EVENT, {
		respond(value: LspManagerService | undefined) {
			service = value;
		},
	} satisfies LspManagerServiceRequest);
	return service;
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
	const unsubscribeServiceRequests = registerServiceResponder(pi, () => service);

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
		unsubscribeServiceRequests();
		if (ctx.hasUI) ctx.ui.setStatus("lsp-manager", undefined);
		if (service) await service.shutdown();
		service = undefined;
	});

	const showStatus = async (_args: string, ctx: ExtensionCommandContext) => {
		const status = formatStatus(requestService(pi) ?? service);
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
	registerServiceResponder,
	requestService,
	publishService,
};
