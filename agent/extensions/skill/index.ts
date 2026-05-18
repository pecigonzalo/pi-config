import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolveSkillPaths } from "../tasks/agents.js";

const MAX_SKILL_BYTES = 50 * 1024;

const SkillParams = Type.Object({
	name: Type.String({
		description: "Discovered skill name to load, for example 'role-architect'",
	}),
});

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

function normalizeSkillName(name: string): string {
	return name.trim().replace(/^skill:/i, "").trim().toLowerCase();
}

function inferSkillName(filePath: string): string {
	if (/[/\\]SKILL\.md$/i.test(filePath)) {
		return path.basename(path.dirname(filePath));
	}
	return path.basename(filePath, path.extname(filePath));
}

async function normalizeResolvedSkillPath(resolvedPath: string): Promise<{ filePath: string; baseDir: string }> {
	try {
		const stat = await fs.stat(resolvedPath);
		if (stat.isDirectory()) {
			return {
				filePath: path.join(resolvedPath, "SKILL.md"),
				baseDir: resolvedPath,
			};
		}
	} catch {
		// Fall back to treating the resolved path as a file.
	}

	return {
		filePath: resolvedPath,
		baseDir: path.dirname(resolvedPath),
	};
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
	const parts = [
		`Loaded skill: ${skill.name}`,
		`Path: ${skill.filePath}`,
		`Base directory: ${skill.baseDir}`,
	];

	if (skill.description) {
		parts.push(`Description: ${skill.description}`);
	}

	parts.push(`References are relative to ${skill.baseDir}.`);
	parts.push("");
	parts.push(content);

	if (truncated) {
		parts.push("");
		parts.push(`[Output truncated at ${MAX_SKILL_BYTES / 1024}KB. Use read(path: \"${skill.filePath}\", offset: ...) if you need more.]`);
	}

	return parts.join("\n");
}

function getSkillFromPromptState(
	loadedSkills: Map<string, LoadedSkillRecord>,
	requestedName: string,
): LoadedSkillRecord | null {
	const normalized = normalizeSkillName(requestedName);
	return loadedSkills.get(normalized) ?? null;
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

async function resolveSkillRecord(
	loadedSkills: Map<string, LoadedSkillRecord>,
	requestedName: string,
	cwd: string,
): Promise<LoadedSkillRecord | null> {
	const fromPrompt = getSkillFromPromptState(loadedSkills, requestedName);
	if (fromPrompt) {
		return fromPrompt;
	}

	const normalizedName = normalizeSkillName(requestedName);
	const { paths, missing } = resolveSkillPaths([normalizedName], cwd);
	if (missing.length > 0 || paths.length === 0) {
		return null;
	}

	const normalizedPath = await normalizeResolvedSkillPath(paths[0]);
	return {
		name: inferSkillName(normalizedPath.filePath),
		filePath: normalizedPath.filePath,
		baseDir: normalizedPath.baseDir,
	};
}

export default function skillExtension(pi: ExtensionAPI) {
	const loadedSkills = new Map<string, LoadedSkillRecord>();

	pi.on("before_agent_start", async (event) => {
		loadedSkills.clear();
		for (const skill of event.systemPromptOptions.skills ?? []) {
			if (!skill || typeof skill !== "object") continue;
			const candidate = skill as Partial<LoadedSkillRecord>;
			if (typeof candidate.name !== "string") continue;
			if (typeof candidate.filePath !== "string") continue;
			if (typeof candidate.baseDir !== "string") continue;

			loadedSkills.set(normalizeSkillName(candidate.name), {
				name: candidate.name,
				description: typeof candidate.description === "string" ? candidate.description : undefined,
				filePath: candidate.filePath,
				baseDir: candidate.baseDir,
				disableModelInvocation:
					typeof candidate.disableModelInvocation === "boolean"
						? candidate.disableModelInvocation
						: undefined,
			});
		}
	});

	pi.registerTool({
		name: "skill",
		label: "Skill",
		description:
			"Load a discovered skill by name. Compatibility shim for prompts and harnesses that use skill(name: \"...\"). Returns the skill instructions plus path metadata.",
		promptSnippet: "Load a discovered skill by name for compatibility with skill(name: \"...\") conventions.",
		promptGuidelines: [
			"Use `skill` when a prompt or skill document explicitly references `skill(name: \"...\")`.",
			"Prefer `skill` over manual path hunting when you know the skill name but not its file path.",
			"Use `read` for direct file access when you already know the exact path to SKILL.md or a related file.",
		],
		parameters: SkillParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const requestedName = params.name.trim();
			if (!requestedName) {
				throw new Error("Skill name is required.");
			}

			const skill = await resolveSkillRecord(loadedSkills, requestedName, ctx.cwd);
			if (!skill) {
				const available = Array.from(loadedSkills.values())
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
			return new Text(
				theme.fg("toolTitle", theme.bold("skill")) + " " + theme.fg("accent", name),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as SkillToolDetails | undefined;
			const text = result.content[0];
			const fallbackName =
				text?.type === "text"
					? text.text.match(/^Loaded skill: (.+)$/m)?.[1]?.trim()
					: undefined;
			return new Text(theme.fg("success", getSummaryText({ details }, fallbackName)), 0, 0);
		},
	});
}
