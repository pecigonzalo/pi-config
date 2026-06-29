import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { extractCandidatesFromEntries, extractExplicitCandidateFromEntryId, listUserMessageChoices } from "./candidates";
import { applyClassification } from "./classify";
import { loadConfig } from "./config";
import { distillCandidate, distillCandidates } from "./distill";
import { LearningStore } from "./store";
import type { LearningCandidate, LearningDestination } from "./types";

type LearnRuntime = {
	lastReviewAt?: string;
	lastError?: string;
};

function renderCandidate(candidate: LearningCandidate): string {
	const evidence = candidate.evidence[0];
	return [
		`### ${candidate.id} · ${candidate.status} · ${candidate.destination}`,
		`- Kind: ${candidate.kind}`,
		`- Scope: ${candidate.scope}`,
		`- Confidence: ${candidate.confidence.toFixed(2)}`,
		`- Text: ${candidate.text}`,
		candidate.rawText && candidate.rawText !== candidate.text ? `- Raw: ${candidate.rawText}` : undefined,
		candidate.distillationStatus ? `- Distillation: ${candidate.distillationStatus}${candidate.distillationError ? ` (${candidate.distillationError})` : ""}` : undefined,
		`- Evidence: ${evidence?.sessionFile ?? "current session"}${evidence?.entryId ? `#${evidence.entryId}` : ""}`,
	].filter(Boolean).join("\n");
}

function sendLearningMessage(pi: ExtensionAPI, content: string): void {
	pi.sendMessage({
		customType: "learning-review",
		content,
		display: true,
		details: {},
	});
}

function helpText(): string {
	return [
		"# Learning review",
		"",
		"Commands:",
		"- `/learn`: pick a user message from the current session to learn from explicitly.",
		"- `/learn review`: scan the current session for correction/advice candidates and save them for review.",
		"- `/learn list [pending|accepted|promoted|rejected]`: list stored candidates.",
		"- `/learn recall <id>`: show evidence for a candidate.",
		"- `/learn search <query>`: search stored candidates.",
		"- `/learn classify [id|all]`: apply the current heuristic classifier to pending candidates.",
		"- `/learn distill [id|all]`: use the active model to distill raw candidates into reusable learnings.",
		"- `/learn route <id> <destination>`: manually set destination without applying changes.",
		"- `/learn accept <id>`: mark a candidate accepted in the memory store.",
		"- `/learn reject <id>`: reject a candidate.",
		"- `/learn status`: show store status and config.",
		"",
		"Typical flow:",
		"1. `/learn review` to harvest candidates, or bare `/learn` to pick one explicit user message.",
		"2. `/learn distill` to normalize pending raw candidates through the active model.",
		"3. `/learn recall <id>` to inspect evidence.",
		"4. `/learn route <id> <destination>` if the suggested destination is wrong.",
		"5. `/learn accept <id>` or `/learn reject <id>`.",
		"",
		"Notes:",
		"- Bare `/learn` attempts distillation immediately for the selected message.",
		"- `/learn distill` is enough after `/learn review`; `/learn classify` is a cheap fallback/debug step.",
		"- This scaffold does not edit AGENTS.md yet. Promotion/apply flows should stay explicit and reviewable.",
	].join("\n");
}

