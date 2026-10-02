import { describe, expect, it } from "bun:test";
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
