import { expect, test } from "bun:test";
import { __test__ } from "./index";

test("mcp completions list all accepted subcommands", () => {
	expect(__test__.MCP_COMPLETIONS.map((s) => s.value)).toEqual(["status"]);
});

test("mcp completions filter by prefix", () => {
	const results = __test__.MCP_COMPLETIONS.filter((s) => s.value.startsWith("st"));
	expect(results.map((s) => s.value)).toEqual(["status"]);
});

test("mcp completions return nothing for unrecognised prefix", () => {
	expect(__test__.MCP_COMPLETIONS.filter((s) => s.value.startsWith("xyz"))).toEqual([]);
});
