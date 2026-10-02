import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import todoExtension, { TODOS_COMPLETIONS, TODO_PROMPT_GUIDELINES, TODO_QUERY_PROMPT_GUIDELINES } from "./main";

test("todos completions list all accepted subcommands", () => {
	expect(TODOS_COMPLETIONS.map((s) => s.value)).toEqual(["ready", "all", "todo", "in-progress", "done", "widget"]);
});

test("todos completions filter by prefix", () => {
	const results = TODOS_COMPLETIONS.filter((s) => s.value.startsWith("in"));
	expect(results.map((s) => s.value)).toEqual(["in-progress"]);
});

test("todos completions return nothing for unrecognised prefix", () => {
	expect(TODOS_COMPLETIONS.filter((s) => s.value.startsWith("xyz"))).toEqual([]);
});

test("todo prompt guidelines describe action-specific parameters", () => {
	const guidelines = TODO_PROMPT_GUIDELINES.join(" ");

	expect(guidelines).toContain("Send only the fields listed for the selected action");
	expect(guidelines).toContain("toggle with id (required) and optional toStatus only");
	expect(guidelines).toContain("Never send priority or effort to toggle");
	expect(guidelines).toContain("never send toStatus to update");
});

test("query guidelines point at the read-only tool", () => {
	const guidelines = TODO_QUERY_PROMPT_GUIDELINES.join(" ");

	expect(guidelines).toContain("never modifies state");
	expect(guidelines).toContain("list with only view, includeArchived, status, or tag");
});

test("registers a sequential mutation tool and a read-only query tool", () => {
	const tools: Array<{ name: string; executionMode?: string; annotations?: { readOnlyHint?: boolean } }> = [];
	const entryRenderers: string[] = [];
	const pi = {
		on: () => () => {},
		registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
		registerCommand: () => {},
		registerEntryRenderer: (customType: string) => entryRenderers.push(customType),
	} as unknown as ExtensionAPI;

	todoExtension(pi);

	expect(tools.find((tool) => tool.name === "todo")?.executionMode).toBe("sequential");
	expect(tools.find((tool) => tool.name === "todo_query")?.annotations?.readOnlyHint).toBe(true);
	expect(entryRenderers).toEqual(["todo-state", "todo-widget-state"]);
});
