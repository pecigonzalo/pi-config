import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerWebfetchTool } from "./webfetch";
import { registerWebsearchTool } from "./websearch";

export default function webToolsExtension(pi: ExtensionAPI) {
	registerWebfetchTool(pi);
	registerWebsearchTool(pi);
}
