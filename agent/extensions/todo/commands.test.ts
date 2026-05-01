import { describe, expect, it } from "bun:test";
import { parseTodoWidgetMode, parseTodosCommandArgs, parseTodosCommandRoute } from "./commands";

describe("parseTodosCommandRoute", () => {
	it("routes widget subcommand", () => {
		expect(parseTodosCommandRoute("widget")).toEqual({ kind: "widget", widgetArgs: "" });
		expect(parseTodosCommandRoute("widget on")).toEqual({ kind: "widget", widgetArgs: "on" });
	});

	it("routes list mode by default", () => {
		expect(parseTodosCommandRoute("")).toEqual({ kind: "list", listArgs: "" });
		expect(parseTodosCommandRoute("ready tag:backend")).toEqual({ kind: "list", listArgs: "ready tag:backend" });
	});
});

describe("parseTodosCommandArgs", () => {
	it("parses view + filters", () => {
		const parsed = parseTodosCommandArgs("ready all in_progress tag:backend");
		expect(parsed.view).toBe("ready");
		expect(parsed.includeArchived).toBe(true);
		expect(parsed.status).toBe("in-progress");
		expect(parsed.tag).toBe("backend");
		expect(parsed.invalidTokens).toEqual([]);
	});

	it("captures invalid tokens", () => {
		const parsed = parseTodosCommandArgs("tree unknown foo");
		expect(parsed.view).toBe("tree");
		expect(parsed.invalidTokens).toEqual(["unknown", "foo"]);
	});
});

describe("parseTodoWidgetMode", () => {
	it("supports toggle aliases", () => {
		expect(parseTodoWidgetMode("toggle")).toEqual({ mode: "toggle" });
		expect(parseTodoWidgetMode("")).toEqual({ mode: "toggle" });
		expect(parseTodoWidgetMode("show")).toEqual({ mode: "on" });
		expect(parseTodoWidgetMode("hide")).toEqual({ mode: "off" });
	});

	it("returns error for unsupported mode", () => {
		const parsed = parseTodoWidgetMode("maybe");
		expect(parsed.error).toContain("Unsupported mode");
	});
});
