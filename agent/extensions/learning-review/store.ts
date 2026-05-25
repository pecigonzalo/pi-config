import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LearningCandidate, LearningReviewConfig } from "./types";
import { scanLearningText } from "./scanner";

export type LearningStoreData = {
	version: 1;
	candidates: LearningCandidate[];
};

const EMPTY_STORE: LearningStoreData = { version: 1, candidates: [] };

export function globalStorePath(config: LearningReviewConfig): string {
	return join(config.storeDir, "candidates.json");
}

export function projectStorePath(config: LearningReviewConfig, cwd: string): string {
	return join(cwd, config.projectMemoryPath);
}

async function readJson(path: string): Promise<LearningStoreData> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<LearningStoreData>;
		return {
			version: 1,
			candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
		};
	} catch {
		return { ...EMPTY_STORE, candidates: [] };
	}
}

async function atomicWrite(path: string, data: LearningStoreData): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmpDir = await mkdtemp(join(dirname(path), ".tmp-"));
	const tmpPath = join(tmpDir, "write.json");
	try {
		await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
		await rename(tmpPath, path);
	} finally {
		await rm(tmpDir, { recursive: true, force: true });
	}
}

function mergeCandidates(existing: LearningCandidate[], incoming: LearningCandidate[]): LearningCandidate[] {
	const byId = new Map(existing.map((candidate) => [candidate.id, candidate]));
	for (const candidate of incoming) {
		const scanFailure = scanLearningText(candidate.text);
		if (scanFailure) continue;

		const current = byId.get(candidate.id);
		if (!current) {
			byId.set(candidate.id, candidate);
			continue;
		}

		byId.set(candidate.id, {
			...current,
			evidence: [...current.evidence, ...candidate.evidence],
			confidence: Math.max(current.confidence, candidate.confidence),
			updatedAt: new Date().toISOString(),
		});
	}
	return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export class LearningStore {
	constructor(private path: string) {}

	static global(config: LearningReviewConfig): LearningStore {
		return new LearningStore(globalStorePath(config));
	}

	static project(config: LearningReviewConfig, cwd: string): LearningStore {
		return new LearningStore(projectStorePath(config, cwd));
	}

	get pathExists(): boolean {
		return existsSync(this.path);
	}

	async read(): Promise<LearningStoreData> {
		return readJson(this.path);
	}

	async list(status?: LearningCandidate["status"]): Promise<LearningCandidate[]> {
		const data = await this.read();
		return status ? data.candidates.filter((candidate) => candidate.status === status) : data.candidates;
	}

	async addCandidates(candidates: LearningCandidate[]): Promise<{ added: number; total: number }> {
		const before = await this.read();
		const nextCandidates = mergeCandidates(before.candidates, candidates);
		await atomicWrite(this.path, { version: 1, candidates: nextCandidates });
		return { added: Math.max(0, nextCandidates.length - before.candidates.length), total: nextCandidates.length };
	}

	async updateCandidate(id: string, update: (candidate: LearningCandidate) => LearningCandidate): Promise<boolean> {
		const data = await this.read();
		let changed = false;
		const candidates = data.candidates.map((candidate) => {
			if (candidate.id !== id && !candidate.id.startsWith(id)) return candidate;
			changed = true;
			return update(candidate);
		});
		if (!changed) return false;
		await atomicWrite(this.path, { version: 1, candidates });
		return true;
	}

	async updateAll(update: (candidate: LearningCandidate) => LearningCandidate): Promise<number> {
		const data = await this.read();
		const candidates = data.candidates.map(update);
		await atomicWrite(this.path, { version: 1, candidates });
		return candidates.length;
	}

	async updateStatus(id: string, status: LearningCandidate["status"]): Promise<boolean> {
		return this.updateCandidate(id, (candidate) => ({ ...candidate, status, updatedAt: new Date().toISOString() }));
	}

	async updateDestination(id: string, destination: LearningCandidate["destination"]): Promise<boolean> {
		return this.updateCandidate(id, (candidate) => ({
			...candidate,
			destination,
			reason: `Manually routed to ${destination}.`,
			updatedAt: new Date().toISOString(),
		}));
	}

	async search(query: string, limit = 20): Promise<LearningCandidate[]> {
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (terms.length === 0) return [];
		const data = await this.read();
		return data.candidates
			.map((candidate) => {
				const haystack = [candidate.text, candidate.kind, candidate.scope, candidate.destination, candidate.reason, ...candidate.evidence.map((item) => item.quote)].join(" ").toLowerCase();
				const score = terms.filter((term) => haystack.includes(term)).length;
				return { candidate, score };
			})
			.filter((item) => item.score > 0)
			.sort((a, b) => b.score - a.score || b.candidate.updatedAt.localeCompare(a.candidate.updatedAt))
			.slice(0, limit)
			.map((item) => item.candidate);
	}

	async get(id: string): Promise<LearningCandidate | undefined> {
		const data = await this.read();
		return data.candidates.find((candidate) => candidate.id === id || candidate.id.startsWith(id));
	}
}