async function pickExplicitLearning(pi: ExtensionAPI, ctx: ExtensionCommandContext, runtime: LearnRuntime): Promise<void> {
	const entries = ctx.sessionManager.getBranch();
	const choices = listUserMessageChoices(entries);
	if (choices.length === 0) {
		ctx.ui.notify("No user messages found in the current session", "warning");
		return;
	}

	const labels = choices.map((choice) => choice.label);
	const selected = await ctx.ui.select("Learn from which user message?", labels);
	if (!selected) return;

	const choice = choices.find((item) => item.label === selected);
	if (!choice) return;

	const config = loadConfig(ctx.cwd);
	const sessionFile = ctx.sessionManager.getSessionFile();
	const candidate = extractExplicitCandidateFromEntryId(entries, choice.id, sessionFile, ctx.cwd);
	if (!candidate) {
		ctx.ui.notify("Could not create learning candidate for selected message", "warning");
		return;
	}

	let classified = applyClassification(candidate);
	try {
		ctx.ui.notify("Distilling selected learning...", "info");
		classified = await distillCandidate(classified, ctx);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Stored raw candidate; distillation skipped: ${message}`, "warning");
	}
	const result = await LearningStore.global(config).addCandidates([classified]);
	runtime.lastReviewAt = new Date().toISOString();

	sendLearningMessage(
		pi,
		[
			"# Explicit learning candidate",
			"",
			`Added ${result.added} new candidate(s).`,
			"",
			renderCandidate(classified),
			"",
			"Next: use `/learn recall <id>`, `/learn route <id> <destination>`, `/learn accept <id>`, or `/learn reject <id>`.",
		].join("\n"),
	);
}

async function review(pi: ExtensionAPI, ctx: ExtensionCommandContext, runtime: LearnRuntime): Promise<void> {
	const config = loadConfig(ctx.cwd);
	const store = LearningStore.global(config);
	const entries = ctx.sessionManager.getBranch();
	const sessionFile = ctx.sessionManager.getSessionFile();
	const candidates = extractCandidatesFromEntries(entries, sessionFile, ctx.cwd, config.maxCandidatesPerReview).map(applyClassification);

	if (candidates.length === 0) {
		ctx.ui.notify("No learning candidates found in the current session", "info");
		return;
	}

	const result = await store.addCandidates(candidates);
	runtime.lastReviewAt = new Date().toISOString();

	sendLearningMessage(
		pi,
		[
			`# Learning review candidates`,
			"",
			`Found ${candidates.length} candidate(s). Added ${result.added} new candidate(s).`,
			`Store: ${config.storeDir}`,
			"",
			...candidates.map(renderCandidate),
			"",
			"Next: use `/learn recall <id>`, `/learn accept <id>`, or `/learn reject <id>`.",
		].join("\n"),
	);
}

async function list(pi: ExtensionAPI, ctx: ExtensionCommandContext, statusArg?: string): Promise<void> {
	const config = loadConfig(ctx.cwd);
	const store = LearningStore.global(config);
	const allowed = new Set(["pending", "accepted", "promoted", "rejected"]);
	const status = allowed.has(statusArg ?? "") ? (statusArg as LearningCandidate["status"]) : undefined;
	const candidates = await store.list(status);

	if (candidates.length === 0) {
		sendLearningMessage(pi, `# Learning review\n\nNo${status ? ` ${status}` : ""} candidates found.`);
		return;
	}

	sendLearningMessage(
		pi,
		[
			`# Learning review candidates`,
			"",
			`Showing ${candidates.length}${status ? ` ${status}` : ""} candidate(s).`,
			"",
			...candidates.map(renderCandidate),
		].join("\n"),
	);
}

async function search(pi: ExtensionAPI, ctx: ExtensionCommandContext, query: string): Promise<void> {
	if (!query.trim()) {
		ctx.ui.notify("Usage: /learn search <query>", "warning");
		return;
	}

	const config = loadConfig(ctx.cwd);
	const matches = await LearningStore.global(config).search(query);
	if (matches.length === 0) {
		sendLearningMessage(pi, `# Learning search\n\nNo candidates matched: ${query}`);
		return;
	}

	sendLearningMessage(
		pi,
		[
			"# Learning search",
			"",
			`Query: ${query}`,
			"",
			...matches.map(renderCandidate),
		].join("\n"),
	);
}

