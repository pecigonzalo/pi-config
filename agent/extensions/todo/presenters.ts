/**
 * @fileoverview Todo presentation helpers for text and interactive views.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TodoBrowserRow, TodoPanelRow } from "./components";
import type { TodoState } from "./state";
import type { TodoEffort, TodoItem, TodoPriority, TodoStatus, TodoView } from "./types";

interface TodoProjectedRow {
	todo: TodoItem;
	summaryPrefix: string;
	detailPrefix: string;
	showParent: boolean;
}

function byId(left: TodoItem, right: TodoItem): number {
	return left.id - right.id;
}

function findTodo(state: TodoState, id: number): TodoItem | undefined {
	return state.todos.find((todo) => todo.id === id);
}

export function statusLabel(status: TodoStatus): string {
	return status === "in-progress" ? "in progress" : status;
}

export function unfinishedBlockers(state: TodoState, todo: TodoItem): number[] {
	return todo.blockerIds.filter((id) => {
		const blocker = findTodo(state, id);
		return blocker !== undefined && !blocker.archived && blocker.status !== "done";
	});
}

function hasUnfinishedBlockers(state: TodoState, todo: TodoItem): boolean {
	return unfinishedBlockers(state, todo).length > 0;
}

export function filteredTodoPool(
	state: TodoState,
	view: TodoView,
	includeArchived: boolean,
	status?: TodoStatus,
	tag?: string,
): TodoItem[] {
	let pool = state.todos.filter((todo) => includeArchived || !todo.archived);
	if (status) pool = pool.filter((todo) => todo.status === status);
	if (tag) {
		const normalizedTag = tag.toLowerCase();
		pool = pool.filter((todo) => todo.tags.some((todoTag) => todoTag.toLowerCase() === normalizedTag));
	}
	pool = [...pool].sort(byId);
	if (view === "ready") return pool.filter((todo) => todo.status === "todo" && !hasUnfinishedBlockers(state, todo));
	return pool;
}

function priorityText(priority: TodoPriority): string {
	return priority;
}

function effortText(effort: TodoEffort): string {
	return effort;
}

function separator(theme?: Theme): string {
	return theme ? theme.fg("dim", " · ") : " · ";
}

function colorPriority(priority: TodoPriority, theme?: Theme): string {
	if (!theme) return priorityText(priority);
	if (priority === "high") return theme.fg("error", priorityText(priority));
	if (priority === "med") return theme.fg("warning", priorityText(priority));
	return theme.fg("success", priorityText(priority));
}

function colorEffort(effort: TodoEffort, theme?: Theme): string {
	const text = effortText(effort);
	if (!theme) return text;
	if (effort === "L") return theme.fg("warning", text);
	if (effort === "M") return theme.fg("accent", text);
	return theme.fg("muted", text);
}

function colorStatusIcon(status: TodoStatus, theme?: Theme): string {
	const icon = status === "done" ? "✓" : status === "in-progress" ? "▶" : "○";
	if (!theme) return icon;
	if (status === "done") return theme.fg("success", icon);
	if (status === "in-progress") return theme.fg("accent", icon);
	return theme.fg("muted", icon);
}

function styleTitle(todo: TodoItem, theme?: Theme): string {
	if (!theme) return todo.title;
	if (todo.status === "in-progress") return theme.fg("accent", theme.bold(todo.title));
	if (todo.status === "done") return theme.fg("success", todo.title);
	return todo.title;
}

function summaryLine(todo: TodoItem, theme?: Theme): string {
	const parts = [
		`[${colorStatusIcon(todo.status, theme)}]`,
		theme ? theme.fg("accent", `#${todo.id}`) : `#${todo.id}`,
		styleTitle(todo, theme),
	];
	const tags = todo.tags.length ? (theme ? theme.fg("dim", `[${todo.tags.join(",")}]`) : ` [${todo.tags.join(",")}]`) : "";
	const meta = [colorPriority(todo.priority, theme), colorEffort(todo.effort, theme)].join(separator(theme));
	const archived = todo.archived ? (theme ? theme.fg("dim", "archived") : "archived") : "";
	const suffix = [tags, meta, archived].filter(Boolean).join(separator(theme));
	return `${parts.join(" ")}${suffix ? ` ${suffix}` : ""}`;
}

function selectedLabel(todo: TodoItem, theme?: Theme): string {
	const idLabel = theme ? theme.fg("muted", `#${todo.id}`) : `#${todo.id}`;
	const title = styleTitle(todo, theme);
	const status = theme ? theme.fg("dim", `(${statusLabel(todo.status)})`) : `(${statusLabel(todo.status)})`;
	return `${idLabel} ${title} ${status}`;
}

function relationshipLines(
	state: TodoState,
	todo: TodoItem,
	showParent = true,
	theme?: Theme,
	includeBranchPrefix = true,
): string[] {
	const lines: string[] = [];
	const branchPrefix = includeBranchPrefix ? `${theme ? theme.fg("dim", "↳") : "↳"} ` : "";
	if (showParent && todo.parentId !== undefined) {
		const label = theme ? theme.fg("muted", "parent") : "parent";
		const parentId = theme ? theme.fg("accent", `#${todo.parentId}`) : `#${todo.parentId}`;
		lines.push(`${branchPrefix}${label}: ${parentId}`);
	}
	const blockers = unfinishedBlockers(state, todo);
	if (blockers.length) {
		const label = theme ? theme.fg("warning", "blocked by") : "blocked by";
		const refs = blockers.map((id) => (theme ? theme.fg("accent", `#${id}`) : `#${id}`)).join(", ");
		lines.push(`${branchPrefix}${label}: ${refs}`);
	}
	return lines;
}

export function buildTodoCommandTitle(
	view: TodoView,
	includeArchived: boolean,
	status?: TodoStatus,
	tag?: string,
): string {
	return `Todos${includeArchived ? " • all" : ""}${status ? ` • ${statusLabel(status)}` : ""}${tag ? ` • tag:${tag}` : ""}${view === "ready" ? " • ready" : ""}`;
}

function projectHierarchyRows(state: TodoState, pool: TodoItem[]): TodoProjectedRow[] {
	const idSet = new Set(pool.map((todo) => todo.id));
	const childMap = new Map<number, TodoItem[]>();
	for (const item of pool) {
		if (item.parentId !== undefined && idSet.has(item.parentId)) {
			const children = childMap.get(item.parentId) ?? [];
			children.push(item);
			childMap.set(item.parentId, children.sort(byId));
		}
	}

	const rows: TodoProjectedRow[] = [];
	const roots = pool.filter((todo) => todo.parentId === undefined || !idSet.has(todo.parentId)).sort(byId);
	const walk = (item: TodoItem, summaryPrefix: string, detailPrefix: string, showParent: boolean) => {
		rows.push({ todo: item, summaryPrefix, detailPrefix, showParent });
		const children = childMap.get(item.id) ?? [];
		children.forEach((child, index) => {
			const last = index === children.length - 1;
			const branch = last ? "└─ " : "├─ ";
			const trunk = last ? "   " : "│  ";
			walk(child, `${detailPrefix}${branch}`, `${detailPrefix}${trunk}`, false);
		});
	};

	for (const root of roots) {
		walk(root, "", "  ", root.parentId !== undefined && !idSet.has(root.parentId));
	}
	return rows;
}

function projectTodoRows(
	state: TodoState,
	view: TodoView,
	includeArchived: boolean,
	status?: TodoStatus,
	tag?: string,
): TodoProjectedRow[] {
	const pool = filteredTodoPool(state, view, includeArchived, status, tag);
	if (view === "ready") {
		return pool.map((todo) => ({
			todo,
			summaryPrefix: "",
			detailPrefix: "  ",
			showParent: true,
		}));
	}
	return projectHierarchyRows(state, pool);
}

export function buildTodoBrowserRows(
	state: TodoState,
	view: TodoView,
	includeArchived: boolean,
	status?: TodoStatus,
	tag?: string,
	theme?: Theme,
): TodoBrowserRow[] {
	return projectTodoRows(state, view, includeArchived, status, tag).map((row) => ({
		todo: row.todo,
		summary: `${row.summaryPrefix}${summaryLine(row.todo, theme)}`,
		details: relationshipLines(state, row.todo, row.showParent, theme, true).map((line) => `${row.detailPrefix}${line}`),
		selectedLabel: selectedLabel(row.todo, theme),
	}));
}

export function buildTodoPanelRows(state: TodoState, theme?: Theme): TodoPanelRow[] {
	return projectTodoRows(state, "default", false).map((row) => ({
		summary: `${row.summaryPrefix}${summaryLine(row.todo, theme)}`,
		details: relationshipLines(state, row.todo, row.showParent, theme, false),
	}));
}

function renderFlatTodo(state: TodoState, todo: TodoItem, indent = "  ", showParent = true): string[] {
	return [
		`${indent}${summaryLine(todo)}`,
		...relationshipLines(state, todo, showParent, undefined, true).map((line) => `${indent}  ${line}`),
	];
}

function renderHierarchy(state: TodoState, pool: TodoItem[]): string[] {
	return projectHierarchyRows(state, pool).flatMap((row) => [
		`${row.summaryPrefix}${summaryLine(row.todo)}`,
		...relationshipLines(state, row.todo, row.showParent, undefined, true).map((line) => `${row.detailPrefix}${line}`),
	]);
}

export function listText(
	state: TodoState,
	view: TodoView,
	includeArchived: boolean,
	status?: TodoStatus,
	tag?: string,
): string {
	const pool = filteredTodoPool(state, view, includeArchived, status, tag);
	if (view === "ready") {
		return pool.length ? pool.flatMap((todo) => renderFlatTodo(state, todo, "  ", true)).join("\n") : "No ready todos";
	}

	const lines = renderHierarchy(state, pool);
	return lines.length ? lines.join("\n") : "No todos";
}
