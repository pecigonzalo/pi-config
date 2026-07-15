import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTaskSessionRootForTests, validateTaskSessionReference } from "./task-session-validation.js";

let root: string;
const writeSession = async (name: string, id: string, parentSession?: string) => {
	const file = path.join(root, name);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(
		file,
		JSON.stringify({ type: "session", id, ...(parentSession ? { parentSession } : {}) }) + "\n",
	);
	return file;
};

describe("task session validation", () => {
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "session-validation-"));
		setTaskSessionRootForTests(root);
	});
	afterEach(() => setTaskSessionRootForTests(undefined));
	it("accepts a valid relative parent", async () => {
		const parent = await writeSession("parent.jsonl", "parent");
		const child = await writeSession("child.jsonl", "child", path.basename(parent));
		expect(validateTaskSessionReference(child, "child").reference?.id).toBe("child");
	});
	it("accepts a legacy reference without an expected id", async () => {
		const file = await writeSession("legacy.jsonl", "legacy");
		expect(validateTaskSessionReference(file).reference?.id).toBe("legacy");
	});
	it("rejects outside paths, directories, malformed headers, and mismatches", async () => {
		const outside = path.join(os.tmpdir(), "outside.jsonl");
		await fs.writeFile(outside, "{}\n");
		expect(validateTaskSessionReference(outside).error).toContain("outside");
		await fs.mkdir(path.join(root, "dir"));
		expect(validateTaskSessionReference(path.join(root, "dir")).error).toContain("regular");
		const bad = path.join(root, "bad.jsonl");
		await fs.writeFile(bad, "not json\n");
		expect(validateTaskSessionReference(bad).error).toContain("malformed");
		const good = await writeSession("good.jsonl", "actual");
		expect(validateTaskSessionReference(good, "expected").error).toContain("mismatch");
	});
	it("rejects symlink escapes and parent cycles", async () => {
		const outside = path.join(os.tmpdir(), "escape.jsonl");
		await fs.writeFile(outside, JSON.stringify({ type: "session", id: "escape" }));
		await fs.symlink(outside, path.join(root, "link.jsonl"));
		expect(validateTaskSessionReference(path.join(root, "link.jsonl")).error).toContain("outside");
		const self = await writeSession("self.jsonl", "self", "self.jsonl");
		expect(validateTaskSessionReference(self).error).toContain("cycle");
		await writeSession("a.jsonl", "a", "b.jsonl");
		const b = await writeSession("b.jsonl", "b", "a.jsonl");
		expect(validateTaskSessionReference(b).error).toContain("cycle");
	});
});
