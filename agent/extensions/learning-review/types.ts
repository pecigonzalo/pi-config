export type LearningScope = "global-user" | "project-shared" | "project-local" | "session-only" | "unknown";

export type LearningDestination =
	| "global-agents"
	| "project-agents"
	| "global-memory"
	| "project-memory"
	| "skill"
	| "discard"
	| "undecided";

export type LearningKind =
	| "correction"
	| "preference"
	| "tool-habit"
	| "workflow"
	| "project-convention"
	| "avoidance"
	| "unknown";

export type LearningStatus = "pending" | "accepted" | "promoted" | "rejected";
export type LearningDistillationStatus = "raw" | "distilled" | "failed";

export type LearningEvidence = {
	sessionFile?: string;
	entryId?: string;
	timestamp?: string;
	cwd?: string;
	quote: string;
	previousUserText?: string;
	previousAssistantText?: string;
	nextAssistantText?: string;
	toolCalls?: string[];
	contextEntryIds?: string[];
};

export type LearningCandidate = {
	id: string;
	status: LearningStatus;
	kind: LearningKind;
	scope: LearningScope;
	destination: LearningDestination;
	text: string;
	rawText?: string;
	confidence: number;
	reason: string;
	distillationStatus?: LearningDistillationStatus;
	distillationError?: string;
	evidence: LearningEvidence[];
	createdAt: string;
	updatedAt: string;
};

export type LearningReviewConfig = {
	promptOnShutdown: boolean;
	shutdownPromptTimeoutMs: number;
	minUserMessages: number;
	maxCandidatesPerReview: number;
	storeDir: string;
	projectMemoryPath: string;
};
