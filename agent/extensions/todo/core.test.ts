import { describe, expect, it } from "bun:test";
import { parseTodosCommandArgs } from "./commands";
import {
	executeTodoAction,
	filteredTodoPool,
	findTodo,
	MAX_PERSISTED_HISTORY_ENTRIES,
	createTodoState,
	type TodoExecuteParams,
	type TodoState,
} from "./core";

const CORE_MODULE_URL = new URL("./core.ts", import.meta.url).href;
const FIXED_TIMESTAMP = "2024-01-01T00:00:00.000Z";

function createHarness(initialState: TodoState = createTodoState()) {
	let state = initialState;

	return {
		execute(params: TodoExecuteParams) {
			const outcome = executeTodoAction(state, params);
			state = outcome.state;
			return outcome.result;
		},
		state(): TodoState {
			return state;
		},
		todo(id: number) {
			return findTodo(state, id);
		},
	};
}

function createMalformedCycleState(): TodoState {
	return {
		nextId: 4,
		wipLimit: 2,
		todos: [
			{
				id: 1,
				title: "Task",
				status: "todo",
				tags: [],
				priority: "med",
				effort: "M",
				blockerIds: [],
				archived: false,
				history: [],
				createdAt: FIXED_TIMESTAMP,
				updatedAt: FIXED_TIMESTAMP,
			},
			{
				id: 2,
				title: "Cycle A",
				status: "todo",
				tags: [],
				priority: "med",
				effort: "M",
				parentId: 3,
				blockerIds: [],
				archived: false,
				history: [],
				createdAt: FIXED_TIMESTAMP,
				updatedAt: FIXED_TIMESTAMP,
			},
			{
				id: 3,
				title: "Cycle B",
				status: "todo",
				tags: [],
				priority: "med",
				effort: "M",
				parentId: 2,
				blockerIds: [],
				archived: false,
				history: [],
				createdAt: FIXED_TIMESTAMP,
				updatedAt: FIXED_TIMESTAMP,
			},
		],
	};
}

async function runMalformedParentValidation(
	timeoutMs = 500,
): Promise<{ timedOut: boolean; exitCode: number; stdout: string; stderr: string }> {
	const script = `
		const { executeTodoAction } = await import(${JSON.stringify(CORE_MODULE_URL)});
		const outcome = executeTodoAction(${JSON.stringify(createMalformedCycleState())}, {
			action: "update",
			id: 1,
			parentId: 2,
		});
		console.log(JSON.stringify(outcome.result.details.error ?? null));
	`;
	const proc = Bun.spawn(["bun", "-e", script], {
		stdout: "pipe",
		stderr: "pipe",
	});

	const timedOut = await new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			proc.kill();
			resolve(true);
		}, timeoutMs);
		proc.exited.then(() => {
			clearTimeout(timer);
			resolve(false);
		});
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	return { timedOut, exitCode, stdout, stderr };
}

