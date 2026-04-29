import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const MAIN_SESSION_AGENT_CUSTOM_TYPE = "tasks.main-agent";

export default function agentStateExtension(_pi: ExtensionAPI): void {
	// Helper module for shared runtime agent state.
	// Exporting a no-op factory keeps extension auto-discovery from failing
	// when this file lives under ~/.pi/agent/extensions/.
}
