import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type StoreStatus = "active" | "archived" | "deprecated";

export interface StoreItem {
	id: string;
	summary: string;
	tags: string[];
	status?: StoreStatus;
	links?: string[];
	data?: unknown;
	updatedAt?: string;
	createdAt?: string;
}

export interface StoreReadParams {
	id?: string;
	tags?: string[];
	includeArchived?: boolean;
}

export interface StoreWriteParams {
	summary: string;
	tags: string[];
	status?: StoreStatus;
	links?: string[];
	data?: unknown;
}

export interface StorePatchParams {
	id: string;
	summary?: string;
	tags?: string[];
	status?: StoreStatus;
	links?: string[];
	data?: unknown;
}

export interface StoreDeleteParams {
	id: string;
}

export type LegacyReadResult = { ok: true; items: StoreItem[] } | { ok: false; error: "missing" | "corrupt" };

const LOCK_POLL_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

export function storeDir(root: string): string {
	return path.join(root, ".opencode", "sessions", "store");
}

export function legacyJsonPath(root: string): string {
	return path.join(root, ".opencode", "sessions", "store.json");
}

export function encodeId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, (ch) => {
		const hex = ch.charCodeAt(0).toString(16).padStart(2, "0");
		return `%${hex}`;
	});
}

export function yamlPath(root: string, id: string): string {
	return path.join(storeDir(root), `${encodeId(id)}.yaml`);
}

export function yamlLockPath(root: string, id: string): string {
	return `${yamlPath(root, id)}.lock`;
}

export function legacyLockPath(root: string): string {
	return `${legacyJsonPath(root)}.lock`;
}

export async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
	const deadline = Date.now() + LOCK_TIMEOUT_MS;

	while (true) {
		try {
			await fs.mkdir(lockPath);
			await fs.writeFile(path.join(lockPath, "pid"), `${process.pid}\n${Date.now()}`, "utf-8").catch(() => {
				// Best-effort metadata; the lock directory is the actual lock.
			});

			let released = false;
			return async () => {
				if (released) return;
				released = true;
				await fs.rm(lockPath, { recursive: true, force: true });
			};
		} catch (error: unknown) {
			if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}

			try {
				const content = await fs.readFile(path.join(lockPath, "pid"), "utf-8");
				const timestamp = Number(content.split("\n")[1]);
				if (!Number.isNaN(timestamp) && Date.now() - timestamp > LOCK_STALE_MS) {
					await fs.rm(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {
				try {
					const lockStat = await fs.stat(lockPath);
					if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
						await fs.rm(lockPath, { recursive: true, force: true });
						continue;
					}
				} catch {
					continue;
				}
			}

			if (Date.now() >= deadline) {
				throw new Error(`Lock timeout: could not acquire ${lockPath}`);
			}

			await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
		}
	}
}

