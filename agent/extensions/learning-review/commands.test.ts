import { expect, test } from "bun:test";
import { LEARN_COMPLETIONS } from "./commands";

test("learn completions list all accepted subcommands", () => {
	expect(LEARN_COMPLETIONS.map((s) => s.value)).toEqual([
		"review", "list", "recall", "search", "classify", "distill", "route", "accept", "reject", "status", "help",
	]);
});

test("learn completions filter by prefix", () => {
	const results = LEARN_COMPLETIONS.filter((s) => s.value.startsWith("di"));
	expect(results.map((s) => s.value)).toEqual(["distill"]);
});

test("learn completions return nothing for unrecognised prefix", () => {
	expect(LEARN_COMPLETIONS.filter((s) => s.value.startsWith("xyz"))).toEqual([]);
});
