import { afterEach, describe, expect, test } from "bun:test";
import { executeWebsearch } from "./websearch";

const originalExaApiKey = process.env.EXA_API_KEY;

function restoreEnv() {
	if (originalExaApiKey === undefined) delete process.env.EXA_API_KEY;
	else process.env.EXA_API_KEY = originalExaApiKey;
}

afterEach(() => {
	restoreEnv();
});

describe("executeWebsearch", () => {
	test("normalizes exa results into compact output", async () => {
		process.env.EXA_API_KEY = "test-key";

		const result = await executeWebsearch(
			{ query: "pi coding agent", limit: 2, domains: ["docs.example.com"], mode: "semantic" },
			{
				fetchImpl: async (_url, init) => {
					const body = JSON.parse(String(init?.body));
					expect(body.includeDomains).toEqual(["docs.example.com"]);
					expect(body.type).toBe("neural");
					return new Response(
						JSON.stringify({
							requestId: "req_123",
							results: [
								{
									title: "Pi Docs",
									url: "https://docs.example.com/pi",
									highlights: ["Pi is a coding agent."],
									score: 0.9123,
									publishedDate: "2026-01-01",
								},
							],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				},
			},
		);

		expect(result.details.provider).toBe("exa");
		expect(result.details.resultCount).toBe(1);
		expect(result.details.results[0]?.url).toBe("https://docs.example.com/pi");
		expect(result.content[0]?.text).toContain("Pi Docs");
		expect(result.content[0]?.text).toContain("Pi is a coding agent.");
	});

	test("treats empty results as success", async () => {
		process.env.EXA_API_KEY = "test-key";

		const result = await executeWebsearch(
			{ query: "nothing" },
			{
				fetchImpl: async () =>
					new Response(JSON.stringify({ requestId: "req_empty", results: [] }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			},
		);

		expect(result.details.resultCount).toBe(0);
		expect(result.content[0]?.text).toContain("No search results found.");
	});

	test("fails clearly when EXA_API_KEY is missing", async () => {
		delete process.env.EXA_API_KEY;
		await expect(executeWebsearch({ query: "pi coding agent" })).rejects.toThrow("EXA_API_KEY");
	});
});
