import { expect, test } from "bun:test";
import { TODOS_COMPLETIONS, TODO_PROMPT_GUIDELINES } from "./main";

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
