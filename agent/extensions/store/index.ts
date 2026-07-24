import { StringEnum } from "@earendil-works/pi-ai";
import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { storeDelete, storePatch, storeRead, storeWrite } from "./store";

const StoreStatusSchema = StringEnum(["active", "archived", "deprecated"] as const, {
	description: "Store item lifecycle status.",
});

const StoreReadParams = Type.Object(
	{
		id: Type.Optional(
			Type.String({
				description:
					"Optional: Specific item ID to retrieve (READ mode). Returns full item including data field. Omit for LIST mode.",
			}),
		),
		tags: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Optional: Filter by tags in LIST mode (AND logic - must match ALL tags). Example: ['auth', 'critical']",
			}),
		),
		includeArchived: Type.Optional(
			Type.Boolean({
				description:
					"Optional: Include archived items in LIST mode (defaults to false to hide archived items).",
			}),
		),
	},
	{ additionalProperties: false },
);

const StoreWriteParams = Type.Object({
	summary: Type.String({ minLength: 1, description: "Required: Concise description of what is being stored" }),
	tags: Type.Array(Type.String(), {
		minItems: 1,
		description: "Required: Array of tags for discoverability (e.g., ['auth', 'critical', 'design'])",
	}),
	status: Type.Optional(StoreStatusSchema),
	links: Type.Optional(
		Type.Array(Type.String(), { description: "Optional: Array of related store item IDs or URLs" }),
	),
	data: Type.Optional(
		Type.Any({ description: "Optional: Structured payload containing the actual data to persist" }),
	),
});

const StorePatchParams = Type.Object({
	id: Type.String({ description: "Required: ID of the store item to update" }),
	summary: Type.Optional(
		Type.String({ minLength: 1, description: "Optional: New summary to replace the existing one" }),
	),
	tags: Type.Optional(
		Type.Array(Type.String(), { minItems: 1, description: "Optional: New tags array to replace existing tags" }),
	),
	status: Type.Optional(StoreStatusSchema),
	links: Type.Optional(
		Type.Array(Type.String(), { description: "Optional: New links array to replace existing links" }),
	),
	data: Type.Optional(Type.Any({ description: "Optional: New data payload to replace existing data" })),
});

const StoreDeleteParams = Type.Object(
	{
		id: Type.String({ description: "Required: ID of the item to delete from the store" }),
	},
	{ additionalProperties: false },
);

type Theme = {
	fg(name: string, text: string): string;
	bold(text: string): string;
};

type StoreListEntry = {
	id?: unknown;
	summary?: unknown;
	tags?: unknown;
	status?: unknown;
	links?: unknown;
	createdAt?: unknown;
	updatedAt?: unknown;
};

const MAX_SUMMARY_CHARS = 96;
const MAX_EXPANDED_ITEMS = 12;
const MAX_DATA_PREVIEW_LINES = 16;
const MAX_DATA_PREVIEW_CHARS = 2_000;

function stringifyResult(result: unknown): string {
	return JSON.stringify(result, null, 2);
}

function rootFor(ctx: ExtensionContext): string {
	return ctx.cwd || process.cwd();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function clipText(value: string, max = MAX_SUMMARY_CHARS): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= max) return normalized;
	return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function tagsText(tags: unknown): string {
	if (!Array.isArray(tags) || tags.length === 0) return "";
	return tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0).join(", ");
}

function maybeExpandHint(theme: Theme): string {
	return theme.fg("dim", ` (${keyHint("app.tools.expand", "expand")})`);
}

function renderJsonPreview(value: unknown): string {
	let text: string;
	try {
		text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	} catch {
		text = String(value);
	}

	const lines = text.split("\n");
	let truncated = false;
	let preview = lines.slice(0, MAX_DATA_PREVIEW_LINES).join("\n");
	if (lines.length > MAX_DATA_PREVIEW_LINES) truncated = true;
	if (preview.length > MAX_DATA_PREVIEW_CHARS) {
		preview = preview.slice(0, MAX_DATA_PREVIEW_CHARS);
		truncated = true;
	}
	return truncated ? `${preview}\n…` : preview;
}

function renderStoreCall(toolName: string, args: unknown, theme: Theme): Text {
	const input = isRecord(args) ? args : {};
	let text = theme.fg("toolTitle", theme.bold(toolName));

	const id = asString(input.id);
	if (id) text += " " + theme.fg("accent", id);

	const summary = asString(input.summary);
	if (summary) text += " " + theme.fg("dim", `\"${clipText(summary)}\"`);

	if (toolName === "storeread" && !id) {
		const tags = tagsText(input.tags);
		text += " " + theme.fg("muted", tags ? `list tag:${tags}` : "list");
		if (input.includeArchived === true) text += " " + theme.fg("muted", "+archived");
	}

	return new Text(text, 0, 0);
}

