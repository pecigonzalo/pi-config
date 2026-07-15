import type { LearningCandidate, LearningDestination, LearningKind, LearningScope } from "./types";

export type LearningClassification = {
	kind: LearningKind;
	scope: LearningScope;
	destination: LearningDestination;
	reason: string;
	confidence: number;
};

const GLOBAL_TOOL_TERMS = [
	"typescript tool",
	"python <<",
	"bash heredoc",
	"todo items",
	"simple tasks",
	"task tool",
	"delegate",
	"subagent",
	"parallel",
	"skill",
	"current working directory",
	"cd <current-cwd>",
];

const PROJECT_TERMS = [
	"this repo",
	"this project",
	"this codebase",
	"@agent/",
	"agent/extensions/",
	"package.json",
	"taskfile",
	"terraform",
	"homebrew",
	"nix",
];

const AVOIDANCE_TERMS = ["don't", "dont", "do not", "never", "avoid", "not supposed", "without asking", "stop"];
const PREFERENCE_TERMS = ["prefer", "rather", "instead", "i like", "i would", "we want", "should"];
const WORKFLOW_TERMS = ["plan", "review", "implement", "commit", "stage", "test", "verify", "delegate", "task"];
const PROCEDURE_TERMS = [
	"procedure",
	"steps",
	"checklist",
	"when debugging",
	"when fixing",
	"how to",
	"run then",
	"first",
	"then verify",
];

function includesAny(text: string, terms: string[]): boolean {
	return terms.some((term) => text.includes(term));
}

function inferKind(text: string): LearningKind {
	if (includesAny(text, AVOIDANCE_TERMS)) return "avoidance";
	if (includesAny(text, GLOBAL_TOOL_TERMS)) return "tool-habit";
	if (includesAny(text, WORKFLOW_TERMS)) return "workflow";
	if (includesAny(text, PREFERENCE_TERMS)) return "preference";
	if (includesAny(text, PROJECT_TERMS)) return "project-convention";
	return "correction";
}

function looksProcedural(text: string): boolean {
	return (
		includesAny(text, PROCEDURE_TERMS) && /\b(run|check|verify|debug|fix|create|update|deploy|test)\b/i.test(text)
	);
}

function inferScope(text: string): LearningScope {
	if (includesAny(text, PROJECT_TERMS)) return "project-shared";
	if (includesAny(text, GLOBAL_TOOL_TERMS)) return "global-user";
	if (/\b(src|lib|test|tests|docs|agent)\//i.test(text)) return "project-shared";
	return "unknown";
}

function inferDestination(kind: LearningKind, scope: LearningScope, text: string): LearningDestination {
	if (looksProcedural(text)) return "skill";
	if (scope === "project-shared") {
		return kind === "project-convention" ? "project-memory" : "project-agents";
	}
	if (scope === "global-user") {
		return kind === "correction" || kind === "avoidance" || kind === "tool-habit" || kind === "workflow"
			? "global-agents"
			: "global-memory";
	}
	return "undecided";
}

export function classifyCandidate(candidate: LearningCandidate): LearningClassification {
	const text = candidate.text.toLowerCase();
	const kind = inferKind(text);
	const scope = inferScope(text);
	const destination = inferDestination(kind, scope, text);
	const confidenceBoost = destination === "undecided" ? 0 : 0.05;

	return {
		kind,
		scope,
		destination,
		confidence: Math.min(0.95, candidate.confidence + confidenceBoost),
		reason:
			destination === "undecided"
				? "Heuristic classifier found a correction/advice candidate but could not safely choose a scope or destination."
				: `Heuristic classifier suggests ${destination} based on ${kind} signals and ${scope} scope.`,
	};
}

export function applyClassification(candidate: LearningCandidate): LearningCandidate {
	const classification = classifyCandidate(candidate);
	return {
		...candidate,
		kind: classification.kind,
		scope: classification.scope,
		destination: classification.destination,
		confidence: classification.confidence,
		reason: classification.reason,
		updatedAt: new Date().toISOString(),
	};
}
