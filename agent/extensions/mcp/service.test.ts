import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createMcpService } from "./service";

describe("McpService", () => {
	test("loads servers from an explicit empty config", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-mcp-service-test-"));
		const configPath = join(dir, "mcporter.json");
		await writeFile(configPath, JSON.stringify({ mcpServers: {}, imports: [] }), "utf8");

		const service = createMcpService({ cwd: dir, configPath });
		try {
			expect(await service.servers()).toEqual([]);
		} finally {
			await service.close();
		}
	});

	test("reports daemon status without starting it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-mcp-status-test-"));
		const configPath = join(dir, "mcporter.json");
		await writeFile(configPath, JSON.stringify({ mcpServers: {}, imports: [] }), "utf8");

		const service = createMcpService({ cwd: dir, configPath });
		try {
			const status = await service.status();
			expect(status.serverCount).toBe(0);
			expect(status.daemon.checked).toBe(true);
			expect(typeof status.daemon.output).toBe("string");
		} finally {
			await service.close();
		}
	});
});
