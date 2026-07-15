import { describe, expect, it } from "bun:test";
import {
	applyPersistedDetails,
	createSnapshot,
	createTodoState,
	MAX_PERSISTED_HISTORY_ENTRIES,
	reconstructTodoSession,
} from "./state";
import type { TodoDetails, TodoItem } from "./types";

const FIXED_TIMESTAMP = "2024-01-01T00:00:00.000Z";

function createPersistedTodo(id: number, overrides: Record<string, unknown> = {}): TodoItem {
	return {
		id,
		title: `Todo ${id}`,
		status: "todo",
		tags: [],
		priority: "med",
		effort: "M",
		blockerIds: [],
		archived: false,
		history: [],
		createdAt: FIXED_TIMESTAMP,
		updatedAt: FIXED_TIMESTAMP,
		...overrides,
	} as TodoItem;
}

describe("todo state helpers", () => {
	it("normalizes persisted details and infers missing defaults", () => {
		const details: Partial<TodoDetails> = {
			todos: [
				createPersistedTodo(4, {
					title: undefined,
					text: "Legacy title",
					status: "in_progress",
					tags: ["Backend", 123],
					blockerIds: [2, 2, "x"],
					history: [{ timestamp: FIXED_TIMESTAMP, type: "created" }],
				}),
			],
			wipLimit: 0,
		};

		const state = applyPersistedDetails(createTodoState(), details);
		expect(state.nextId).toBe(5);
		expect(state.wipLimit).toBe(2);
		expect(state.todos).toHaveLength(1);
		expect(state.todos[0]).toMatchObject({
			id: 4,
			title: "Legacy title",
			status: "in-progress",
			tags: ["Backend"],
			blockerIds: [2],
		});
		expect(state.todos[0]?.history).toEqual([
			{
				timestamp: FIXED_TIMESTAMP,
				type: "created",
				todoId: 4,
				meta: undefined,
			},
		]);
	});

	it("reconstructs state and widget visibility from branch entries", () => {
		const persistedDetails: Partial<TodoDetails> = {
			todos: [createPersistedTodo(2, { title: "Restored todo" })],
			nextId: 3,
			wipLimit: 4,
		};

		const reconstructed = reconstructTodoSession([
			{
				type: "message",
				message: {
					role: "assistant",
					toolName: "todo",
					details: {
						todos: [createPersistedTodo(1, { title: "Ignored" })],
					},
				},
			},
			{ type: "custom", customType: "todo-widget-state", data: { visible: true } },
			{ type: "custom", customType: "todo-state", data: persistedDetails },
		]);

		expect(reconstructed.widgetVisible).toBe(true);
		expect(reconstructed.state).toMatchObject({
			nextId: 3,
			wipLimit: 4,
			todos: [
				{
					id: 2,
					title: "Restored todo",
				},
			],
		});
	});

	it("prunes normalized persisted history to the newest entries", () => {
		const history = Array.from({ length: MAX_PERSISTED_HISTORY_ENTRIES + 3 }, (_, index) => ({
			timestamp: `2024-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
			type: "updated",
			meta: { index },
		}));
		const state = applyPersistedDetails(createTodoState(), {
			todos: [createPersistedTodo(1, { history })],
			nextId: 2,
		});

		expect(state.todos[0]?.history).toHaveLength(MAX_PERSISTED_HISTORY_ENTRIES);
		expect(state.todos[0]?.history[0]?.meta).toMatchObject({ index: 3 });
		expect(state.todos[0]?.history.at(-1)?.meta).toMatchObject({ index: MAX_PERSISTED_HISTORY_ENTRIES + 2 });
	});

	it("creates deep-cloned snapshots including nested history metadata", () => {
		const state = applyPersistedDetails(createTodoState(), {
			todos: [
				createPersistedTodo(1, {
					tags: ["backend"],
					blockerIds: [2],
					history: [
						{
							timestamp: FIXED_TIMESTAMP,
							type: "created",
							meta: {
								source: "seed",
								blockerIds: [2],
								context: { branch: "main" },
							},
						},
					],
				}),
			],
			nextId: 2,
			wipLimit: 3,
		});

		const snapshot = createSnapshot(state, "list");
		snapshot.todos[0]!.title = "Mutated snapshot";
		snapshot.todos[0]!.tags.push("urgent");
		snapshot.todos[0]!.blockerIds.push(9);
		const meta = snapshot.todos[0]!.history[0]!.meta;
		const context = meta?.context;
		if (
			!meta ||
			!Array.isArray(meta.blockerIds) ||
			!context ||
			Array.isArray(context) ||
			typeof context !== "object"
		) {
			throw new Error("expected nested snapshot history metadata");
		}
		meta.blockerIds.push(9);
		(context as Record<string, unknown>).branch = "feature";

		expect(state.todos[0]).toMatchObject({
			title: "Todo 1",
			tags: ["backend"],
			blockerIds: [2],
			history: [
				{
					meta: {
						source: "seed",
						blockerIds: [2],
						context: { branch: "main" },
					},
				},
			],
		});
	});
});