async function distill(pi: ExtensionAPI, ctx: ExtensionCommandContext, selector?: string): Promise<void> {
	const config = loadConfig(ctx.cwd);
	const store = LearningStore.global(config);
	const found = selector && selector !== "all"
		? [await store.get(selector)].filter((candidate): candidate is LearningCandidate => !!candidate)
		: await store.list("pending");

	if (found.length === 0) {
		ctx.ui.notify(selector && selector !== "all" ? `No learning candidate found for ${selector}` : "No pending learning candidates to distill", "warning");
		return;
	}

	let result;
	try {
		result = await distillCandidates(found, ctx);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Could not run learning distillation: ${message}`, "warning");
		return;
	}

	for (const candidate of result.candidates) {
		await store.updateCandidate(candidate.id, () => candidate);
	}

	const distilledCount = result.candidates.filter((candidate) => candidate.distillationStatus === "distilled").length;
	const failedCount = result.candidates.filter((candidate) => candidate.distillationStatus === "failed").length;
	ctx.ui.notify(`Distilled ${distilledCount}/${found.length} learning candidate(s)${failedCount ? `; ${failedCount} failed` : ""}`, distilledCount > 0 ? "info" : "warning");
	if (selector && selector !== "all") await recall(pi, ctx, selector);
	else await list(pi, ctx, "pending");
}

async function classify(pi: ExtensionAPI, ctx: ExtensionCommandContext, selector?: string): Promise<void> {
	const config = loadConfig(ctx.cwd);
	const store = LearningStore.global(config);

	if (!selector || selector === "all") {
		const count = await store.updateAll(applyClassification);
		ctx.ui.notify(`Classified ${count} learning candidate(s)`, "info");
		await list(pi, ctx, undefined);
		return;
	}

	const changed = await store.updateCandidate(selector, applyClassification);
	if (!changed) {
		ctx.ui.notify(`No learning candidate found for ${selector}`, "warning");
		return;
	}
	await recall(pi, ctx, selector);
}

async function recall(pi: ExtensionAPI, ctx: ExtensionCommandContext, id?: string): Promise<void> {
	if (!id) {
		ctx.ui.notify("Usage: /learn recall <id>", "warning");
		return;
	}

	const config = loadConfig(ctx.cwd);
	const candidate = await LearningStore.global(config).get(id);
	if (!candidate) {
		ctx.ui.notify(`No learning candidate found for ${id}`, "warning");
		return;
	}

	sendLearningMessage(
		pi,
		[
			renderCandidate(candidate),
			"",
			"## Evidence",
			...candidate.evidence.map((item) => [
				`- Session: ${item.sessionFile ?? "unknown"}`,
				`  Entry: ${item.entryId ?? "unknown"}`,
				`  Time: ${item.timestamp ?? "unknown"}`,
				`  CWD: ${item.cwd ?? "unknown"}`,
				`  User: ${item.quote}`,
				item.previousUserText ? `  Previous user: ${item.previousUserText}` : undefined,
				item.previousAssistantText ? `  Previous assistant: ${item.previousAssistantText}` : undefined,
				item.toolCalls?.length ? `  Previous tool calls: ${item.toolCalls.join(", ")}` : undefined,
				item.nextAssistantText ? `  Next assistant: ${item.nextAssistantText}` : undefined,
				item.contextEntryIds?.length ? `  Context entries: ${item.contextEntryIds.join(", ")}` : undefined,
			].filter(Boolean).join("\n")),
		].join("\n"),
	);
}

const DESTINATIONS = new Set<LearningDestination>([
	"global-agents",
	"project-agents",
	"global-memory",
	"project-memory",
	"skill",
	"discard",
	"undecided",
]);

async function route(ctx: ExtensionCommandContext, id: string | undefined, destination: string | undefined): Promise<void> {
	if (!id || !destination) {
		ctx.ui.notify("Usage: /learn route <id> <destination>", "warning");
		return;
	}
	if (!DESTINATIONS.has(destination as LearningDestination)) {
		ctx.ui.notify(`Invalid destination: ${destination}`, "warning");
		return;
	}

	const config = loadConfig(ctx.cwd);
	const changed = await LearningStore.global(config).updateDestination(id, destination as LearningDestination);
	ctx.ui.notify(changed ? `Learning candidate ${id} routed to ${destination}` : `No learning candidate found for ${id}`, changed ? "info" : "warning");
}

async function setStatus(ctx: ExtensionCommandContext, id: string | undefined, status: LearningCandidate["status"]): Promise<void> {
	if (!id) {
		ctx.ui.notify(`Usage: /learn ${status === "rejected" ? "reject" : "accept"} <id>`, "warning");
		return;
	}

	const config = loadConfig(ctx.cwd);
	const changed = await LearningStore.global(config).updateStatus(id, status);
	ctx.ui.notify(changed ? `Learning candidate ${id} marked ${status}` : `No learning candidate found for ${id}`, changed ? "info" : "warning");
}

async function status(pi: ExtensionAPI, ctx: ExtensionCommandContext, runtime: LearnRuntime): Promise<void> {
	const config = loadConfig(ctx.cwd);
	const store = LearningStore.global(config);
	const candidates = await store.list();
	const counts = candidates.reduce<Record<string, number>>((acc, candidate) => {
		acc[candidate.status] = (acc[candidate.status] ?? 0) + 1;
		return acc;
	}, {});

	sendLearningMessage(
		pi,
		[
			"# Learning review status",
			"",
			`- Store: ${config.storeDir}`,
			`- Prompt on shutdown: ${config.promptOnShutdown}`,
			`- Min user messages: ${config.minUserMessages}`,
			`- Max candidates per review: ${config.maxCandidatesPerReview}`,
			`- Last review: ${runtime.lastReviewAt ?? "never"}`,
			`- Last error: ${runtime.lastError ?? "none"}`,
			"",
			"## Candidate counts",
			`- Pending: ${counts.pending ?? 0}`,
			`- Accepted: ${counts.accepted ?? 0}`,
			`- Promoted: ${counts.promoted ?? 0}`,
			`- Rejected: ${counts.rejected ?? 0}`,
		].join("\n"),
	);
}

export const LEARN_COMPLETIONS = [
	{ value: "review",   label: "review: interactively review candidates" },
	{ value: "list",     label: "list: list learnings" },
	{ value: "recall",   label: "recall: show a learning by ID" },
	{ value: "search",   label: "search: search learnings" },
	{ value: "classify", label: "classify: classify a candidate" },
	{ value: "distill",  label: "distill: distill a candidate into learnings" },
	{ value: "route",    label: "route: route a candidate to a file" },
	{ value: "accept",   label: "accept: accept a candidate" },
	{ value: "reject",   label: "reject: reject a candidate" },
	{ value: "status",   label: "status: show review stats" },
	{ value: "help",     label: "help: show usage" },
] as const;

export function registerLearnCommand(pi: ExtensionAPI, runtime: LearnRuntime): void {
	pi.registerCommand("learn", {
		description: "Review and manage source-backed learnings from session corrections/advice",
		getArgumentCompletions: (prefix) =>
			LEARN_COMPLETIONS.filter((s) => s.value.startsWith(prefix.trim())),
		handler: async (args, ctx) => {
			const [command, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				switch (command) {
					case undefined:
						await pickExplicitLearning(pi, ctx, runtime);
						break;
					case "help":
						sendLearningMessage(pi, helpText());
						break;
					case "review":
						await review(pi, ctx, runtime);
						break;
					case "list":
						await list(pi, ctx, rest[0]);
						break;
					case "recall":
						await recall(pi, ctx, rest[0]);
						break;
					case "search":
						await search(pi, ctx, rest.join(" "));
						break;
					case "classify":
						await classify(pi, ctx, rest[0]);
						break;
					case "distill":
						await distill(pi, ctx, rest[0]);
						break;
					case "route":
						await route(ctx, rest[0], rest[1]);
						break;
					case "accept":
						await setStatus(ctx, rest[0], "accepted");
						break;
					case "reject":
					case "forget":
						await setStatus(ctx, rest[0], "rejected");
						break;
					case "status":
						await status(pi, ctx, runtime);
						break;
					default:
						ctx.ui.notify(`Unknown /learn subcommand: ${command}`, "warning");
						sendLearningMessage(pi, helpText());
				}
			} catch (error) {
				runtime.lastError = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Learning review failed: ${runtime.lastError}`, "error");
			}
		},
	});
}
