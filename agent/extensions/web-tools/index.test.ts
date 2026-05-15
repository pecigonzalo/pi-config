import { expect, test } from "bun:test";
import webToolsExtension from "./index";

test("registers both web tools", () => {
	const tools: Array<{ name: string }> = [];
	webToolsExtension({
		registerTool(tool) {
			tools.push({ name: tool.name });
		},
	} as never);

	expect(tools.map((tool) => tool.name)).toEqual(["webfetch", "websearch"]);
});
