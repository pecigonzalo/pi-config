/**
 * Skill Preservation Extension
 *
 * Keeps track of skill usage so we can inject a one-time reminder after compaction.
 *
 * Tracking sources:
 *   - successful read tool results for skill files
 *   - successful skill tool results
 *   - expanded /skill:<name> blocks in user messages
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface SkillRecord {
	name: string;
	path?: string;
	baseDir?: string;
}

interface KnownSkillIndex {
	list: SkillRecord[];
	byName: Map<string, SkillRecord>;
	byPath: Map<string, SkillRecord>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeSkillName(name: string): string {
	return name
		.trim()
		.replace(/^skill:/i, "")
		.trim()
		.toLowerCase();
}

function normalizePath(filePath: string): string {
	return filePath.replace(/\\/g, "/").toLowerCase();
}

function isSkillMdPath(filePath: string): boolean {
	return /[/\\]SKILL\.md$/i.test(filePath);
}

function inferSkillNameFromPath(filePath: string): string | null {
	const normalized = filePath.replace(/\\/g, "/");
	if (isSkillMdPath(normalized)) {
		const parentDir = path.basename(path.dirname(normalized));
		return parentDir || null;
	}

	if (!/\.md$/i.test(normalized)) return null;
	const fileName = path.basename(normalized, path.extname(normalized));
	return fileName || null;
}

function makeActiveSkillKey(skill: SkillRecord): string {
	if (skill.path) return `path:${normalizePath(skill.path)}`;
	return `name:${normalizeSkillName(skill.name)}`;
}

function mergeSkillRecord(previous: SkillRecord | undefined, next: SkillRecord): SkillRecord {
	if (!previous) return next;
	return {
		name: previous.name || next.name,
		path: previous.path ?? next.path,
		baseDir: previous.baseDir ?? next.baseDir,
	};
}

function addActiveSkill(activeSkills: Map<string, SkillRecord>, skill: SkillRecord): void {
	const key = makeActiveSkillKey(skill);
	activeSkills.set(key, mergeSkillRecord(activeSkills.get(key), skill));
}

function toKnownSkill(value: unknown): SkillRecord | null {
	if (!isRecord(value)) return null;
	if (typeof value.name !== "string") return null;
	if (typeof value.filePath !== "string") return null;
	if (typeof value.baseDir !== "string") return null;
	return {
		name: value.name,
		path: value.filePath,
		baseDir: value.baseDir,
	};
}

function buildKnownSkillIndex(skills: unknown[] | undefined): KnownSkillIndex {
	const list: SkillRecord[] = [];
	const byName = new Map<string, SkillRecord>();
	const byPath = new Map<string, SkillRecord>();

	for (const skill of skills ?? []) {
		const known = toKnownSkill(skill);
		if (!known) continue;
		list.push(known);
		if (!byName.has(normalizeSkillName(known.name))) {
			byName.set(normalizeSkillName(known.name), known);
		}
		byPath.set(normalizePath(known.path ?? ""), known);
	}

	return { list, byName, byPath };
}

function findKnownSkillByPath(index: KnownSkillIndex, filePath: string): SkillRecord | null {
	const normalized = normalizePath(filePath);
	const exact = index.byPath.get(normalized);
	if (exact) return exact;

	const suffixMatches = index.list.filter((entry) => {
		if (!entry.path) return false;
		const candidate = normalizePath(entry.path);
		return candidate.endsWith(`/${normalized}`) || normalized.endsWith(`/${candidate}`);
	});
	if (suffixMatches.length === 1) return suffixMatches[0] ?? null;

	const fileName = path.basename(normalized);
	const byName = suffixMatches.filter((entry) => entry.path && path.basename(normalizePath(entry.path)) === fileName);
	if (byName.length === 1) return byName[0] ?? null;

	return null;
}

function resolveSkillFromReadPath(filePath: string, knownSkills: KnownSkillIndex): SkillRecord | null {
	const known = findKnownSkillByPath(knownSkills, filePath);
	if (known) return known;

	if (!isSkillMdPath(filePath)) return null;
	const inferredName = inferSkillNameFromPath(filePath);
	if (!inferredName) return null;

	return {
		name: inferredName,
		path: filePath,
		baseDir: path.dirname(filePath),
	};
}

function extractAttributeValue(attributes: string, attribute: string): string | undefined {
	const pattern = new RegExp(`${attribute}="([^"]+)"`, "i");
	return attributes.match(pattern)?.[1]?.trim();
}

function extractSkillBlocksFromText(text: string, knownSkills: KnownSkillIndex): SkillRecord[] {
	const records: SkillRecord[] = [];
	const blockRegex = /<skill\b([^>]*)>/gi;

	for (const match of text.matchAll(blockRegex)) {
		const attributes = match[1] ?? "";
		const name = extractAttributeValue(attributes, "name");
		const location = extractAttributeValue(attributes, "location");

		const byPath = location ? findKnownSkillByPath(knownSkills, location) : null;
		const byName = name ? (knownSkills.byName.get(normalizeSkillName(name)) ?? null) : null;
		const resolved = byPath ?? byName;
		const resolvedName = name ?? resolved?.name ?? (location ? inferSkillNameFromPath(location) : null);
		if (!resolvedName) continue;

		const resolvedPath = location ?? resolved?.path;
		records.push({
			name: resolvedName,
			path: resolvedPath,
			baseDir: resolved?.baseDir ?? (resolvedPath ? path.dirname(resolvedPath) : undefined),
		});
	}

	return records;
}

function extractTextParts(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter((part): part is { type: string; text?: unknown } => isRecord(part) && typeof part.type === "string")
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string);
}

function extractSkillFromSkillToolResult(
	details: unknown,
	content: unknown,
	knownSkills: KnownSkillIndex,
): SkillRecord | null {
	let name: string | undefined;
	let filePath: string | undefined;
	let baseDir: string | undefined;

	if (isRecord(details)) {
		if (typeof details.name === "string") name = details.name;
		if (typeof details.path === "string") filePath = details.path;
		if (typeof details.baseDir === "string") baseDir = details.baseDir;
	}

	if (!name || !filePath) {
		const text = extractTextParts(content).join("\n");
		if (!name) {
			name = text.match(/^Loaded skill:\s*(.+)$/m)?.[1]?.trim();
		}
		if (!filePath) {
			filePath = text.match(/^Path:\s*(.+)$/m)?.[1]?.trim();
		}
		if (!baseDir) {
			baseDir = text.match(/^Base directory:\s*(.+)$/m)?.[1]?.trim();
		}
	}

	const knownByPath = filePath ? findKnownSkillByPath(knownSkills, filePath) : null;
	const knownByName = name ? (knownSkills.byName.get(normalizeSkillName(name)) ?? null) : null;
	const known = knownByPath ?? knownByName;

	const resolvedName = name ?? known?.name ?? (filePath ? inferSkillNameFromPath(filePath) : null);
	if (!resolvedName) return null;
	const resolvedPath = filePath ?? known?.path;

	return {
		name: resolvedName,
		path: resolvedPath,
		baseDir: baseDir ?? known?.baseDir ?? (resolvedPath ? path.dirname(resolvedPath) : undefined),
	};
}

function extractReadPathFromInput(input: unknown): string | null {
	if (!isRecord(input)) return null;
	const filePath = input.path ?? input.file_path;
	return typeof filePath === "string" ? filePath : null;
}

function reconstructActiveSkills(entries: readonly unknown[], knownSkills: KnownSkillIndex): Map<string, SkillRecord> {
	const activeSkills = new Map<string, SkillRecord>();
	const readToolCallPaths = new Map<string, string>();

	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		const message = entry.message;
		if (message.role === "assistant") {
			if (!Array.isArray(message.content)) continue;
			for (const part of message.content) {
				if (!isRecord(part) || part.type !== "toolCall" || part.name !== "read") continue;
				const toolCallId = typeof part.id === "string" ? part.id : null;
				const filePath = extractReadPathFromInput(part.arguments);
				if (!toolCallId || !filePath) continue;
				readToolCallPaths.set(toolCallId, filePath);
			}
			continue;
		}

		if (message.role === "user") {
			for (const text of extractTextParts(message.content)) {
				for (const block of extractSkillBlocksFromText(text, knownSkills)) {
					addActiveSkill(activeSkills, block);
				}
			}
			continue;
		}

		if (message.role !== "toolResult" || message.isError === true || typeof message.toolName !== "string") continue;

		if (message.toolName === "read") {
			const directPath = extractReadPathFromInput((message as Record<string, unknown>).input);
			const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : null;
			const filePath = directPath ?? (toolCallId ? (readToolCallPaths.get(toolCallId) ?? null) : null);
			if (!filePath) continue;
			const resolved = resolveSkillFromReadPath(filePath, knownSkills);
			if (resolved) addActiveSkill(activeSkills, resolved);
			continue;
		}

		if (message.toolName === "skill") {
			const resolved = extractSkillFromSkillToolResult(message.details, message.content, knownSkills);
			if (resolved) addActiveSkill(activeSkills, resolved);
		}
	}

	return activeSkills;
}

function buildSkillPreservationNotice(skills: SkillRecord[]): string {
	const lines = skills
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((skill) => (skill.path ? `  - ${skill.name}: ${skill.path}` : `  - ${skill.name}`));

	return [
		"",
		"---",
		"**Skill Preservation Notice**: Skills used before the last compaction may still be relevant.",
		'Reload them if needed using `skill(name: "...")` or `read(path: "...")`:',
		...lines,
		"---",
	].join("\n");
}

export const __test__ = {
	inferSkillNameFromPath,
	buildKnownSkillIndex,
	findKnownSkillByPath,
	resolveSkillFromReadPath,
	extractSkillBlocksFromText,
	extractSkillFromSkillToolResult,
	reconstructActiveSkills,
	buildSkillPreservationNotice,
};

export default function (pi: ExtensionAPI) {
	const activeSkills = new Map<string, SkillRecord>();
	let knownSkills = buildKnownSkillIndex([]);
	let pendingReload = false;

	function resetFromBranch(ctx: ExtensionContext): void {
		activeSkills.clear();
		const rebuilt = reconstructActiveSkills(ctx.sessionManager.getBranch(), knownSkills);
		for (const [key, value] of rebuilt) activeSkills.set(key, value);
	}

	pi.on("session_start", async (_event, ctx) => {
		pendingReload = false;
		resetFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		resetFromBranch(ctx);
	});

	pi.on("tool_result", async (event, _ctx) => {
		if (event.isError) return undefined;

		if (event.toolName === "read") {
			const filePath = extractReadPathFromInput(event.input);
			if (!filePath) return undefined;
			const resolved = resolveSkillFromReadPath(filePath, knownSkills);
			if (resolved) addActiveSkill(activeSkills, resolved);
			return undefined;
		}

		if (event.toolName === "skill") {
			const resolved = extractSkillFromSkillToolResult(event.details, event.content, knownSkills);
			if (resolved) addActiveSkill(activeSkills, resolved);
		}

		return undefined;
	});

	pi.on("message_end", async (event, _ctx) => {
		if (!isRecord(event.message) || event.message.role !== "user") return undefined;

		for (const text of extractTextParts(event.message.content)) {
			for (const block of extractSkillBlocksFromText(text, knownSkills)) {
				addActiveSkill(activeSkills, block);
			}
		}

		return undefined;
	});

	pi.on("session_compact", async (_event, ctx) => {
		resetFromBranch(ctx);
		if (activeSkills.size > 0) {
			pendingReload = true;
		}
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		knownSkills = buildKnownSkillIndex(event.systemPromptOptions.skills);
		if (!pendingReload || activeSkills.size === 0) return undefined;

		pendingReload = false;
		const note = buildSkillPreservationNotice(Array.from(activeSkills.values()));
		return {
			systemPrompt: event.systemPrompt + note,
		};
	});
}