function resultText(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((item) => item.type === "text")
			.map((item) => item.text ?? "")
			.join("\n") ?? ""
	);
}

function itemLine(item: StoreListEntry, theme: Theme): string {
	const id = asString(item.id) ?? "(no id)";
	const summary = clipText(asString(item.summary) ?? "(no summary)");
	const tags = tagsText(item.tags);
	const status = asString(item.status);
	const suffix = [
		status && status !== "active" ? status : undefined,
		tags ? `#${tags.replace(/, /g, " #")}` : undefined,
	]
		.filter(Boolean)
		.join(" · ");
	return `${theme.fg("accent", id)} ${theme.fg("toolOutput", summary)}${suffix ? " " + theme.fg("dim", suffix) : ""}`;
}

function renderStoreReadResult(
	result: { details?: unknown; content?: Array<{ type: string; text?: string }> },
	opts: { expanded?: boolean; isPartial?: boolean },
	theme: Theme,
): Text {
	if (opts.isPartial) return new Text(theme.fg("warning", "Reading store…"), 0, 0);

	const details = isRecord(result.details) ? result.details : undefined;
	if (!details) return new Text(theme.fg("toolOutput", resultText(result) || "(no store output)"), 0, 0);

	if (Array.isArray(details.list)) {
		const list = details.list as StoreListEntry[];
		if (!opts.expanded) {
			return new Text(
				`${theme.fg("success", "✓")} ${theme.fg("toolOutput", `${list.length} store item${list.length === 1 ? "" : "s"}`)}${list.length ? maybeExpandHint(theme) : ""}`,
				0,
				0,
			);
		}

		if (list.length === 0) return new Text(theme.fg("muted", "No store items found."), 0, 0);
		const visible = list.slice(0, MAX_EXPANDED_ITEMS).map((item) => `• ${itemLine(item, theme)}`);
		if (list.length > visible.length) visible.push(theme.fg("dim", `… ${list.length - visible.length} more`));
		return new Text(visible.join("\n"), 0, 0);
	}

	if (details.found === false) {
		return new Text(theme.fg("warning", "Store item not found."), 0, 0);
	}

	if (isRecord(details.item)) {
		const item = details.item;
		const id = asString(item.id) ?? "(no id)";
		const summary = asString(item.summary) ?? "(no summary)";
		const tags = tagsText(item.tags);
		const compact = `${theme.fg("success", "✓")} ${theme.fg("accent", id)} ${theme.fg("toolOutput", clipText(summary))}${tags ? " " + theme.fg("dim", `#${tags.replace(/, /g, " #")}`) : ""}${maybeExpandHint(theme)}`;
		if (!opts.expanded) return new Text(compact, 0, 0);

		const lines = [`${theme.fg("success", "✓")} ${theme.fg("accent", id)}`, theme.fg("toolOutput", summary)];
		const status = asString(item.status);
		if (status) lines.push(theme.fg("dim", `status: ${status}`));
		if (tags) lines.push(theme.fg("dim", `tags: ${tags}`));
		if (Array.isArray(item.links) && item.links.length)
			lines.push(theme.fg("dim", `links: ${item.links.join(", ")}`));
		if ("data" in item) {
			lines.push("");
			lines.push(theme.fg("muted", "data preview:"));
			lines.push(theme.fg("toolOutput", renderJsonPreview(item.data)));
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	return new Text(theme.fg("toolOutput", resultText(result) || "(no store output)"), 0, 0);
}

function renderMutationResult(
	verb: "stored" | "patched" | "deleted",
	result: { details?: unknown; content?: Array<{ type: string; text?: string }> },
	opts: { isPartial?: boolean },
	theme: Theme,
): Text {
	if (opts.isPartial) return new Text(theme.fg("warning", `${verb[0]?.toUpperCase()}${verb.slice(1)}…`), 0, 0);
	const details = isRecord(result.details) ? result.details : undefined;
	if (!details) return new Text(theme.fg("toolOutput", resultText(result) || "(no store output)"), 0, 0);

	const id = asString(details.id);
	if (details.success === false) {
		const error = asString(details.error) ?? "operation failed";
		return new Text(theme.fg("error", `Store ${verb} failed${id ? ` for ${id}` : ""}: ${error}`), 0, 0);
	}

	if (verb === "patched" && details.found === false) {
		return new Text(theme.fg("warning", `Store item not found${id ? `: ${id}` : ""}`), 0, 0);
	}

	if (verb === "deleted" && details.deleted === false) {
		return new Text(theme.fg("warning", `Store item not found${id ? `: ${id}` : ""}`), 0, 0);
	}

	return new Text(
		`${theme.fg("success", "✓")} ${theme.fg("toolOutput", `Store ${verb}`)}${id ? " " + theme.fg("accent", id) : ""}`,
		0,
		0,
	);
}

export default function storeExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "storeread",
		label: "Store Read",
		description:
			"Query and retrieve structured repository memories from .opencode/sessions/store. " +
			"Supports LIST mode (discovery - returns summaries without heavy data) and READ mode " +
			"(retrieval - returns the full item with data field). Always prefer LIST mode first if unsure what IDs exist.",
		promptSnippet: "Query and retrieve durable store items from .opencode/sessions/store by id or tags.",
		promptGuidelines: [
			"Use storeread whenever the user or loaded context references `Load store: <id>` or `[store:<id>]`.",
			"Use storeread without an id to discover available durable context before creating duplicate store items.",
		],
		parameters: StoreReadParams,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await storeRead(rootFor(ctx), params);
			return { content: [{ type: "text", text: stringifyResult(result) }], details: result };
		},
		renderCall(args, theme) {
			return renderStoreCall("storeread", args, theme);
		},
		renderResult(result, opts, theme) {
			return renderStoreReadResult(result, opts, theme);
		},
	});

	pi.registerTool({
		name: "storewrite",
		label: "Store Write",
		description:
			"Save durable, repository-scoped memories to .opencode/sessions/store. " +
			"Use to persist architectural decisions, data schemas, design rationale, critical context, " +
			"plans, notes, and information that must survive between agent restarts and memory pruning. " +
			"Every call creates a new item; use storepatch to update an existing item.",
		promptSnippet: "Create a durable store item with generated id, summary, tags, status, links, and data.",
		promptGuidelines: [
			"Use storewrite only for durable repository context that should survive compaction or future sessions.",
			"Do not use storewrite for temporary scratch notes or trivial reminders.",
		],
		parameters: StoreWriteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await storeWrite(rootFor(ctx), params);
			return { content: [{ type: "text", text: stringifyResult(result) }], details: result };
		},
		renderCall(args, theme) {
			return renderStoreCall("storewrite", args, theme);
		},
		renderResult(result, opts, theme) {
			return renderMutationResult("stored", result, opts, theme);
		},
	});

	pi.registerTool({
		name: "storepatch",
		label: "Store Patch",
		description:
			"Update an existing store item in place. Only provided fields are changed; omitted fields are preserved. " +
			"Use this to change status, tags, summary, links, or data on a previously created item. " +
			"Returns not-found if the ID does not exist.",
		promptSnippet: "Update an existing durable store item by id while preserving omitted fields.",
		promptGuidelines: [
			"Use storepatch rather than storewrite when amending an existing durable store item.",
			"Prefer storepatch with status `archived` or `deprecated` over storedelete when historical context may still matter.",
		],
		parameters: StorePatchParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await storePatch(rootFor(ctx), params);
			return { content: [{ type: "text", text: stringifyResult(result) }], details: result };
		},
		renderCall(args, theme) {
			return renderStoreCall("storepatch", args, theme);
		},
		renderResult(result, opts, theme) {
			return renderMutationResult("patched", result, opts, theme);
		},
	});

	pi.registerTool({
		name: "storedelete",
		label: "Store Delete",
		description:
			"Delete a stored item from .opencode/sessions/store by ID. Permanently removes the item. " +
			"Use sparingly; prefer storepatch status changes when historical context may still matter.",
		promptSnippet: "Permanently delete a durable store item by id.",
		promptGuidelines: ["Use storedelete sparingly; prefer archiving or deprecating with storepatch when possible."],
		parameters: StoreDeleteParams,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await storeDelete(rootFor(ctx), params);
			return { content: [{ type: "text", text: stringifyResult(result) }], details: result };
		},
		renderCall(args, theme) {
			return renderStoreCall("storedelete", args, theme);
		},
		renderResult(result, opts, theme) {
			return renderMutationResult("deleted", result, opts, theme);
		},
	});
}
