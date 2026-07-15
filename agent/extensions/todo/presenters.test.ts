import { describe, expect, it } from "bun:test";
import { buildTodoBrowserRows, buildTodoPanelRows, listText } from "./presenters";
import { applyPersistedDetails, createTodoState } from "./state";

const FIXED_TIMESTAMP = "2024-01-01T00:00:00.000Z";

function createPersistedTodo(id: number, overrides: Record<string, unknown> = {}) {
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
	};
}

describe("todo presenters", () => {
	it("builds browser and panel rows without double-prefixing widget details", () => {
		const state = applyPersistedDetails(createTodoState(), {
			todos: [
				createPersistedTodo(1, { title: "Parent" }),
				createPersistedTodo(2, { title: "Child", parentId: 1, blockerIds: [3] }),
				createPersistedTodo(3, { title: "Blocker" }),
			],
			nextId: 4,
		});

		const browserRows = buildTodoBrowserRows(state, "default", false);
		expect(browserRows.map((row) => row.summary)).toEqual([
			"[○] #1 Parent med · M",
			"  └─ [○] #2 Child med · M",
			"[○] #3 Blocker med · M",
		]);
		expect(browserRows[1]?.details).toEqual(["     ↳ blocked by: #3"]);

		const panelRows = buildTodoPanelRows(state);
		expect(panelRows.map((row) => row.summary)).toEqual(browserRows.map((row) => row.summary));
		expect(panelRows[1]?.details).toEqual(["blocked by: #3"]);
		expect(panelRows[1]?.details[0]?.startsWith("↳")).toBe(false);
	});

	it("renders list text with the projected hierarchy and relationship lines", () => {
		const state = applyPersistedDetails(createTodoState(), {
			todos: [
				createPersistedTodo(1, { title: "Parent" }),
				createPersistedTodo(2, { title: "Child", parentId: 1, blockerIds: [3] }),
				createPersistedTodo(3, { title: "Blocker" }),
			],
			nextId: 4,
		});

		const rendered = listText(state, "default", false);
		expect(rendered).toContain("[○] #1 Parent med · M");
		expect(rendered).toContain("  └─ [○] #2 Child med · M");
		expect(rendered).toContain("     ↳ blocked by: #3");
		expect(rendered).toContain("[○] #3 Blocker med · M");
	});
});
