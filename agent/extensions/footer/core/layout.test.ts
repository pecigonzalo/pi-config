import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderFooterLines } from "./layout";
import type { FooterItem, FooterLayoutDefinition, FooterLayoutName, FooterSection } from "./types";

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const layout: FooterLayoutDefinition = {
	name: "default",
	rows: [{ id: "context", order: 10, itemSeparator: " | ", sectionSeparator: " · ", rightSectionSeparator: " ❮ " }],
};

type RenderContext = Parameters<typeof renderFooterLines>[2];

function renderContext(): RenderContext {
	return { ctx: undefined, theme, layoutName: "default" } as unknown as RenderContext;
}

function item(id: string, section: FooterSection, order: number): FooterItem {
	return {
		owner: "test",
		id,
		getPlacement: (layoutName: FooterLayoutName) => ({ row: "context", section, order }),
		render: () => id,
	};
}

function sizedItem(
	id: string,
	section: FooterSection,
	text: string,
	options: { priority?: number; maxWidth?: number } = {},
): FooterItem {
	return {
		owner: "test",
		id,
		getPlacement: (layoutName: FooterLayoutName) => ({ row: "context", section, order: 10, ...options }),
		render: () => text,
	};
}

describe("footer width degradation", () => {
	it("drops the lowest-priority item when the row does not fit", () => {
		const [line] = renderFooterLines(
			[
				sizedItem("path", "a", "workspace", { priority: 100 }),
				sizedItem("statuses", "z", "idle workspace-write sandbox tree-sitter", { priority: 5 }),
			],
			layout,
			renderContext(),
			30,
		);

		expect(line?.includes("workspace")).toBe(true);
		expect(line?.includes("tree-sitter")).toBe(false);
		expect(visibleWidth(line ?? "")).toBe(30);
	});

	it("drops tiers in ascending priority until the row fits", () => {
		const items = [
			sizedItem("path", "a", "workspace-a", { priority: 100 }),
			sizedItem("model", "c", "model-name", { priority: 80 }),
			sizedItem("cost", "z", "$0.16", { priority: 10 }),
		];
		const [line] = renderFooterLines(items, layout, renderContext(), 26);

		expect(line?.includes("workspace-a")).toBe(true);
		expect(line?.includes("model-name")).toBe(true);
		expect(line?.includes("$0.16")).toBe(false);
	});

	it("keeps the highest-priority tier and truncates as a last resort", () => {
		const [line] = renderFooterLines(
			[sizedItem("path", "a", "a-very-long-workspace-name", { priority: 100 })],
			layout,
			renderContext(),
			20,
		);

		expect(visibleWidth(line ?? "")).toBe(20);
		expect(line?.startsWith(" a-very")).toBe(true);
	});

	it("truncates items at their configured maxWidth", () => {
		const [line] = renderFooterLines(
			[sizedItem("model", "a", "opencode-go/deepseek-v4.1-flash", { maxWidth: 12 })],
			layout,
			renderContext(),
			80,
		);

		const stripped = (line ?? "").replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
		expect(stripped).toBe(" opencode-go…");
	});
});

describe("footer layout rendering", () => {
	it("orders items within a section", () => {
		const [line] = renderFooterLines([item("later", "a", 20), item("first", "a", 10)], layout, renderContext(), 80);

		expect(line?.startsWith(" first | later")).toBe(true);
	});

	it("pins right-aligned sections to the right edge", () => {
		const [line] = renderFooterLines(
			[item("tokens", "x", 10), item("branch", "x", 20)],
			layout,
			renderContext(),
			80,
		);

		expect(line?.startsWith(" ")).toBe(true);
		expect(line?.trimEnd().endsWith("tokens | branch")).toBe(true);
		expect(line?.length).toBe(80);
	});

	it("renders rows in layout order", () => {
		const multiRow: FooterLayoutDefinition = {
			name: "default",
			rows: [
				{ id: "top", order: 20, itemSeparator: " ", sectionSeparator: " " },
				{ id: "main", order: 10, itemSeparator: " ", sectionSeparator: " " },
			],
		};
		const items: FooterItem[] = [
			{ ...item("top-item", "a", 10), getPlacement: () => ({ row: "top", section: "a", order: 10 }) },
			{ ...item("main-item", "a", 10), getPlacement: () => ({ row: "main", section: "a", order: 10 }) },
		];

		const lines = renderFooterLines(items, multiRow, renderContext(), 80);

		expect(lines[0]?.includes("main-item")).toBe(true);
		expect(lines[1]?.includes("top-item")).toBe(true);
	});
});