describe("todo core invariants", () => {
	it("adds todos with trimmed titles, defaults, and creation history", () => {
		const harness = createHarness();

		const result = harness.execute({ action: "add", title: "  Ship regression tests  " });
		expect(result.details.error).toBeUndefined();

		const todo = harness.todo(1);
		expect(todo).toBeDefined();
		expect(todo?.title).toBe("Ship regression tests");
		expect(todo?.status).toBe("todo");
		expect(todo?.priority).toBe("med");
		expect(todo?.effort).toBe("M");
		expect(todo?.archived).toBe(false);
		expect(todo?.history.map((entry) => entry.type)).toEqual(["created"]);
	});

	it("includes todo titles in status-change results", () => {
		const harness = createHarness();
		harness.execute({ action: "add", title: "Write clearer status messages" });

		const result = harness.execute({ action: "toggle", id: 1, toStatus: "in-progress" });

		expect(result.content[0].text).toBe("Todo #1: Write clearer status messages moved todo → in progress");
	});

	it("updates editable fields and records update history", () => {
		const harness = createHarness();
		harness.execute({ action: "add", title: "Original title" });

		const result = harness.execute({
			action: "update",
			id: 1,
			title: "Renamed title",
			description: "Detailed context",
			tags: ["backend", "api"],
			priority: "high",
			effort: "L",
		});
		expect(result.details.error).toBeUndefined();

		const todo = harness.todo(1);
		expect(todo?.title).toBe("Renamed title");
		expect(todo?.description).toBe("Detailed context");
		expect(todo?.tags).toEqual(["backend", "api"]);
		expect(todo?.priority).toBe("high");
		expect(todo?.effort).toBe("L");
		expect(todo?.history.map((entry) => entry.type)).toEqual(["created", "updated"]);
	});

	it("links and unlinks parent/blocker relationships without duplicating blockers", () => {
		const harness = createHarness();
		harness.execute({ action: "add", title: "Child" });
		harness.execute({ action: "add", title: "Parent" });
		harness.execute({ action: "add", title: "Blocker" });

		const linkResult = harness.execute({
			action: "link",
			id: 1,
			parentId: 2,
			addBlockerIds: [3, 3],
		});
		expect(linkResult.details.error).toBeUndefined();
		expect(harness.todo(1)?.parentId).toBe(2);
		expect(harness.todo(1)?.blockerIds).toEqual([3]);

		const unlinkResult = harness.execute({
			action: "unlink",
			id: 1,
			clearParent: true,
			removeBlockerIds: [3],
		});
		expect(unlinkResult.details.error).toBeUndefined();
		expect(harness.todo(1)?.parentId).toBeUndefined();
		expect(harness.todo(1)?.blockerIds).toEqual([]);
		expect(harness.todo(1)?.history.map((entry) => entry.type)).toEqual(["created", "linked", "unlinked"]);
	});

	it("blocks completion when children remain open and only archives done todos", () => {
		const harness = createHarness();
		harness.execute({ action: "add", title: "Parent" });
		harness.execute({ action: "add", title: "Child", parentId: 1 });
		harness.execute({ action: "toggle", id: 1, toStatus: "in-progress" });

		const blockedDone = harness.execute({ action: "toggle", id: 1, toStatus: "done" });
		expect(blockedDone.details.error).toBe("unfinished children");

		harness.execute({ action: "toggle", id: 2, toStatus: "in-progress" });
		harness.execute({ action: "toggle", id: 2, toStatus: "done" });
		const doneResult = harness.execute({ action: "toggle", id: 1, toStatus: "done" });
		expect(doneResult.details.error).toBeUndefined();

		const archiveResult = harness.execute({ action: "archive", id: 1, archived: true });
		expect(archiveResult.details.error).toBeUndefined();
		expect(harness.todo(1)?.archived).toBe(true);

		const archiveTodo = createHarness();
		archiveTodo.execute({ action: "add", title: "Not done yet" });
		const earlyArchive = archiveTodo.execute({ action: "archive", id: 1, archived: true });
		expect(earlyArchive.details.error).toBe("archive requires done status");
	});

	it("enforces blockers and WIP limits when moving into in-progress", () => {
		const harness = createHarness();
		harness.execute({ action: "set_wip_limit", limit: 1 });
		harness.execute({ action: "add", title: "Blocked task" });
		harness.execute({ action: "add", title: "Prerequisite" });
		harness.execute({ action: "link", id: 1, addBlockerIds: [2] });

		const blockedStart = harness.execute({ action: "toggle", id: 1, toStatus: "in-progress" });
		expect(blockedStart.details.error).toBe("unfinished blockers");

		harness.execute({ action: "toggle", id: 2, toStatus: "in-progress" });
		harness.execute({ action: "toggle", id: 2, toStatus: "done" });
		const started = harness.execute({ action: "toggle", id: 1, toStatus: "in-progress" });
		expect(started.details.error).toBeUndefined();

		harness.execute({ action: "add", title: "Second task" });
		const wipBlocked = harness.execute({ action: "toggle", id: 3, toStatus: "in-progress" });
		expect(wipBlocked.details.error).toBe("wip limit reached");
	});

	it("prunes persisted history deterministically to the newest entries", () => {
		const harness = createHarness();
		harness.execute({ action: "add", title: "Keep latest history" });

		for (let index = 1; index <= MAX_PERSISTED_HISTORY_ENTRIES + 5; index++) {
			harness.execute({
				action: "update",
				id: 1,
				description: `revision-${index}`,
			});
		}

		const todo = harness.todo(1);
		expect(todo?.history).toHaveLength(MAX_PERSISTED_HISTORY_ENTRIES);
		expect(todo?.history[0]?.type).toBe("updated");
		expect(todo?.history[0]?.meta).toMatchObject({ description: "revision-6" });
		expect(todo?.history.at(-1)?.meta).toMatchObject({ description: `revision-${MAX_PERSISTED_HISTORY_ENTRIES + 5}` });

		const snapshot = harness.execute({ action: "list" }).details;
		expect(snapshot.todos[0]?.history).toHaveLength(MAX_PERSISTED_HISTORY_ENTRIES);
		expect(snapshot.todos[0]?.history[0]?.meta).toMatchObject({ description: "revision-6" });
	});
});

describe("todo regressions to fix", () => {
	it("BUG: /todos tag filtering should match tags regardless of command casing", () => {
		const harness = createHarness();
		harness.execute({ action: "add", title: "Investigate filter", tags: ["Backend"] });

		const parsed = parseTodosCommandArgs("tag:Backend");
		const visible = filteredTodoPool(harness.state(), parsed.view, parsed.includeArchived, parsed.status, parsed.tag);
		expect(visible.map((todo) => todo.id)).toEqual([1]);
	});

	it("BUG: update should reject empty or whitespace-only titles", () => {
		const harness = createHarness();
		harness.execute({ action: "add", title: "Keep original title" });
		const previousHistory = harness.todo(1)?.history.map((entry) => entry.type);

		const result = harness.execute({ action: "update", id: 1, title: "   " });
		expect(result.details.error).toBe("title required");
		expect(harness.todo(1)?.title).toBe("Keep original title");
		expect(harness.todo(1)?.history.map((entry) => entry.type)).toEqual(previousHistory);
	});

	it("BUG: parent-cycle validation should terminate on malformed cyclic ancestors", async () => {
		const result = await runMalformedParentValidation();
		expect(result.timedOut).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe('"parent cycle detected"');
	});
});
