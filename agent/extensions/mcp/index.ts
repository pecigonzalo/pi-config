import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createMcpService, type McpStatus } from "./service";

function formatStatus(status: McpStatus): string {
	const lines = [
		"MCP status:",
		`- config: ${status.configPath}`,
		`- configured servers: ${status.serverCount}`,
		`- daemon: ${status.daemon.error ? `error (${status.daemon.error})` : status.daemon.output || "no output"}`,
	];
	const keepAlive = status.servers.filter((server) => server.lifecycle === "keep-alive");
	if (keepAlive.length > 0) {
		lines.push(`- keep-alive servers: ${keepAlive.map((server) => server.name).join(", ")}`);
	}
	if (status.servers.length > 0) {
		lines.push("", "Servers:");
		for (const server of status.servers.slice(0, 20)) {
			const target = server.transport === "http" ? server.url : server.command;
			const source = server.sources[0];
			const sourceLabel = source ? ` [${source.kind}${source.importKind ? `:${source.importKind}` : ""} ${source.path}]` : "";
			lines.push(`- ${server.name} (${server.transport}${server.lifecycle ? `, ${server.lifecycle}` : ""})${target ? `: ${target}` : ""}${sourceLabel}`);
		}
		if (status.servers.length > 20) lines.push(`- ... ${status.servers.length - 20} more`);
	}
	return lines.join("\n");
}

async function showStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const service = createMcpService({ cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() });
	try {
		const status = await service.status();
		const text = formatStatus(status);
		if (ctx.hasUI) {
			ctx.ui.notify(text, "info");
		} else {
			pi.sendMessage({ customType: "mcp-status", content: text, display: true });
		}
	} finally {
		await service.close();
	}
}

export default function mcpExtension(pi: ExtensionAPI) {
	pi.registerCommand("mcp", {
		description: "MCP commands: /mcp status",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase() || "status";
			if (command === "status") {
				await showStatus(pi, ctx);
				return;
			}

			const help = "Usage: /mcp status";
			if (ctx.hasUI) ctx.ui.notify(help, "warning");
			else pi.sendMessage({ customType: "mcp-help", content: help, display: true });
		},
	});
}

export const __test__ = {
	formatStatus,
};
