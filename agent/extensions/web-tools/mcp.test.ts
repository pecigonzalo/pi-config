import { describe, expect, test } from "bun:test";
import { extractMcpTextResponse } from "./mcp";

describe("extractMcpTextResponse", () => {
	test("extracts text from direct JSON responses", () => {
		const text = extractMcpTextResponse(
			JSON.stringify({
				result: {
					content: [{ type: "text", text: "hello from json" }],
				},
			}),
		);

		expect(text).toBe("hello from json");
	});

	test("extracts text from SSE responses", () => {
		const text = extractMcpTextResponse([
			"event: message",
			'data: {"result":{"content":[{"type":"text","text":"hello from sse"}]}}',
		].join("\n"));

		expect(text).toBe("hello from sse");
	});
});
