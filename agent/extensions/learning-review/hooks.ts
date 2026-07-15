import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { countUserMessages, extractCandidatesFromEntries } from "./candidates";
import { applyClassification } from "./classify";
import { loadConfig } from "./config";
import { LearningStore } from "./store";

type LearnRuntime = {
	shutdownPromptInFlight: boolean;
	lastError?: string;
};

export function registerShutdownReviewHook(pi: ExtensionAPI, runtime: LearnRuntime): void {
	pi.on("session_shutdown", async (event, ctx) => {
		if (runtime.shutdownPromptInFlight) return;
		if (!ctx.hasUI) return;
		if (event.reason === "reload") return;

		const config = loadConfig(ctx.cwd);
		if (!config.promptOnShutdown) return;

		let entries: unknown[];
		try {
			entries = ctx.sessionManager.getBranch();
		} catch {
			return;
		}

		if (countUserMessages(entries) < config.minUserMessages) return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		const candidates = extractCandidatesFromEntries(
			entries,
			sessionFile,
			ctx.cwd,
			config.maxCandidatesPerReview,
		).map(applyClassification);
		if (candidates.length === 0) return;

		runtime.shutdownPromptInFlight = true;
		try {
			const shouldSave = await ctx.ui.confirm(
				"Review session learnings?",
				`Found ${candidates.length} possible correction/advice learning(s). Save them for /learn review?`,
				{ timeout: config.shutdownPromptTimeoutMs },
			);
			if (!shouldSave) return;

			const result = await LearningStore.global(config).addCandidates(candidates);
			ctx.ui.notify(`Saved ${result.added} new learning candidate(s). Run /learn list next session.`, "info");
		} catch (error) {
			runtime.lastError = error instanceof Error ? error.message : String(error);
		} finally {
			runtime.shutdownPromptInFlight = false;
		}
	});
}
