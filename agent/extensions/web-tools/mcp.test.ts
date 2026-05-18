import { describe, expect, test } from "bun:test";
import { callMcpTool, extractMcpTextResponse, MCP_MAX_RESPONSE_BYTES } from "./mcp";

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

describe("callMcpTool", () => {
	test("caps oversized response bodies and still parses leading SSE payloads", async () => {
		const payload = ['event: message', 'data: {"result":{"content":[{"type":"text","text":"hello"}]}}', "", "x".repeat(MCP_MAX_RESPONSE_BYTES)].join("\n");
		const result = await callMcpTool({
			url: "https://example.com/mcp",
			toolName: "demo",
			args: {},
			timeoutSeconds: 5,
			fetchImpl: async () => new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } }),
		});

		expect(result.text).toBe("hello");
		expect(result.bodyTruncated).toBe(true);
	});

	test("reports truncation when no text can be extracted from a capped body", async () => {
		await expect(
			callMcpTool({
				url: "https://example.com/mcp",
				toolName: "demo",
				args: {},
				timeoutSeconds: 5,
				fetchImpl: async () => new Response("x".repeat(MCP_MAX_RESPONSE_BYTES + 64), { status: 200 }),
			}),
		).rejects.toThrow("truncated before text extraction");
	});
});
