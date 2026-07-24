import { describe, expect, test } from "bun:test";
import { executeWebfetch, WebfetchParams } from "./webfetch";

describe("WebfetchParams", () => {
	test("documents the supported timeout range without unsupported schema keywords", () => {
		const timeout = (WebfetchParams as { properties: { timeout: { description?: string } } }).properties.timeout;
		expect(timeout.description).toContain("1..120");
		expect(timeout).not.toHaveProperty("minimum");
		expect(timeout).not.toHaveProperty("maximum");
		expect(timeout).not.toHaveProperty("multipleOf");
	});
});

describe("executeWebfetch", () => {
	test("converts html to markdown by default", async () => {
		const result = await executeWebfetch(
			{ url: "https://example.com/docs" },
			{
				fetchImpl: async () =>
					new Response(
						"<html><head><title>Example Docs</title></head><body><h1>Hello</h1><p>world</p></body></html>",
						{
							status: 200,
							headers: { "content-type": "text/html; charset=utf-8" },
						},
					),
			},
		);

		expect(result.details.appliedFormat).toBe("markdown");
		expect(result.details.title).toBe("Example Docs");
		expect(result.content[0]?.text).toContain("# Hello");
		expect(result.content[0]?.text).toContain("world");
	});

	test("returns plain text for non-html content", async () => {
		const result = await executeWebfetch(
			{ url: "https://example.com/plain.txt", format: "text" },
			{
				fetchImpl: async () =>
					new Response("alpha\n\nbeta\n", {
						status: 200,
						headers: { "content-type": "text/plain" },
					}),
			},
		);

		expect(result.details.appliedFormat).toBe("text");
		expect(result.content[0]?.text).toContain("alpha");
		expect(result.content[0]?.text).toContain("beta");
	});

	test("leaves out-of-range numeric HTML entities intact instead of throwing", async () => {
		const result = await executeWebfetch(
			{ url: "https://example.com/bad-entity" },
			{
				fetchImpl: async () =>
					new Response("<html><head><title>&#x110000;</title></head><body><p>&#x110000;</p></body></html>", {
						status: 200,
						headers: { "content-type": "text/html; charset=utf-8" },
					}),
			},
		);

		expect(result.details.title).toBe("&#x110000;");
		expect(result.content[0]?.text).toBeTruthy();
	});

	test("rejects invalid urls", async () => {
		await expect(executeWebfetch({ url: "not-a-url" })).rejects.toThrow("Invalid url");
	});
});
