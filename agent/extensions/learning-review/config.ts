import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LearningReviewConfig } from "./types";

const DEFAULT_CONFIG: LearningReviewConfig = {
	promptOnShutdown: false,
	shutdownPromptTimeoutMs: 8000,
	minUserMessages: 3,
	maxCandidatesPerReview: 20,
	storeDir: join(homedir(), ".pi", "agent", "learning-review"),
	projectMemoryPath: join(".pi", "learning-review", "memories.json"),
};

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function applyConfig(base: LearningReviewConfig, raw: unknown): LearningReviewConfig {
	if (!raw || typeof raw !== "object") return base;
	const input = raw as Record<string, unknown>;
	return {
		...base,
		promptOnShutdown: typeof input.promptOnShutdown === "boolean" ? input.promptOnShutdown : base.promptOnShutdown,
		shutdownPromptTimeoutMs: typeof input.shutdownPromptTimeoutMs === "number" ? input.shutdownPromptTimeoutMs : base.shutdownPromptTimeoutMs,
		minUserMessages: typeof input.minUserMessages === "number" ? input.minUserMessages : base.minUserMessages,
		maxCandidatesPerReview: typeof input.maxCandidatesPerReview === "number" ? input.maxCandidatesPerReview : base.maxCandidatesPerReview,
		storeDir: typeof input.storeDir === "string" && input.storeDir.trim() ? input.storeDir : base.storeDir,
		projectMemoryPath: typeof input.projectMemoryPath === "string" && input.projectMemoryPath.trim() ? input.projectMemoryPath : base.projectMemoryPath,
	};
}

export function loadConfig(cwd: string): LearningReviewConfig {
	let config = { ...DEFAULT_CONFIG };

	const globalSettings = readJson(join(homedir(), ".pi", "agent", "settings.json"));
	if (globalSettings && typeof globalSettings === "object") {
		const settings = globalSettings as Record<string, unknown>;
		config = applyConfig(config, settings["learning-review"] ?? settings.learn);
	}

	const projectSettings = readJson(join(cwd, ".pi", "settings.json"));
	if (projectSettings && typeof projectSettings === "object") {
		const settings = projectSettings as Record<string, unknown>;
		config = applyConfig(config, settings["learning-review"] ?? settings.learn);
	}

	return config;
}
