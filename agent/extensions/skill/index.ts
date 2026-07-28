import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_SKILL_BYTES = 50 * 1024;

const SkillParams = Type.Object(
	{
		name: Type.String({
			description: "Discovered skill name to load, for example 'role-architect'",
		}),
	},
	{ additionalProperties: false },
);

interface LoadedSkillRecord {
	name: string;
	description?: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation?: boolean;
}

interface SkillToolDetails {
	name?: string;
	path?: string;
	baseDir?: string;
	description?: string;
	disableModelInvocation?: boolean;
	truncated?: boolean;
}

interface SkillLookup {
	byCanonicalName: Map<string, LoadedSkillRecord>;
	byLookupKey: Map<string, LoadedSkillRecord>;
}

function normalizeSkillName(name: string): string {
	return name
		.trim()
		.replace(/^skill:/i, "")
		.trim()
		.toLowerCase();
}

function normalizePathKey(filePath: string): string {
	return path.resolve(filePath).replace(/\\/g, "/").toLowerCase();
}

function isPathLike(value: string): boolean {
	return value.includes("/") || value.includes("\\") || value.endsWith(".md") || value.endsWith(".MD");
}

function inferSkillName(filePath: string): string {
	if (/[/\\]SKILL\.md$/i.test(filePath)) {
		return path.basename(path.dirname(filePath));
	}
	return path.basename(filePath, path.extname(filePath));
}

function makeNameLookupKey(name: string): string {
	return `name:${normalizeSkillName(name)}`;
}

function makePathLookupKey(filePath: string): string {
	return `path:${normalizePathKey(filePath)}`;
}

function addLookupEntry(
	lookup: SkillLookup,
	key: string,
	skill: LoadedSkillRecord,
	mode: "force" | "if-missing" = "if-missing",
): void {
	if (mode === "if-missing" && lookup.byLookupKey.has(key)) return;
	lookup.byLookupKey.set(key, skill);
}

function createSkillLookup(records: LoadedSkillRecord[]): SkillLookup {
	const lookup: SkillLookup = {
		byCanonicalName: new Map<string, LoadedSkillRecord>(),
		byLookupKey: new Map<string, LoadedSkillRecord>(),
	};

	for (const record of records) {
		const canonicalName = makeNameLookupKey(record.name);
		lookup.byCanonicalName.set(canonicalName, record);
		addLookupEntry(lookup, canonicalName, record, "force");
	}

	for (const record of records) {
		addLookupEntry(lookup, makeNameLookupKey(inferSkillName(record.filePath)), record);
		addLookupEntry(lookup, makePathLookupKey(record.filePath), record);
		addLookupEntry(lookup, makePathLookupKey(record.baseDir), record);
	}

	return lookup;
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf-8") <= maxBytes) {
		return { text, truncated: false };
	}

	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.floor((low + high + 1) / 2);
		if (Buffer.byteLength(text.slice(0, mid), "utf-8") <= maxBytes) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}

	return { text: text.slice(0, low), truncated: true };
}

function formatSkillContent(skill: LoadedSkillRecord, content: string, truncated: boolean): string {
	const parts = [`Loaded skill: ${skill.name}`, `Path: ${skill.filePath}`, `Base directory: ${skill.baseDir}`];

	if (skill.description) {
		parts.push(`Description: ${skill.description}`);
	}

	parts.push(`References are relative to ${skill.baseDir}.`);
	parts.push("");
	parts.push(content);

	if (truncated) {
		parts.push("");
		parts.push(
			`[Output truncated at ${MAX_SKILL_BYTES / 1024}KB. Use read(path: "${skill.filePath}", offset: ...) if you need more.]`,
		);
	}

	return parts.join("\n");
}

function shortenPath(filePath: string | undefined): string {
	if (!filePath) return "(unknown path)";
	const home = process.env.HOME;
	if (home && filePath.startsWith(home)) {
		return `~${filePath.slice(home.length)}`;
	}
	return filePath;
}

function getSummaryText(result: { details?: SkillToolDetails }, fallbackName?: string): string {
	const details = result.details;
	const name = details?.name ?? fallbackName ?? "(unknown skill)";
	const pathText = shortenPath(details?.path);
	let summary = `Loaded skill ${name}`;
	if (details?.disableModelInvocation) {
		summary += " [explicit-only]";
	}
	summary += `\n${pathText}`;
	return summary;
}

