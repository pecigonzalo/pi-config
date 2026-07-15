import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	encodeId,
	legacyJsonPath,
	storeDelete,
	storeDir,
	storePatch,
	storeRead,
	storeWrite,
	yamlPath,
	type StoreItem,
} from "./store";

let tmpDir: string;

const yamlItem: StoreItem = {
	id: "a1b2c3d4e5f6",
	summary: "YAML item",
	tags: ["auth", "critical"],
	status: "active",
	data: { key: "yaml-value" },
	createdAt: "2024-01-01T00:00:00.000Z",
	updatedAt: "2024-01-02T00:00:00.000Z",
};

const legacyItems: StoreItem[] = [
	{
		id: "aaa-111",
		summary: "Legacy first",
		tags: ["auth", "critical"],
		status: "active",
		data: { key: "value1" },
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-02T00:00:00.000Z",
	},
	{
		id: "bbb-222",
		summary: "Legacy second",
		tags: ["database"],
		status: "archived",
		data: { key: "value2" },
		createdAt: "2024-01-03T00:00:00.000Z",
		updatedAt: "2024-01-04T00:00:00.000Z",
	},
];

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-store-test-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeYamlItem(root: string, item: StoreItem): Promise<void> {
	await fs.mkdir(storeDir(root), { recursive: true });
	await fs.writeFile(yamlPath(root, item.id), stringifyYaml(item), "utf-8");
}

async function writeLegacyItems(root: string, items: StoreItem[]): Promise<void> {
	const filePath = legacyJsonPath(root);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(items, null, 2), "utf-8");
}

async function readYamlItem(root: string, id: string): Promise<StoreItem> {
	const raw = await fs.readFile(yamlPath(root, id), "utf-8");
	return parseYaml(raw) as StoreItem;
}

describe("store extension core", () => {
	test("encodes filesystem-unsafe ids", () => {
		expect(encodeId("abc/123:def")).toBe("abc%2f123%3adef");
	});

	test("storewrite creates a YAML item with a generated id", async () => {
		const result = (await storeWrite(tmpDir, { summary: "capture context", tags: ["test"] })) as {
			success: boolean;
			id: string;
		};

		expect(result.success).toBe(true);
		expect(result.id).toMatch(/^[0-9a-f]{12}$/);

		const item = await readYamlItem(tmpDir, result.id);
		expect(item.summary).toBe("capture context");
		expect(item.tags).toEqual(["test"]);
		expect(item.status).toBe("active");
		expect(item.createdAt).toBe(item.updatedAt);
	});

	test("storeread list mode merges YAML and legacy items without data", async () => {
		await writeYamlItem(tmpDir, yamlItem);
		await writeLegacyItems(tmpDir, legacyItems);

		const result = (await storeRead(tmpDir, { includeArchived: true })) as { list: Array<Record<string, unknown>> };

		expect(result.list.map((item) => item.id).sort()).toEqual(["a1b2c3d4e5f6", "aaa-111", "bbb-222"]);
		expect(result.list.every((item) => !("data" in item))).toBe(true);
	});

	test("storeread filters tags with AND logic and excludes archived by default", async () => {
		await writeLegacyItems(tmpDir, legacyItems);

		const authResult = (await storeRead(tmpDir, { tags: ["auth", "critical"] })) as {
			list: Array<Record<string, unknown>>;
		};
		const archivedResult = (await storeRead(tmpDir, { tags: ["database"] })) as {
			list: Array<Record<string, unknown>>;
		};

		expect(authResult.list).toEqual([
			{
				id: "aaa-111",
				summary: "Legacy first",
				tags: ["auth", "critical"],
				status: "active",
				links: undefined,
				createdAt: "2024-01-01T00:00:00.000Z",
				updatedAt: "2024-01-02T00:00:00.000Z",
			},
		]);
		expect(archivedResult.list).toEqual([]);
	});

	test("storeread read mode returns full item data", async () => {
		await writeYamlItem(tmpDir, yamlItem);

		const result = (await storeRead(tmpDir, { id: yamlItem.id })) as { found: boolean; item: StoreItem };

		expect(result.found).toBe(true);
		expect(result.item.data).toEqual({ key: "yaml-value" });
	});

	test("storepatch migrates legacy items to YAML and preserves omitted fields", async () => {
		await writeLegacyItems(tmpDir, legacyItems);

		const result = await storePatch(tmpDir, { id: "aaa-111", summary: "Migrated" });
		expect(result).toEqual({ success: true, id: "aaa-111", found: true });

		const item = await readYamlItem(tmpDir, "aaa-111");
		expect(item.summary).toBe("Migrated");
		expect(item.tags).toEqual(["auth", "critical"]);

		const legacy = JSON.parse(await fs.readFile(legacyJsonPath(tmpDir), "utf-8"));
		expect(legacy).toHaveLength(1);
		expect(legacy[0].id).toBe("bbb-222");
	});

	test("storedelete removes duplicates from YAML and legacy JSON", async () => {
		const firstLegacyItem = legacyItems[0];
		if (!firstLegacyItem) throw new Error("Missing legacy fixture item");
		await writeYamlItem(tmpDir, firstLegacyItem);
		await writeLegacyItems(tmpDir, legacyItems);

		const result = await storeDelete(tmpDir, { id: "aaa-111" });
		expect(result).toEqual({ success: true, id: "aaa-111", deleted: true });

		await expect(fs.access(yamlPath(tmpDir, "aaa-111"))).rejects.toThrow();
		const legacy = JSON.parse(await fs.readFile(legacyJsonPath(tmpDir), "utf-8"));
		expect(legacy.map((item: StoreItem) => item.id)).toEqual(["bbb-222"]);
	});
});
