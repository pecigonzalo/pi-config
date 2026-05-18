import { afterEach, describe, expect, test } from "bun:test";
import { executeWebsearch } from "./websearch";

const originalExaApiKey = process.env.EXA_API_KEY;
const originalExaMcpUrl = process.env.EXA_MCP_URL;

function restoreEnv() {
	if (originalExaApiKey === undefined) delete process.env.EXA_API_KEY;
	else process.env.EXA_API_KEY = originalExaApiKey;

	if (originalExaMcpUrl === undefined) delete process.env.EXA_MCP_URL;
	else process.env.EXA_MCP_URL = originalExaMcpUrl;
}

afterEach(() => {
	restoreEnv();
});

describe("executeWebsearch", () => {
	test("normalizes MCP SSE results into compact output without requiring an API key", async () => {
		delete process.env.EXA_API_KEY;
		process.env.EXA_MCP_URL = "https://mcp.exa.ai/mcp";

		const result = await executeWebsearch(
			{ query: "pi coding agent", limit: 2, domains: ["docs.example.com"], mode: "semantic" },
			{
				fetchImpl: async (url, init) => {
					const body = JSON.parse(String(init?.body));
					expect(String(url)).toBe("https://mcp.exa.ai/mcp");
					expect(body.params.name).toBe("web_search_exa");
					expect(body.params.arguments.includeDomains).toEqual(["docs.example.com"]);
					expect(body.params.arguments.type).toBe("neural");
					return new Response(
						[
							"event: message",
							'data: {"result":{"content":[{"type":"text","text":"Title: Pi Docs\\nURL: https://docs.example.com/pi\\nPublished: 2026-01-01\\nAuthor: Exa\\nHighlights:\\nPi is a coding agent.\\n[...]\\nPi is extensible.\\n\\n---\\n\\nTitle: Example\\nURL: https://docs.example.com/example\\nPublished: N/A\\nAuthor: Exa\\nHighlights:\\nAnother result."}],"_meta":{"searchTime":1.2}},"jsonrpc":"2.0","id":1}',
						].join("\n"),
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					);
				},
			},
		);

		expect(result.details.provider).toBe("exa");
		expect(result.details.transport).toBe("mcp");
		expect(result.details.resultCount).toBe(2);
		expect(result.details.results[0]?.url).toBe("https://docs.example.com/pi");
		expect(result.details.results[0]?.snippet).toContain("Pi is a coding agent.");
		expect(result.content[0]?.text).toContain("Pi Docs");
		expect(result.content[0]?.text).toContain("Pi is extensible.");
	});

	test("sends EXA_API_KEY via headers and redacts secrets from returned details", async () => {
		process.env.EXA_API_KEY = "test-key";
		process.env.EXA_MCP_URL = "https://mcp.exa.ai/mcp?exaApiKey=url-secret&foo=bar&access_token=token-secret";

		const result = await executeWebsearch(
			{ query: "pi coding agent" },
			{
				fetchImpl: async (url, init) => {
					const parsed = new URL(String(url));
					const headers = new Headers(init?.headers);

					expect(headers.get("authorization")).toBe("Bearer test-key");
					expect(headers.get("x-api-key")).toBe("test-key");
					expect(parsed.searchParams.get("exaApiKey")).toBe("url-secret");
					return new Response(
						JSON.stringify({
							result: {
								content: [
									{
										type: "text",
										text: "Title: Pi\nURL: https://pi.dev/\nPublished: N/A\nAuthor: Exa\nHighlights:\nMinimal coding agent.",
									},
								],
							},
							jsonrpc: "2.0",
							id: 1,
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				},
			},
		);

		const detailsEndpoint = new URL(result.details.response.endpoint);
		expect(detailsEndpoint.searchParams.get("foo")).toBe("bar");
		expect(detailsEndpoint.searchParams.get("exaApiKey")).toBe("REDACTED");
		expect(detailsEndpoint.searchParams.get("access_token")).toBe("REDACTED");
		expect(result.content[0]?.text).not.toContain("test-key");
		expect(JSON.stringify(result)).not.toContain("test-key");
		expect(JSON.stringify(result)).not.toContain("url-secret");
		expect(JSON.stringify(result)).not.toContain("token-secret");
	});

	test("treats empty parsed results as success", async () => {
		delete process.env.EXA_API_KEY;

		const result = await executeWebsearch(
			{ query: "nothing" },
			{
				fetchImpl: async () =>
					new Response(
						JSON.stringify({
							result: {
								content: [{ type: "text", text: "No useful results." }],
							},
							jsonrpc: "2.0",
							id: 1,
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			},
		);

		expect(result.details.resultCount).toBe(0);
		expect(result.content[0]?.text).toContain("No search results found.");
	});
});
