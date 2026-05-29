import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	TodoBrowserComponent,
	type TodoBrowserAction,
	type TodoBrowserKeybindings,
	type TodoBrowserRow,
} from "./components";
import type { TodoItem } from "./types";

const testTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

type TodoBrowserKeybinding = Parameters<TodoBrowserKeybindings["matches"]>[1];

const keyMap: Record<TodoBrowserKeybinding, string> = {
	"tui.select.up": "up",
	"tui.select.down": "down",
	"tui.select.pageUp": "pageUp",
	"tui.select.pageDown": "pageDown",
	"tui.select.confirm": "enter",
	"tui.select.cancel": "escape",
};

const testKeybindings: TodoBrowserKeybindings = {
	matches(data: string, keybinding: TodoBrowserKeybinding): boolean {
		return data === keyMap[keybinding];
	},
};

function createTodo(id: number): TodoItem {
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
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
	};
}

function createRow(id: number, details: string[] = []): TodoBrowserRow {
	return {
		todo: createTodo(id),
		summary: `[○] #${id} Todo ${id}`,
		details,
		selectedLabel: `selected #${id}`,
	};
}

function createBrowser(rows: TodoBrowserRow[], onAction: (action: TodoBrowserAction) => void = () => {}) {
	return new TodoBrowserComponent({
		rows,
		title: "Todos",
		theme: testTheme,
		keybindings: testKeybindings,
		getMaxLines: () => 8,
		onAction,
	});
}

describe("TodoBrowserComponent", () => {
	it("bounds long todo lists to the configured line limit", () => {
		const browser = createBrowser(Array.from({ length: 20 }, (_value, index) => createRow(index + 1)));

		const lines = browser.render(80);

		expect(lines.length).toBeLessThanOrEqual(8);
		expect(lines.join("\n")).toContain("#1 Todo 1");
		expect(lines.join("\n")).not.toContain("#20 Todo 20");
		expect(lines.join("\n")).toContain("showing 1-4 of 20");
	});

	it("scrolls to keep the selected row visible", () => {
		const browser = createBrowser(Array.from({ length: 20 }, (_value, index) => createRow(index + 1)));
		browser.render(80);

		for (let index = 0; index < 8; index++) {
			browser.handleInput("down");
		}
		const lines = browser.render(80);

		expect(lines.length).toBeLessThanOrEqual(8);
		expect(lines.join("\n")).toContain("selected #9");
		expect(lines.join("\n")).toContain("#9 Todo 9");
		expect(lines.join("\n")).not.toContain("#1 Todo 1");
	});

	it("supports page navigation using select keybindings", () => {
		const browser = createBrowser(Array.from({ length: 20 }, (_value, index) => createRow(index + 1)));
		browser.render(80);

		browser.handleInput("pageDown");
		expect(browser.render(80).join("\n")).toContain("selected #4");

		browser.handleInput("pageUp");
		expect(browser.render(80).join("\n")).toContain("selected #1");
	});

	it("emits actions for selected todos", () => {
		const actions: TodoBrowserAction[] = [];
		const browser = createBrowser([createRow(1), createRow(2)], (action) => actions.push(action));

		browser.handleInput("down");
		browser.handleInput("enter");
		browser.handleInput("t");
		browser.handleInput("a");
		browser.handleInput("escape");

		expect(actions).toEqual([
			{ type: "read", id: 2 },
			{ type: "toggle", id: 2 },
			{ type: "archive", id: 2 },
			{ type: "close" },
		]);
	});
});
