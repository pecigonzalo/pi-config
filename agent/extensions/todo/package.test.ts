import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";

describe("todo package metadata", () => {
	it("declares an existing extension entrypoint", async () => {
		const manifest = (await Bun.file(new URL("./package.json", import.meta.url)).json()) as {
			pi?: { extensions?: string[] };
		};

		expect(manifest.pi?.extensions).toEqual(["./index.ts"]);

		for (const extensionPath of manifest.pi?.extensions ?? []) {
			expect(existsSync(new URL(extensionPath, import.meta.url))).toBe(true);
		}
	});
});
