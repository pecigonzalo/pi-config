import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TodoDetailField, TodoEffort, TodoItem, TodoPriority, TodoStatus } from "./types";

export interface TodoBrowserRow {
	todo: TodoItem;
	summary: string;
	details: string[];
	selectedLabel: string;
}

export type TodoBrowserAction =
	| { type: "close" }
	| { type: "read"; id: number }
	| { type: "toggle"; id: number }
	| { type: "archive"; id: number };

export type TodoDetailAction =
	| { type: "back"; selectedField: TodoDetailField }
	| { type: "edit"; id: number; field: TodoDetailField; selectedField: TodoDetailField }
	| { type: "toggle"; id: number; selectedField: TodoDetailField }
	| { type: "archive"; id: number; selectedField: TodoDetailField };

export class TodoBrowserComponent {
	private rows: TodoBrowserRow[];
	private title: string;
	private theme: Theme;
	private onAction: (action: TodoBrowserAction) => void;
	private selectedIndex = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(rows: TodoBrowserRow[], title: string, theme: Theme, onAction: (action: TodoBrowserAction) => void) {
		this.rows = rows;
		this.title = title;
		this.theme = theme;
		this.onAction = onAction;
	}

	private getSelected(): TodoBrowserRow | undefined {
		return this.rows[this.selectedIndex];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onAction({ type: "close" });
			return;
		}

		if (this.rows.length === 0) return;

		if (matchesKey(data, "up") && this.selectedIndex > 0) {
			this.selectedIndex--;
			this.invalidate();
			return;
		}
		if (matchesKey(data, "down") && this.selectedIndex < this.rows.length - 1) {
			this.selectedIndex++;
			this.invalidate();
			return;
		}

		const selected = this.getSelected();
		if (!selected) return;

