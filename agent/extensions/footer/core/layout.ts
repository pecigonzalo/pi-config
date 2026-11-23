import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
	FooterItem,
	FooterItemRenderContext,
	FooterLayoutDefinition,
	FooterPlacement,
	FooterRowDefinition,
	FooterSection,
} from "./types";

const LEFT_SECTIONS: FooterSection[] = ["a", "b", "c"];
const RIGHT_SECTIONS: FooterSection[] = ["x", "y", "z"];
const ELLIPSIS = "…";

interface PositionedFooterItem {
	item: FooterItem;
	placement: FooterPlacement;
}

interface RenderedFooterItem extends PositionedFooterItem {
	text: string;
}

function sortPositionedItems<T extends PositionedFooterItem>(items: T[]): T[] {
	return [...items].sort((left, right) => {
		const leftOrder = left.placement.order ?? 0;
		const rightOrder = right.placement.order ?? 0;
		if (leftOrder !== rightOrder) return leftOrder - rightOrder;
		return left.item.id.localeCompare(right.item.id);
	});
}

function renderSection(items: RenderedFooterItem[], row: FooterRowDefinition): string {
	return sortPositionedItems(items)
		.map(({ text }) => text)
		.join(row.itemSeparator);
}

function collectRowItems(
	items: Iterable<FooterItem>,
	layout: FooterLayoutDefinition,
	row: FooterRowDefinition,
): PositionedFooterItem[] {
	const positioned: PositionedFooterItem[] = [];
	for (const item of items) {
		const placement = item.getPlacement(layout.name);
		if (!placement || placement.row !== row.id) continue;
		positioned.push({ item, placement });
	}
	return positioned;
}

function renderRowItems(
	items: Iterable<FooterItem>,
	layout: FooterLayoutDefinition,
	row: FooterRowDefinition,
	renderContext: FooterItemRenderContext,
): RenderedFooterItem[] {
	const rendered: RenderedFooterItem[] = [];

	for (const positioned of collectRowItems(items, layout, row)) {
		const text = positioned.item.render(renderContext);
		if (!text) continue;

		const maxWidth = positioned.placement.maxWidth;
		rendered.push({ ...positioned, text: maxWidth ? truncateToWidth(text, maxWidth, ELLIPSIS) : text });
	}

	return rendered;
}

function composeSections(rendered: RenderedFooterItem[], row: FooterRowDefinition): { left: string; right: string } {
	const sections = new Map<FooterSection, RenderedFooterItem[]>();

	for (const positioned of rendered) {
		const sectionItems = sections.get(positioned.placement.section) ?? [];
		sectionItems.push(positioned);
		sections.set(positioned.placement.section, sectionItems);
	}

	const left = LEFT_SECTIONS.map((section) => renderSection(sections.get(section) ?? [], row))
		.filter(Boolean)
		.join(row.sectionSeparator);
	const right = RIGHT_SECTIONS.map((section) => renderSection(sections.get(section) ?? [], row))
		.filter(Boolean)
		.join(row.rightSectionSeparator ?? row.sectionSeparator);

	return { left, right };
}

function priorityOf(placement: FooterPlacement): number {
	return placement.priority ?? 0;
}

function fitsWithin(left: string, right: string, contentWidth: number): boolean {
	if (left && right) return visibleWidth(left) + 1 + visibleWidth(right) <= contentWidth;
	return visibleWidth(left || right) <= contentWidth;
}

/**
 * Drop whole priority tiers until the row fits. The highest-priority tier is
 * always kept, so a row never disappears; if even that tier is too wide the
 * caller falls back to truncation.
 */
function fitByPriority(
	rendered: RenderedFooterItem[],
	row: FooterRowDefinition,
	contentWidth: number,
): { left: string; right: string } {
	const priorities = [...new Set(rendered.map(({ placement }) => priorityOf(placement)))].sort(
		(left, right) => left - right,
	);
	let active = rendered;

	for (let dropped = 0; ; dropped++) {
		const composed = composeSections(active, row);
		if (fitsWithin(composed.left, composed.right, contentWidth)) return composed;
		if (dropped >= priorities.length - 1) return composed;

		const droppedPriority = priorities[dropped];
		active = active.filter(({ placement }) => priorityOf(placement) !== droppedPriority);
	}
}

function padRight(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function fitRowContent(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	if (width === 1) return " ";

	const contentWidth = Math.max(0, width - 2);
	if (contentWidth <= 0) return " ".repeat(width);
	if (!left && !right) return " ".repeat(width);
	if (!right) return padRight(` ${truncateToWidth(left, contentWidth)}`, width);
	if (!left) return padRight(` ${truncateToWidth(right, contentWidth)}`, width);

	const rightWidth = visibleWidth(right);
	if (rightWidth >= contentWidth) {
		return padRight(` ${truncateToWidth(right, contentWidth)}`, width);
	}

	const maxLeftWidth = Math.max(0, contentWidth - rightWidth - 1);
	const fittedLeft = truncateToWidth(left, maxLeftWidth);
	const gapWidth = Math.max(1, contentWidth - visibleWidth(fittedLeft) - rightWidth);
	const combined = `${fittedLeft}${" ".repeat(gapWidth)}${right}`;

	return padRight(` ${truncateToWidth(combined, contentWidth)}`, width);
}

export function renderFooterLines(
	items: Iterable<FooterItem>,
	layout: FooterLayoutDefinition,
	renderContext: Omit<FooterItemRenderContext, "rowId" | "width">,
	width: number,
): string[] {
	const itemList = [...items];
	const contentWidth = Math.max(0, width - 2);

	return [...layout.rows]
		.sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
		.map((row) => {
			const rendered = renderRowItems(itemList, layout, row, { ...renderContext, rowId: row.id, width });
			const { left, right } = fitByPriority(rendered, row, contentWidth);
			return fitRowContent(left, right, width);
		});
}
