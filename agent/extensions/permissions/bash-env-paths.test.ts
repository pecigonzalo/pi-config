import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findBashEnvPathHit } from "./bash-env-paths";
import { resolveProtectedResources } from "./config";
import { parseBashCommand } from "./shell-parse";

async function withEnvWorkspace(run: (cwd: string) => Promise<void>) {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-bash-env-"));
	await fs.mkdir(path.join(tmp, "src"), { recursive: true });
	for (const file of [".env", ".env.local", ".env.example", "src/.env"]) {
		await fs.writeFile(path.join(tmp, file), "SECRET=1\n");
	}
	try {
		await run(tmp);
	} finally {
		await fs.rm(tmp, { recursive: true, force: true });
	}
}

const detect = async (command: string, cwd: string, resources = resolveProtectedResources({})) =>
	findBashEnvPathHit(await parseBashCommand(command), cwd, resources);

describe("bash env path detection", () => {
	const cases: Array<{ command: string; kind: "read" | "write" }> = [
		{ command: "cat .env", kind: "read" },
		{ command: "cp .env.example .env", kind: "write" },
		{ command: "echo A=1 > .env.local", kind: "write" },
		{ command: "head -n 5 src/.env", kind: "read" },
		{ command: "git add .env", kind: "read" },
	];

	for (const { command, kind } of cases) {
		it(`flags ${command}`, async () => {
			await withEnvWorkspace(async (cwd) => {
				const hit = await detect(command, cwd);
				expect(hit?.kind).toBe(kind);
				expect(hit?.action).toBe("ask");
			});
		});
	}

	it("ignores templates, patterns, and env names that do not exist", async () => {
		await withEnvWorkspace(async (cwd) => {
			expect(await detect("cat .env.example", cwd)).toBeUndefined();
			expect(await detect("rg '\\.env' src", cwd)).toBeUndefined();
			expect(await detect("cat .env.missing", cwd)).toBeUndefined();
		});
	});

	it("honours workspace-read exemptions and hard block overrides", async () => {
		await withEnvWorkspace(async (cwd) => {
			const workspaceRead = resolveProtectedResources({ protectedResources: { workspaceRead: ["**/.env"] } });
			expect(await detect("cat .env", cwd, workspaceRead)).toBeUndefined();

			const blocked = resolveProtectedResources({
				protectedResources: { readAction: "block", envWriteAction: "block" },
			});
			expect((await detect("cat .env", cwd, blocked))?.action).toBe("block");
			expect((await detect("echo A=1 > .env", cwd, blocked))?.action).toBe("block");
			// Templates stay readable even when secret reads are hard-blocked.
			expect(await detect("cat .env.example", cwd, blocked)).toBeUndefined();
		});
	});
});
