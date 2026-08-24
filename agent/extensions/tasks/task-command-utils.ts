import * as path from "node:path";

const TASK_SELECTOR_CANDIDATE_LIMIT = 8;

export type TasksScope = "current";
export type TasksAction = "list" | "open" | "parent" | "steer" | "attach" | "origin" | "view" | "toggle";

export interface ParsedTasksCommand {
	scope: TasksScope;
	action: TasksAction;
	selector?: string;
	message?: string;
	error?: string;
}

export interface TaskSelectorStepSnapshot {
	childSessionId: string;
	childSessionPath: string;
}

export interface TaskSelectorStepView<TSnapshot extends TaskSelectorStepSnapshot = TaskSelectorStepSnapshot> {
	step: number;
	snapshot: TSnapshot;
}

export interface TaskSelectorRunView<TStep extends TaskSelectorStepView = TaskSelectorStepView> {
	internalRunKey: string;
	runId: string;
	status: string;
	mode: string;
	steps: TStep[];
}

export interface TaskSelectorResolution<TRun, TStep> {
	run: TRun;
	step?: TStep;
	matchedBy: "runId" | "childSession" | "basename" | "index";
}

function formatRunCandidate<TRun extends TaskSelectorRunView>(run: TRun, runs: TRun[]): string {
	const index = runs.findIndex((candidate) => candidate.internalRunKey === run.internalRunKey);
	const indexLabel = index >= 0 ? `#${index + 1}` : "#?";
	return `${indexLabel} ${run.runId} (${run.status}, ${run.mode})`;
}

function formatStepCandidate<
	TSnapshot extends TaskSelectorStepSnapshot,
	TStep extends TaskSelectorStepView<TSnapshot>,
	TRun extends TaskSelectorRunView<TStep>,
>(run: TRun, step: TStep, runs: TRun[]): string {
	const index = runs.findIndex((candidate) => candidate.internalRunKey === run.internalRunKey);
	const indexLabel = index >= 0 ? `#${index + 1}` : "#?";
	const basename = path.basename(step.snapshot.childSessionPath);
	return `${indexLabel} ${run.runId} step ${step.step} session ${step.snapshot.childSessionId.slice(0, 8)} (${basename})`;
}

function formatAmbiguousSelectorError(selector: string, kind: string, candidates: string[]): string {
	const shown = candidates.slice(0, TASK_SELECTOR_CANDIDATE_LIMIT);
	const lines = [`Ambiguous selector "${selector}" (${kind}).`, ...shown.map((candidate) => `- ${candidate}`)];
	if (candidates.length > shown.length) lines.push(`- ... ${candidates.length - shown.length} more`);
	return lines.join("\n");
}

export function parseTasksCommand(args: string): ParsedTasksCommand {
	const trimmed = args.trim();
	if (!trimmed) return { scope: "current", action: "list" };
	const tokens = trimmed.split(/\s+/).filter(Boolean);
	const lower = tokens.map((token) => token.toLowerCase());

	if (lower[0] === "list") {
		if (tokens.length === 1) return { scope: "current", action: "list" };
		return { scope: "current", action: "list", error: `Unsupported /tasks arguments: ${args}` };
	}

	if (lower[0] === "parent") {
		if (tokens.length === 1) return { scope: "current", action: "parent" };
		return { scope: "current", action: "parent", error: `Unsupported /tasks arguments: ${args}` };
	}

	if (lower[0] === "toggle") {
		if (tokens.length === 1) return { scope: "current", action: "toggle" };
		return { scope: "current", action: "toggle", error: `Unsupported /tasks arguments: ${args}` };
	}

	if (
		(lower[0] === "open" || lower[0] === "attach" || lower[0] === "origin" || lower[0] === "view") &&
		tokens.length >= 2
	) {
		return {
			scope: "current",
			action: lower[0] as TasksAction,
			selector: tokens.slice(1).join(" "),
		};
	}

	if (lower[0] === "steer" && tokens.length >= 3) {
		return {
			scope: "current",
			action: "steer",
			selector: tokens[1],
			message: tokens.slice(2).join(" "),
		};
	}

	return { scope: "current", action: "list", error: `Unsupported /tasks arguments: ${args}` };
}

export function resolveTaskSelector<
	TSnapshot extends TaskSelectorStepSnapshot,
	TStep extends TaskSelectorStepView<TSnapshot>,
	TRun extends TaskSelectorRunView<TStep>,
>(selector: string, runs: TRun[], usage = ""): { resolution?: TaskSelectorResolution<TRun, TStep>; error?: string } {
	const trimmed = selector.trim();
	if (!trimmed) return { error: usage ? `Missing selector. Usage: ${usage}` : "Missing selector." };

	if (/^\d+$/.test(trimmed)) {
		const index = Number.parseInt(trimmed, 10);
		const run = runs[index - 1];
		if (!run) {
			return { error: `List index ${index} is out of range (1-${runs.length}).` };
		}
		return { resolution: { run, matchedBy: "index" } };
	}

	const runIdMatches = runs.filter((run) => run.runId.startsWith(trimmed));
	if (runIdMatches.length === 1) return { resolution: { run: runIdMatches[0]!, matchedBy: "runId" } };
	if (runIdMatches.length > 1) {
		return {
			error: formatAmbiguousSelectorError(
				trimmed,
				"runId prefix",
				runIdMatches.map((run) => formatRunCandidate(run, runs)),
			),
		};
	}

	const childSessionMatches: Array<{ run: TRun; step: TStep }> = [];
	for (const run of runs) {
		for (const step of run.steps) {
			if (step.snapshot.childSessionId.startsWith(trimmed)) childSessionMatches.push({ run, step });
		}
	}
	if (childSessionMatches.length === 1) {
		const match = childSessionMatches[0]!;
		return { resolution: { run: match.run, step: match.step, matchedBy: "childSession" } };
	}
	if (childSessionMatches.length > 1) {
		return {
			error: formatAmbiguousSelectorError(
				trimmed,
				"child session id prefix",
				childSessionMatches.map((match) => formatStepCandidate(match.run, match.step, runs)),
			),
		};
	}

	const basenameMatches: Array<{ run: TRun; step: TStep }> = [];
	for (const run of runs) {
		for (const step of run.steps) {
			if (path.basename(step.snapshot.childSessionPath) === trimmed) basenameMatches.push({ run, step });
		}
	}
	if (basenameMatches.length === 1) {
		const match = basenameMatches[0]!;
		return { resolution: { run: match.run, step: match.step, matchedBy: "basename" } };
	}
	if (basenameMatches.length > 1) {
		return {
			error: formatAmbiguousSelectorError(
				trimmed,
				"session file basename",
				basenameMatches.map((match) => formatStepCandidate(match.run, match.step, runs)),
			),
		};
	}

	return { error: `No task run matches selector "${trimmed}".` };
}
