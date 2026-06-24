import { existsSync } from "node:fs";
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

	test("creates per-server daemon cwd before spawning stdio server", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-mcp-server-cwd-test-"));
		const configPath = join(dir, "mcporter.json");
		await writeFile(
			configPath,
			JSON.stringify({
				mcpServers: {
					probe: {
						command: "/bin/sh",
						args: ["-c", "exit 0"],
						cwd: "${MCPORTER_DAEMON_DIR}/custom/deep",
					},
				},
				imports: [],
			}),
			"utf8",
		);

		const service = createMcpService({ cwd: dir, configPath, sessionId: "test-session" });
		try {
			let message = "";
			try {
				await service.listTools({ server: "probe" });
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}

			expect(message).not.toContain("ENOENT");
			expect(existsSync(join(dir, ".pi", "mcporter-daemon", "test-session", "probe"))).toBe(true);
			expect(existsSync(join(dir, ".pi", "mcporter-daemon", "test-session", "custom", "deep"))).toBe(true);
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