export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
	const tmp = `${filePath}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	await fs.writeFile(tmp, content, "utf-8");
	await fs.rename(tmp, filePath);
}

export async function writeYamlItem(root: string, item: StoreItem): Promise<void> {
	await fs.mkdir(storeDir(root), { recursive: true });
	await atomicWriteFile(yamlPath(root, item.id), stringifyYaml(item));
}

export async function readYamlItem(root: string, id: string): Promise<StoreItem | null> {
	try {
		const raw = await fs.readFile(yamlPath(root, id), "utf-8");
		const parsed = parseYaml(raw);
		if (parsed && typeof parsed === "object" && "id" in parsed) {
			return parsed as StoreItem;
		}
	} catch {
		// Missing or unparseable items are treated as absent.
	}
	return null;
}

export async function deleteYamlItem(root: string, id: string): Promise<boolean> {
	try {
		await fs.unlink(yamlPath(root, id));
		return true;
	} catch {
		return false;
	}
}

export async function readAllYamlItems(root: string): Promise<StoreItem[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(storeDir(root));
	} catch {
		return [];
	}

	const items: StoreItem[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".yaml")) continue;
		try {
			const raw = await fs.readFile(path.join(storeDir(root), entry), "utf-8");
			const parsed = parseYaml(raw);
			if (parsed && typeof parsed === "object" && "id" in parsed) {
				items.push(parsed as StoreItem);
			}
		} catch {
			// Skip corrupt YAML files.
		}
	}
	return items;
}

export async function withYamlLock<T>(
	root: string,
	id: string,
	fn: (current: StoreItem | null) => Promise<{ result: T; item: StoreItem | null | undefined }>,
): Promise<T> {
	await fs.mkdir(storeDir(root), { recursive: true });
	const release = await acquireLock(yamlLockPath(root, id));
	try {
		const current = await readYamlItem(root, id);
		const { result, item } = await fn(current);
		if (item === null) {
			await deleteYamlItem(root, id);
		} else if (item !== undefined) {
			await writeYamlItem(root, item);
		}
		return result;
	} finally {
		await release();
	}
}

export async function readLegacyJson(root: string): Promise<LegacyReadResult> {
	let raw: string;
	try {
		raw = await fs.readFile(legacyJsonPath(root), "utf-8");
	} catch {
		return { ok: false, error: "missing" };
	}

	try {
		const parsed = JSON.parse(raw);
		return { ok: true, items: Array.isArray(parsed) ? (parsed as StoreItem[]) : [] };
	} catch {
		return { ok: false, error: "corrupt" };
	}
}

export async function writeLegacyJson(root: string, items: StoreItem[]): Promise<void> {
	const filePath = legacyJsonPath(root);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await atomicWriteFile(filePath, JSON.stringify(items, null, 2));
}

export async function withLegacyLock<T>(
	root: string,
	fn: (current: LegacyReadResult) => Promise<{ result: T; items?: StoreItem[] }>,
): Promise<T> {
	await fs.mkdir(path.dirname(legacyJsonPath(root)), { recursive: true });
	const release = await acquireLock(legacyLockPath(root));
	try {
		const current = await readLegacyJson(root);
		const outcome = await fn(current);
		if (outcome.items !== undefined) {
			await writeLegacyJson(root, outcome.items);
		}
		return outcome.result;
	} finally {
		await release();
	}
}

export async function removeLegacyItem(root: string, id: string): Promise<boolean> {
	return withLegacyLock(root, async (current) => {
		if (!current.ok) return { result: false };

		const after = current.items.filter((item) => item.id !== id);
		if (after.length === current.items.length) return { result: false };

		return { result: true, items: after };
	});
}

function mergeItems(yamlItems: StoreItem[], legacyItems: StoreItem[]): StoreItem[] {
	const yamlIds = new Set(yamlItems.map((item) => item.id));
	return [...yamlItems, ...legacyItems.filter((item) => !yamlIds.has(item.id))];
}

function generateId(): string {
	return randomBytes(6).toString("hex");
}

async function uniqueId(root: string): Promise<string> {
	const existing = await readAllYamlItems(root);
	const existingIds = new Set(existing.map((item) => item.id));
	let id = generateId();
	while (existingIds.has(id)) {
		id = generateId();
	}
	return id;
}

export async function storeRead(root: string, params: StoreReadParams): Promise<unknown> {
	if (params.id) {
		const yamlItem = await readYamlItem(root, params.id);
		if (yamlItem) return { found: true, item: yamlItem };

		const legacy = await readLegacyJson(root);
		if (legacy.ok) {
			const found = legacy.items.find((item) => item.id === params.id);
			if (found) return { found: true, item: found };
		}

		return { found: false, item: null };
	}

	const yamlItems = await readAllYamlItems(root);
	const legacy = await readLegacyJson(root);
	const merged = mergeItems(yamlItems, legacy.ok ? legacy.items : []);
	const includeArchived = params.includeArchived ?? false;

	const list = merged
		.filter((item) => {
			if (!includeArchived && item.status === "archived") return false;
			if (params.tags && params.tags.length > 0) {
				return params.tags.every((tag) => item.tags?.includes(tag));
			}
			return true;
		})
		.map((item) => ({
			id: item.id,
			summary: item.summary,
			tags: item.tags,
			status: item.status,
			links: item.links,
			createdAt: item.createdAt,
			updatedAt: item.updatedAt,
		}));

	return { list };
}

export async function storeWrite(root: string, params: StoreWriteParams): Promise<unknown> {
	const id = await uniqueId(root);
	const now = new Date().toISOString();
	const item: StoreItem = {
		id,
		summary: params.summary,
		tags: params.tags,
		status: params.status ?? "active",
		links: params.links,
		data: params.data,
		createdAt: now,
		updatedAt: now,
	};

	await writeYamlItem(root, item);
	return { success: true, id };
}

export async function storePatch(root: string, params: StorePatchParams): Promise<unknown> {
	const { id, ...patch } = params;

	return withYamlLock<unknown>(root, id, async (yamlItem) => {
		let existing = yamlItem;
		let fromLegacy = false;

		if (!existing) {
			const legacy = await readLegacyJson(root);
			if (!legacy.ok) {
				return {
					result: {
						success: false,
						id,
						found: false,
						error: legacy.error === "corrupt" ? "Store file is corrupted" : "Store not found",
					},
					item: undefined,
				};
			}

			const found = legacy.items.find((item) => item.id === id);
			if (!found) {
				return {
					result: { success: false, id, found: false, error: "Item not found" },
					item: undefined,
				};
			}

			existing = found;
			fromLegacy = true;
		}

		const updated: StoreItem = {
			...existing,
			...(patch.summary !== undefined && { summary: patch.summary }),
			...(patch.tags !== undefined && { tags: patch.tags }),
			...(patch.status !== undefined && { status: patch.status }),
			...(patch.links !== undefined && { links: patch.links }),
			...(patch.data !== undefined && { data: patch.data }),
			updatedAt: new Date().toISOString(),
		};

		if (fromLegacy) {
			await removeLegacyItem(root, id);
		}

		return { result: { success: true, id, found: true }, item: updated };
	});
}

export async function storeDelete(root: string, params: StoreDeleteParams): Promise<unknown> {
	const { id } = params;
	const yamlDeleted = await withYamlLock(root, id, async (current) => {
		if (current) return { result: true, item: null };
		return { result: false, item: undefined };
	});

	let legacyDeleted = false;
	const legacy = await readLegacyJson(root);
	if (legacy.ok) {
		if (legacy.items.some((item) => item.id === id)) {
			legacyDeleted = await removeLegacyItem(root, id);
		}
	} else if (legacy.error === "corrupt" && !yamlDeleted) {
		return { success: false, id, deleted: false, error: "Store file is corrupted" };
	}

	return { success: true, id, deleted: yamlDeleted || legacyDeleted };
}