function resolveSkillRecord(lookup: SkillLookup, requestedName: string, cwd: string): LoadedSkillRecord | null {
	const byName = lookup.byLookupKey.get(makeNameLookupKey(requestedName));
	if (byName) return byName;

	if (!isPathLike(requestedName)) return null;
	const requestedPath = path.isAbsolute(requestedName) ? requestedName : path.resolve(cwd, requestedName);

	return (
		lookup.byLookupKey.get(makePathLookupKey(requestedPath)) ??
		lookup.byLookupKey.get(makePathLookupKey(requestedName)) ??
		null
	);
}

function extractLoadedSkills(skills: unknown[] | undefined): LoadedSkillRecord[] {
	const result: LoadedSkillRecord[] = [];

	for (const skill of skills ?? []) {
		if (!skill || typeof skill !== "object") continue;
		const candidate = skill as Partial<LoadedSkillRecord>;
		if (typeof candidate.name !== "string") continue;
		if (typeof candidate.filePath !== "string") continue;
		if (typeof candidate.baseDir !== "string") continue;

		result.push({
			name: candidate.name,
			description: typeof candidate.description === "string" ? candidate.description : undefined,
			filePath: candidate.filePath,
			baseDir: candidate.baseDir,
			disableModelInvocation:
				typeof candidate.disableModelInvocation === "boolean" ? candidate.disableModelInvocation : undefined,
		});
	}

	return result;
}

export const __test__ = {
	createSkillLookup,
	resolveSkillRecord,
	extractLoadedSkills,
	inferSkillName,
	normalizeSkillName,
};

export default function skillExtension(pi: ExtensionAPI) {
	let skillLookup: SkillLookup = createSkillLookup([]);

	pi.on("before_agent_start", async (event) => {
		skillLookup = createSkillLookup(extractLoadedSkills(event.systemPromptOptions.skills));
	});

	pi.registerTool({
		name: "skill",
		label: "Skill",
		description:
			'Load a discovered skill by name. Compatibility shim for prompts and harnesses that use skill(name: "..."). Returns the skill instructions plus path metadata.',
		promptSnippet: 'Load a discovered skill by name for compatibility with skill(name: "...") conventions.',
		promptGuidelines: [
			'Use `skill` when a prompt or skill document explicitly references `skill(name: "...")`.',
			"Prefer `skill` over manual path hunting when you know the skill name but not its file path.",
			"Use `read` for direct file access when you already know the exact path to SKILL.md or a related file.",
		],
		parameters: SkillParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const requestedName = params.name.trim();
			if (!requestedName) {
				throw new Error("Skill name is required.");
			}

			const skill = resolveSkillRecord(skillLookup, requestedName, ctx.cwd);
			if (!skill) {
				const available = Array.from(skillLookup.byCanonicalName.values())
					.map((entry) => entry.name)
					.sort((a, b) => a.localeCompare(b));
				const suffix = available.length > 0 ? ` Available loaded skills: ${available.join(", ")}.` : "";
				throw new Error(`Skill not found: ${requestedName}.${suffix}`);
			}

			try {
				const rawContent = await fs.readFile(skill.filePath, "utf-8");
				const truncated = truncateUtf8(rawContent, MAX_SKILL_BYTES);
				return {
					content: [{ type: "text", text: formatSkillContent(skill, truncated.text, truncated.truncated) }],
					details: {
						name: skill.name,
						path: skill.filePath,
						baseDir: skill.baseDir,
						description: skill.description,
						disableModelInvocation: skill.disableModelInvocation,
						truncated: truncated.truncated,
					},
				};
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Failed to load skill ${requestedName}: ${message}`);
			}
		},

		renderCall(args, theme) {
			const requestedName = typeof args.name === "string" ? args.name.trim() : "";
			const name = requestedName || "...";
			return new Text(theme.fg("toolTitle", theme.bold("skill")) + " " + theme.fg("accent", name), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as SkillToolDetails | undefined;
			const text = result.content[0];
			const fallbackName =
				text?.type === "text" ? text.text.match(/^Loaded skill: (.+)$/m)?.[1]?.trim() : undefined;
			return new Text(theme.fg("success", getSummaryText({ details }, fallbackName)), 0, 0);
		},
	});
}