		if (matchesKey(data, "enter")) {
			this.onAction({ type: "read", id: selected.todo.id });
			return;
		}
		if (data === "t") {
			this.onAction({ type: "toggle", id: selected.todo.id });
			return;
		}
		if (data === "a") {
			this.onAction({ type: "archive", id: selected.todo.id });
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const out: string[] = [];
		out.push("");
		const title = th.fg("accent", ` ${this.title} `);
		const header = th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - this.title.length - 8)));
		out.push(truncateToWidth(header, width));
		out.push("");

		if (this.rows.length === 0) {
			out.push(truncateToWidth(`  ${th.fg("dim", "No todos")}`, width));
		} else {
			out.push(truncateToWidth(`  ${th.fg("dim", "↑↓ select · enter view · t status · a archive · esc close")}`, width));
			out.push("");
			this.rows.forEach((row, index) => {
				const selected = index === this.selectedIndex;
				const prefix = selected ? th.fg("accent", "› ") : "  ";
				const summary = truncateToWidth(`${prefix}${row.summary}`, width);
				out.push(selected ? th.bg("selectedBg", summary) : summary);

				for (const line of row.details) {
					out.push(truncateToWidth(`    ${line}`, width));
				}
			});
		}

		out.push("");
		const selected = this.getSelected();
		if (selected) {
			out.push(truncateToWidth(`  ${selected.selectedLabel}`, width));
		}
		out.push("");

		this.cachedWidth = width;
		this.cachedLines = out;
		return out;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export class TodoDetailComponent {
	private static readonly fields: TodoDetailField[] = ["title", "description", "status", "priority", "effort", "tags"];

	private todo: TodoItem;
	private theme: Theme;
	private onAction: (action: TodoDetailAction) => void;
	private selectedIndex: number;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todo: TodoItem, theme: Theme, selectedField: TodoDetailField, onAction: (action: TodoDetailAction) => void) {
		this.todo = todo;
		this.theme = theme;
		this.onAction = onAction;
		const index = TodoDetailComponent.fields.indexOf(selectedField);
		this.selectedIndex = index >= 0 ? index : 0;
	}

	private get selectedField(): TodoDetailField {
		return TodoDetailComponent.fields[this.selectedIndex] ?? "title";
	}

	private statusLabel(status: TodoStatus): string {
		return status === "in-progress" ? "in progress" : status;
	}

	private colorStatusIcon(status: TodoStatus): string {
		const icon = status === "done" ? "✓" : status === "in-progress" ? "▶" : "○";
		if (status === "done") return this.theme.fg("success", icon);
		if (status === "in-progress") return this.theme.fg("accent", icon);
		return this.theme.fg("muted", icon);
	}

	private colorPriority(priority: TodoPriority): string {
		if (priority === "high") return this.theme.fg("error", priority);
		if (priority === "med") return this.theme.fg("warning", priority);
		return this.theme.fg("success", priority);
	}

	private colorEffort(effort: TodoEffort): string {
		if (effort === "L") return this.theme.fg("warning", effort);
		if (effort === "M") return this.theme.fg("accent", effort);
		return this.theme.fg("muted", effort);
	}

	private styleTitle(title: string, status: TodoStatus): string {
		if (status === "in-progress") return this.theme.fg("accent", this.theme.bold(title));
		if (status === "done") return this.theme.fg("success", title);
		return title;
	}

	private selectPrev(): void {
		if (this.selectedIndex > 0) {
			this.selectedIndex--;
			this.invalidate();
		}
	}

	private selectNext(): void {
		if (this.selectedIndex < TodoDetailComponent.fields.length - 1) {
			this.selectedIndex++;
			this.invalidate();
		}
	}

	private renderField(width: number, label: string, value: string, selected: boolean): string[] {
		const th = this.theme;
		const prefix = selected ? th.fg("accent", "› ") : "  ";
		const header = truncateToWidth(`${prefix}${th.fg("muted", `${label}`)} ${th.fg("dim", "[editable]")}`, width);
		const valueIndent = "    ";
		const wrappedValue = wrapTextWithAnsi(value, Math.max(10, width - valueIndent.length));
		const valueLines = wrappedValue.length > 0 ? wrappedValue : [th.fg("dim", "(empty)")];
		return [
			selected ? th.bg("selectedBg", header) : header,
			...valueLines.map((line) => {
				const rendered = truncateToWidth(`${valueIndent}${line}`, width);
				return selected ? th.bg("selectedBg", rendered) : rendered;
			}),
		];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onAction({ type: "back", selectedField: this.selectedField });
			return;
		}
		if (matchesKey(data, "up")) {
			this.selectPrev();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selectNext();
			return;
		}
		if (matchesKey(data, "enter") || data === "e") {
			this.onAction({ type: "edit", id: this.todo.id, field: this.selectedField, selectedField: this.selectedField });
			return;
		}
		if (data === "t") {
			this.onAction({ type: "toggle", id: this.todo.id, selectedField: this.selectedField });
			return;
		}
		if (data === "a") {
			this.onAction({ type: "archive", id: this.todo.id, selectedField: this.selectedField });
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const out: string[] = [];
		out.push("");
		const title = th.fg("accent", ` Todo #${this.todo.id} `);
		const header = th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 17)));
		out.push(truncateToWidth(header, width));
		out.push("");
		out.push(truncateToWidth(`  ${th.fg("dim", "↑↓ select field · enter/e edit field · t cycle status · a archive · esc back")}`, width));
		out.push("");

		const rows: Array<{ field: TodoDetailField; label: string; value: string }> = [
			{ field: "title", label: "Title", value: this.styleTitle(this.todo.title, this.todo.status) },
			{
				field: "description",
				label: "Description",
				value: this.todo.description?.trim() ? this.todo.description : th.fg("dim", "(empty)"),
			},
			{ field: "status", label: "Status", value: this.colorStatusIcon(this.todo.status) + ` ${this.statusLabel(this.todo.status)}` },
			{ field: "priority", label: "Priority", value: this.colorPriority(this.todo.priority) },
			{ field: "effort", label: "Effort", value: this.colorEffort(this.todo.effort) },
			{
				field: "tags",
				label: "Tags",
				value: this.todo.tags.length ? th.fg("dim", `[${this.todo.tags.join(", ")}]`) : th.fg("dim", "(none)"),
			},
		];

		rows.forEach((row, index) => {
			out.push(...this.renderField(width, row.label, row.value, index === this.selectedIndex));
			out.push("");
		});

		out.push(truncateToWidth(`  ${th.fg("dim", "Readonly")}`, width));
		out.push(truncateToWidth(`  ${th.fg("muted", "Parent:")} ${this.todo.parentId !== undefined ? th.fg("accent", `#${this.todo.parentId}`) : th.fg("dim", "(none)")}`, width));
		out.push(
			truncateToWidth(
				`  ${th.fg("muted", "Blockers:")} ${this.todo.blockerIds.length ? this.todo.blockerIds.map((id) => th.fg("accent", `#${id}`)).join(", ") : th.fg("dim", "(none)")}`,
				width,
			),
		);
		out.push(truncateToWidth(`  ${th.fg("muted", "Archived:")} ${this.todo.archived ? th.fg("dim", "yes") : "no"}`, width));
		out.push("");

		this.cachedWidth = width;
		this.cachedLines = out;
		return out;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export interface TodoPanelRow {
	summary: string;
	details: string[];
}

export class TodoPanelWidgetComponent {
	private theme: Theme;
	private getRows: () => TodoPanelRow[];
	private title: string;
	private footer: string;

	constructor(theme: Theme, title: string, getRows: () => TodoPanelRow[], footer: string) {
		this.theme = theme;
		this.title = title;
		this.getRows = getRows;
		this.footer = footer;
	}

	render(width: number): string[] {
		const th = this.theme;
		const out: string[] = [];
		const contentWidth = Math.max(1, width - 2);
		const toWidgetLine = (content: string) => ` ${truncateToWidth(content, contentWidth)} `;

		const title = th.fg("accent", ` ${this.title} `);
		const left = th.fg("borderMuted", "──");
		const right = th.fg("borderMuted", "─".repeat(Math.max(0, contentWidth - visibleWidth(left) - visibleWidth(title))));
		out.push(toWidgetLine(`${left}${title}${right}`));

		const rows = this.getRows();
		if (rows.length === 0) {
			out.push(toWidgetLine(th.fg("dim", "No active todos")));
			out.push(toWidgetLine(th.fg("dim", this.footer)));
			return out;
		}

		const maxRows = Math.max(3, Math.min(8, rows.length));
		for (const row of rows.slice(0, maxRows)) {
			out.push(toWidgetLine(row.summary));
			for (const line of row.details) {
				out.push(toWidgetLine(`${th.fg("dim", "↳")} ${line}`));
			}
		}

		if (rows.length > maxRows) {
			out.push(toWidgetLine(th.fg("dim", `… +${rows.length - maxRows} more`)));
		}
		out.push(toWidgetLine(th.fg("dim", this.footer)));
		return out;
	}

	invalidate(): void {}
}
