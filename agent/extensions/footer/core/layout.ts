import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
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

interface PositionedFooterItem {
  item: FooterItem;
  placement: FooterPlacement;
}

function sortPositionedItems(items: PositionedFooterItem[]): PositionedFooterItem[] {
  return [...items].sort((left, right) => {
    const leftOrder = left.placement.order ?? 0;
    const rightOrder = right.placement.order ?? 0;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.item.id.localeCompare(right.item.id);
  });
}

function renderSection(
  items: PositionedFooterItem[],
  row: FooterRowDefinition,
  renderContext: FooterItemRenderContext,
): string {
  const parts = sortPositionedItems(items)
    .map(({ item }) => item.render(renderContext))
    .filter((part): part is string => Boolean(part));

  return parts.join(row.componentSeparator);
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

function buildRowContent(
  items: Iterable<FooterItem>,
  layout: FooterLayoutDefinition,
  row: FooterRowDefinition,
  renderContext: FooterItemRenderContext,
): string {
  const positionedItems = collectRowItems(items, layout, row);
  const sections = new Map<FooterSection, PositionedFooterItem[]>();

  for (const positioned of positionedItems) {
    const sectionItems = sections.get(positioned.placement.section) ?? [];
    sectionItems.push(positioned);
    sections.set(positioned.placement.section, sectionItems);
  }

  const left = LEFT_SECTIONS.map((section) => renderSection(sections.get(section) ?? [], row, renderContext))
    .filter(Boolean)
    .join(row.sectionSeparator);
  const right = RIGHT_SECTIONS.map((section) => renderSection(sections.get(section) ?? [], row, renderContext))
    .filter(Boolean)
    .join(row.rightSectionSeparator ?? row.sectionSeparator);

  if (left && right) return `${left}\u0000${right}`;
  return left || right;
}

function fitRowContent(content: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return " ";

  const contentWidth = Math.max(0, width - 2);
  if (!content.includes("\u0000")) {
    const single = truncateToWidth(content, contentWidth);
    return ` ${single}`.padEnd(width, " ");
  }

  const [rawLeft, rawRight] = content.split("\u0000", 2);
  const left = rawLeft ?? "";
  const right = rawRight ?? "";

  if (contentWidth <= 0) return " ".repeat(width);

  const rightWidth = visibleWidth(right);
  if (rightWidth >= contentWidth) {
    return ` ${truncateToWidth(right, contentWidth)}`.padEnd(width, " ");
  }

  const maxLeftWidth = Math.max(0, contentWidth - rightWidth - 1);
  const fittedLeft = truncateToWidth(left, maxLeftWidth);
  const gapWidth = Math.max(1, contentWidth - visibleWidth(fittedLeft) - rightWidth);
  const combined = `${fittedLeft}${" ".repeat(gapWidth)}${right}`;

  return ` ${truncateToWidth(combined, contentWidth)}`.padEnd(width, " ");
}

export function renderFooterLines(
  items: Iterable<FooterItem>,
  layout: FooterLayoutDefinition,
  renderContext: Omit<FooterItemRenderContext, "rowId" | "width">,
  width: number,
): string[] {
  const itemList = [...items];

  return [...layout.rows]
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    .map((row) => {
      const content = buildRowContent(itemList, layout, row, { ...renderContext, rowId: row.id, width });
      return fitRowContent(content || "", width);
    });
}
