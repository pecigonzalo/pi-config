import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeApprovalFileAtomic, type ApprovalStoreOperations } from "./approval-store";

const operations: ApprovalStoreOperations = {
	mkdirSync: fs.mkdirSync,
	openSync: fs.openSync,
	writeFileSync: fs.writeFileSync,
	fsyncSync: fs.fsyncSync,
	closeSync: fs.closeSync,
	chmodSync: fs.chmodSync,
	renameSync: fs.renameSync,
	unlinkSync: fs.unlinkSync,
};

async function temporaryFiles(dir: string): Promise<string[]> {
	return (await fsp.readdir(dir)).filter((name) => name.endsWith(".tmp"));
}

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "approval-store-"));
	temporaryDirectories.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe("atomic approval persistence", () => {
	it("atomically replaces the file with valid JSON and restrictive permissions", async () => {
		const dir = await makeTemporaryDirectory();
		const target = path.join(dir, "nested", "approvals.json");
		writeApprovalFileAtomic(target, {
			approvals: [{ tool: "bash", scopeType: "tool", scopeValue: "bash", createdAt: 1 }],
		});
		expect(JSON.parse(await fsp.readFile(target, "utf8")).approvals).toHaveLength(1);
		if (process.platform !== "win32") expect((await fsp.stat(target)).mode & 0o777).toBe(0o600);
	});

	it("keeps the target and cleans the temporary file when writing fails before sync", async () => {
		const dir = await makeTemporaryDirectory();
		const target = path.join(dir, "approvals.json");
		await fsp.writeFile(target, "original\n");
		let fsyncCalled = false;
		expect(() =>
			writeApprovalFileAtomic(
				target,
				{ approvals: [] },
				{
					...operations,
					writeFileSync: () => {
						throw new Error("write failed");
					},
					fsyncSync: () => {
						fsyncCalled = true;
					},
				},
			),
		).toThrow("write failed");
		expect(fsyncCalled).toBe(false);
		expect(await fsp.readFile(target, "utf8")).toBe("original\n");
		expect(await temporaryFiles(dir)).toEqual([]);
	});

	it("keeps the target and cleans the temporary file when sync fails before rename", async () => {
		const dir = await makeTemporaryDirectory();
		const target = path.join(dir, "approvals.json");
		await fsp.writeFile(target, "original\n");
		expect(() =>
			writeApprovalFileAtomic(
				target,
				{ approvals: [] },
				{
					...operations,
					fsyncSync: () => {
						throw new Error("sync failed");
					},
				},
			),
		).toThrow("sync failed");
		expect(await fsp.readFile(target, "utf8")).toBe("original\n");
		expect(await temporaryFiles(dir)).toEqual([]);
	});

	it("keeps the target and cleans the temporary file when rename fails", async () => {
		const dir = await makeTemporaryDirectory();
		const target = path.join(dir, "approvals.json");
		await fsp.writeFile(target, "original\n");
		expect(() =>
			writeApprovalFileAtomic(
				target,
				{ approvals: [] },
				{
					...operations,
					renameSync: () => {
						throw new Error("rename failed");
					},
				},
			),
		).toThrow("rename failed");
		expect(await fsp.readFile(target, "utf8")).toBe("original\n");
		expect(await temporaryFiles(dir)).toEqual([]);
	});
});
