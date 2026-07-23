import { createBashToolDefinition, type CustomEntry, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	BACKGROUND_JOB_ENTRY_TYPE,
	BACKGROUND_JOB_RESOLVED_ENTRY_TYPE,
	formatOutputTail,
	generateJobId,
	reconcilePendingJobs,
	type JobResolvedStatus,
} from "./job-store";

type JobStatus = "running" | JobResolvedStatus;

interface JobRecord {
	id: string;
	command: string;
	startedAt: number;
	status: JobStatus;
	controller: AbortController;
	latestOutput: string;
	resolvedAt?: number;
}

const RunParams = Type.Object({
	command: Type.String({ description: "Shell command to run in the background." }),
	timeout: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds." })),
});

const StatusParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Job id to inspect. Omit to list every job." })),
});

const CancelParams = Type.Object({
	id: Type.String({ description: "Job id to cancel." }),
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.join("\n");
}

interface JobSummary {
	id: string;
	command: string;
	status: JobStatus;
	elapsedSeconds: number;
	outputTail: string;
}

function jobSummary(job: JobRecord, now: number): JobSummary {
	return {
		id: job.id,
		command: job.command,
		status: job.status,
		elapsedSeconds: Math.round(((job.resolvedAt ?? now) - job.startedAt) / 1000),
		outputTail: formatOutputTail(job.latestOutput),
	};
}

interface StatusDetails {
	found?: boolean;
	job?: JobSummary;
	jobs?: JobSummary[];
}

interface CancelDetails {
	found: boolean;
	alreadyResolved?: boolean;
}

export default function backgroundExtension(pi: ExtensionAPI) {
	const jobs = new Map<string, JobRecord>();

	function persistResolved(id: string, status: JobResolvedStatus, outputSummary?: string) {
		pi.appendEntry(BACKGROUND_JOB_RESOLVED_ENTRY_TYPE, {
			id,
			resolvedAt: Date.now(),
			status,
			outputSummary,
		});
	}

	function finishJob(job: JobRecord, status: "done" | "error", output: string) {
		if (job.status === "cancelled") return; // background_cancel already resolved this job
		job.status = status;
		job.resolvedAt = Date.now();
		job.latestOutput = output;
		persistResolved(job.id, status, formatOutputTail(output));
		const verb = status === "done" ? "finished" : "failed";
		pi.sendMessage(
			{
				customType: "background-job",
				content: `[background job ${verb}] ${job.command}\n\n${formatOutputTail(output)}`,
				display: true,
				details: { id: job.id, status },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	pi.on("session_start", (_event, ctx) => {
		const customEntries = ctx.sessionManager
			.getEntries()
			.filter((entry): entry is CustomEntry => entry.type === "custom");
		for (const job of reconcilePendingJobs(customEntries)) {
			persistResolved(job.id, "unknown");
		}
	});

	pi.on("session_shutdown", () => {
		for (const job of jobs.values()) {
			if (job.status === "running") job.controller.abort();
		}
	});

	pi.registerTool({
		name: "background_run",
		label: "Background Run",
		description:
			"Run a shell command in the background and return immediately instead of waiting for it to finish. " +
			"When the command completes, its output is injected back into the conversation and the agent is woken up. " +
			"Runs through the same permission checks as bash, but not the bash sandbox.",
		promptSnippet:
			"Run a shell command in the background; get notified when it finishes instead of blocking or polling.",
		promptGuidelines: [
			"Use background_run instead of a bash `sleep` or a polling loop when waiting on a long-running command such as a build, deploy, test suite, or `gh run watch`.",
			"Use background_status to check on a background_run job without blocking.",
			"Use background_cancel to stop a background_run job that is no longer needed.",
		],
		parameters: RunParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const id = generateJobId();
			const startedAt = Date.now();
			const controller = new AbortController();
			const job: JobRecord = {
				id,
				command: params.command,
				startedAt,
				status: "running",
				controller,
				latestOutput: "",
			};
			jobs.set(id, job);
			pi.appendEntry(BACKGROUND_JOB_ENTRY_TYPE, { id, command: params.command, startedAt });

			const bashTool = createBashToolDefinition(ctx.cwd);
			bashTool
				.execute(
					id,
					{ command: params.command, timeout: params.timeout },
					controller.signal,
					(partial) => {
						job.latestOutput = textOf(partial);
					},
					ctx,
				)
				.then((result) => finishJob(job, "done", textOf(result)))
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					finishJob(job, "error", message);
				});

			return {
				content: [{ type: "text", text: `Started background job ${id}: ${params.command}` }],
				details: { id, command: params.command, startedAt },
			};
		},
	});

	pi.registerTool({
		name: "background_status",
		label: "Background Status",
		description: "List background_run jobs, or inspect one by id, without blocking.",
		promptGuidelines: ["Use background_status to check on background_run jobs without blocking."],
		parameters: StatusParams,
		async execute(
			_toolCallId,
			params,
		): Promise<{ content: { type: "text"; text: string }[]; details: StatusDetails }> {
			const now = Date.now();
			if (params.id) {
				const job = jobs.get(params.id);
				if (!job) {
					return {
						content: [{ type: "text", text: `No background job found with id ${params.id}` }],
						details: { found: false },
					};
				}
				return {
					content: [{ type: "text", text: JSON.stringify(jobSummary(job, now), null, 2) }],
					details: { found: true, job: jobSummary(job, now) },
				};
			}
			const list = [...jobs.values()].map((job) => jobSummary(job, now));
			return {
				content: [{ type: "text", text: list.length ? JSON.stringify(list, null, 2) : "No background jobs." }],
				details: { jobs: list },
			};
		},
	});

	pi.registerTool({
		name: "background_cancel",
		label: "Background Cancel",
		description: "Cancel a running background_run job by id.",
		promptGuidelines: ["Use background_cancel to stop a background_run job that is no longer needed."],
		parameters: CancelParams,
		async execute(
			_toolCallId,
			params,
		): Promise<{ content: { type: "text"; text: string }[]; details: CancelDetails }> {
			const job = jobs.get(params.id);
			if (!job) {
				return {
					content: [{ type: "text", text: `No background job found with id ${params.id}` }],
					details: { found: false },
				};
			}
			if (job.status !== "running") {
				return {
					content: [{ type: "text", text: `Background job ${params.id} is already ${job.status}.` }],
					details: { found: true, alreadyResolved: true },
				};
			}
			job.status = "cancelled";
			job.resolvedAt = Date.now();
			job.controller.abort();
			persistResolved(job.id, "cancelled");
			return {
				content: [{ type: "text", text: `Cancelled background job ${params.id}.` }],
				details: { found: true },
			};
		},
	});
}
