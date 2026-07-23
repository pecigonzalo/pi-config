import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "bun:test";
import backgroundExtension from "./index";

type AnyTool = any;

interface Harness {
	tools: Map<string, AnyTool>;
	handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
	entries: Array<{ type: "custom"; customType: string; data?: unknown }>;
	sentMessages: Array<{ message: { customType: string; content: string }; options: unknown }>;
	ctx: ExtensionContext;
}

function createHarness(): Harness {
	const tools = new Map<string, AnyTool>();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const entries: Array<{ type: "custom"; customType: string; data?: unknown }> = [];
	const sentMessages: Array<{ message: { customType: string; content: string }; options: unknown }> = [];

	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: (tool: AnyTool) => tools.set(tool.name, tool),
		appendEntry: (customType: string, data?: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage: (message: { customType: string; content: string }, options: unknown) =>
			sentMessages.push({ message, options }),
	} as unknown as ExtensionAPI;

	const ctx = {
		cwd: process.cwd(),
		sessionManager: { getEntries: () => entries },
	} as unknown as ExtensionContext;

	backgroundExtension(pi);

	return { tools, handlers, entries, sentMessages, ctx };
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000, stepMs = 20): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitUntil timed out");
		await wait(stepMs);
	}
}

function run(tool: AnyTool, toolCallId: string, params: unknown, ctx: ExtensionContext): Promise<AnyTool> {
	return tool.execute(toolCallId, params, undefined, undefined, ctx);
}

function hasResolved(h: Harness, id: string, status: string): boolean {
	return h.entries.some(
		(e) =>
			e.customType === "background-job-resolved" &&
			(e.data as { id: string; status: string }).id === id &&
			(e.data as { id: string; status: string }).status === status,
	);
}

describe("background_run", () => {
	it("returns immediately and later delivers a completion message on success", async () => {
		const h = createHarness();
		const result = await run(h.tools.get("background_run"), "call-1", { command: "true" }, h.ctx);
		expect(result.content[0].text).toContain("Started background job");
		expect(h.entries.some((e) => e.customType === "background-job")).toBe(true);

		await waitUntil(() => h.sentMessages.length > 0);
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0]?.message.customType).toBe("background-job");
		expect(h.sentMessages[0]?.message.content).toContain("finished");
		expect(h.sentMessages[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(hasResolved(h, result.details.id, "done")).toBe(true);
	});

	it("delivers a failure message when the command exits non-zero", async () => {
		const h = createHarness();
		await run(h.tools.get("background_run"), "call-2", { command: "exit 3" }, h.ctx);

		await waitUntil(() => h.sentMessages.length > 0);
		expect(h.sentMessages[0]?.message.content).toContain("failed");
	});
});

describe("background_status", () => {
	it("lists a job while running and reflects its resolved status afterward", async () => {
		const h = createHarness();
		const status = h.tools.get("background_status");

		const started = await run(h.tools.get("background_run"), "call-3", { command: "true" }, h.ctx);
		const id = started.details.id as string;

		const immediate = await run(status, "call-4", {}, h.ctx);
		expect(immediate.details.jobs.some((job: { id: string }) => job.id === id)).toBe(true);

		await waitUntil(() => h.sentMessages.length > 0);
		const after = await run(status, "call-5", { id }, h.ctx);
		expect(after.details.job.status).toBe("done");
	});

	it("reports not found for an unknown id", async () => {
		const h = createHarness();
		const result = await run(h.tools.get("background_status"), "call-6", { id: "nope" }, h.ctx);
		expect(result.details.found).toBe(false);
	});
});

describe("background_cancel", () => {
	it("cancels a running job and suppresses the completion message", async () => {
		const h = createHarness();
		const started = await run(h.tools.get("background_run"), "call-7", { command: "sleep 5" }, h.ctx);
		const id = started.details.id as string;

		const cancelResult = await run(h.tools.get("background_cancel"), "call-8", { id }, h.ctx);
		expect(cancelResult.details.found).toBe(true);

		await wait(300);
		expect(h.sentMessages).toHaveLength(0);
		expect(hasResolved(h, id, "cancelled")).toBe(true);
	});

	it("reports not found for an unknown id", async () => {
		const h = createHarness();
		const result = await run(h.tools.get("background_cancel"), "call-9", { id: "nope" }, h.ctx);
		expect(result.details.found).toBe(false);
	});
});

describe("session_start reconciliation", () => {
	it("marks a job that never resolved before shutdown as unknown on resume", () => {
		const h = createHarness();
		h.entries.push({
			type: "custom",
			customType: "background-job",
			data: { id: "orphan", command: "sleep 100", startedAt: 0 },
		});

		const handler = h.handlers.get("session_start")?.[0];
		handler?.({}, h.ctx);

		expect(hasResolved(h, "orphan", "unknown")).toBe(true);
	});
});
