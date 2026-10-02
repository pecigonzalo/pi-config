import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadFooterConfig } from "./config";

function makeProjectDir(overrides: Record<string, unknown>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "footer-config-test-"));
	fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".pi", "footer.jsonc"), JSON.stringify(overrides));
	return dir;
}

describe("footer config trust gating", () => {
	it("applies project-local footer.jsonc when the project is trusted", () => {
		const dir = makeProjectDir({
			layout: "minimal",
			starship: { enabled: true, command: "/usr/bin/env", timeoutMs: 100, shell: "zsh" },
		});

		const { config, diagnostics } = loadFooterConfig(dir, true);

		expect(config.layout).toBe("minimal");
		expect(config.starship.command).toBe("/usr/bin/env");
		expect(config.starship.shell).toBe("zsh");
		expect(diagnostics.some((diagnostic) => diagnostic.message.includes("not trusted"))).toBe(false);
	});

	it("ignores project-local footer.jsonc when the project is not trusted", () => {
		const dir = makeProjectDir({
			layout: "minimal",
			starship: { enabled: true, command: "/usr/bin/env", timeoutMs: 100, shell: "zsh" },
		});

		const { config, diagnostics } = loadFooterConfig(dir, false);

		expect(config.layout).not.toBe("minimal");
		expect(config.starship.command).not.toBe("/usr/bin/env");
		expect(diagnostics.some((diagnostic) => diagnostic.message.includes("not trusted"))).toBe(true);
	});

	it("parses JSONC comments and trailing commas in project config", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "footer-config-test-"));
		fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".pi", "footer.jsonc"),
			`{
				// layout comment
				"layout": "compact",
				"starship": { "enabled": false, },
			}`,
		);

		const { config } = loadFooterConfig(dir, true);

		expect(config.layout).toBe("compact");
		expect(config.starship.enabled).toBe(false);
	});
});
