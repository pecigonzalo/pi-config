import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLearnCommand } from "./commands";
import { registerShutdownReviewHook } from "./hooks";

type LearnRuntime = {
	lastReviewAt?: string;
	lastError?: string;
	shutdownPromptInFlight: boolean;
};

export default function learningReviewExtension(pi: ExtensionAPI) {
	const runtime: LearnRuntime = {
		shutdownPromptInFlight: false,
	};

	registerLearnCommand(pi, runtime);
	registerShutdownReviewHook(pi, runtime);
}
