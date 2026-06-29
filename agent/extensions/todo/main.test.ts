import { expect, test } from "bun:test";
import { TODOS_COMPLETIONS } from "./main";

test("todos completions list all accepted subcommands", () => {
	expect(TODOS_COMPLETIONS.map((s) => s.value)).toEqual([
		"ready", "all", "todo", "in-progress", "done", "widget",
	]);
});

test("todos completions filter by prefix", () => {
	const results = TODOS_COMPLETIONS.filter((s) => s.value.startsWith("in"));
	expect(results.map((s) => s.value)).toEqual(["in-progress"]);
});

test("todos completions return nothing for unrecognised prefix", () => {
	expect(TODOS_COMPLETIONS.filter((s) => s.value.startsWith("xyz"))).toEqual([]);
});
