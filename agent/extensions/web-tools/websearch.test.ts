import { describe, expect, test } from "bun:test";
import { executeWebsearch, type McpToolOutcome, WebsearchParams } from "./websearch";

function block(title: string, url: string, highlight = "Snippet."): string {
	return `Title: ${title}\nURL: ${url}\nPublished: 2026-01-01\nAuthor: Exa\nHighlights:\n${highlight}\n[...]`;
}

function searchText(blocks: string[]): string {
	return blocks.join("\n\n---\n\n");
}

function ok(text: string): McpToolOutcome {
	return { isError: false, content: [{ type: "text", text }] };
}

const DOC_BLOCK = block("Pi Docs", "https://docs.example.com/pi", "Pi is a coding agent.");
const OTHER_BLOCK = block("Example", "https://other.example.net/example", "Another result.");
const SUB_BLOCK = block("Pi API", "https://api.docs.example.com/v1", "API reference.");

describe("WebsearchParams", () => {
	test("documents the supported limit range without unsupported schema keywords", () => {
		const limit = (WebsearchParams as { properties: { limit: { description?: string } } }).properties.limit;
		expect(limit.description).toContain("1..10");
		expect(limit).not.toHaveProperty("minimum");
		expect(limit).not.toHaveProperty("maximum");
		expect(limit).not.toHaveProperty("multipleOf");
	});

	test("documents the domains allowlist cap without unsupported schema keywords", () => {
		const domains = (WebsearchParams as { properties: { domains: { description?: string } } }).properties.domains;
		expect(domains.description).toContain("10");
		expect(domains).not.toHaveProperty("maxItems");
	});

	test("exposes objective and no longer exposes mode", () => {
		const properties = (WebsearchParams as unknown as { properties: Record<string, unknown> }).properties;
		expect(properties).toHaveProperty("objective");
		expect(properties).not.toHaveProperty("mode");
	});
});

describe("executeWebsearch", () => {
	test("calls the Exa MCP tool with query, objective and numResults", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const result = await executeWebsearch(
			{ query: "pi coding agent", limit: 2 },
			{
				callTool: async (name, args) => {
					calls.push({ name, args });
					return ok(searchText([DOC_BLOCK, OTHER_BLOCK]));
				},
			},
		);

		expect(calls).toEqual([
			{
				name: "mcp__exa__web_search_exa",
				args: { query: "pi coding agent", objective: "pi coding agent", numResults: 2 },
			},
		]);
		expect(result.details.provider).toBe("exa");
		expect(result.details.transport).toBe("mcp");
		expect(result.details.resultCount).toBe(2);
		expect(result.details.objective).toBe("pi coding agent");
		expect(result.details.results[0]?.url).toBe("https://docs.example.com/pi");
		expect(result.content[0]?.text).toContain("Pi Docs");
	});

	test("uses an explicit objective when provided", async () => {
		let objective: unknown;
		await executeWebsearch(
			{ query: "pi", objective: "Official release notes only" },
			{
				callTool: async (_name, args) => {
					objective = args.objective;
					return ok(searchText([DOC_BLOCK]));
				},
			},
		);
		expect(objective).toBe("Official release notes only");
	});

	test("filters results by domain client-side and requests extra results", async () => {
		let requested: unknown;
		const result = await executeWebsearch(
			{ query: "pi", limit: 2, domains: ["docs.example.com"] },
			{
				callTool: async (_name, args) => {
					requested = args.numResults;
					return ok(searchText([DOC_BLOCK, OTHER_BLOCK, SUB_BLOCK]));
				},
			},
		);

		expect(requested).toBe(10);
		expect(result.details.domains).toEqual(["docs.example.com"]);
		expect(result.details.resultCount).toBe(2);
		expect(result.details.results.map((item) => item.domain)).toEqual(["docs.example.com", "api.docs.example.com"]);
		expect(result.details.warnings.some((warning) => warning.includes("outside the requested domains"))).toBe(true);
	});

	test("treats unparseable results as an empty success with a warning", async () => {
		const result = await executeWebsearch({ query: "nothing" }, { callTool: async () => ok("No useful results.") });

		expect(result.details.resultCount).toBe(0);
		expect(result.details.warnings.some((warning) => warning.includes("expected result block format"))).toBe(true);
		expect(result.content[0]?.text).toContain("No search results found.");
	});

	test("maps MCP error outcomes to a normalized error", async () => {
		await expect(
			executeWebsearch(
				{ query: "pi" },
				{
					callTool: async () => ({
						isError: true,
						content: [{ type: "text", text: "HttpException: 429 Too Many Requests" }],
					}),
				},
			),
		).rejects.toThrow("rate limited");
	});

	test("explains how to configure the server when the MCP tool is missing", async () => {
		await expect(
			executeWebsearch(
				{ query: "pi" },
				{
					callTool: async () => ({
						isError: true,
						content: [{ type: "text", text: "Tool mcp__exa__web_search_exa not found" }],
					}),
				},
			),
		).rejects.toThrow("mcp.json");
	});

	test("rejects invalid domain filters", async () => {
		await expect(
			executeWebsearch(
				{ query: "pi", domains: ["not a domain"] },
				{ callTool: async () => ok(searchText([DOC_BLOCK])) },
			),
		).rejects.toThrow("Invalid domain filter");
	});

	test("rejects empty queries", async () => {
		await expect(
			executeWebsearch({ query: "   " }, { callTool: async () => ok(searchText([DOC_BLOCK])) }),
		).rejects.toThrow("non-empty query");
	});
});
