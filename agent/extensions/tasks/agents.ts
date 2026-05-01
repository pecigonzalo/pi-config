/**
 * Agent/profile/model-tier discovery and configuration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type SystemPromptMode = "append" | "replace";
export type AgentAvailability = "main" | "task" | "both";
export type ConfigSource = "user" | "project";
export type ContextMode = "fresh" | "fork";

export interface ContextDefaults {
	mode?: ContextMode;
	project?: boolean;
	skills?: boolean;
	/**
	 * Internal parse marker used to surface invalid configured mode values.
	 * Not a supported user-facing config key.
	 */
	invalidModeValue?: unknown;
	/**
	 * Internal parse marker used to surface malformed configured context values.
	 * Not a supported user-facing config key.
	 */
	invalidShapeValue?: unknown;
}

export interface AgentConfig {
	name: string;
	description: string;
	displayName?: string;
	enabled: boolean;
	availability: AgentAvailability;
	defaultProfile?: string;
	defaultModelTier?: string;
	defaultSkills?: string[];
	tools?: string[];
	model?: string;
	systemPromptMode: SystemPromptMode;
	context?: ContextDefaults;
	persist?: boolean;
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
	systemPrompt: string;
	source: ConfigSource;
	filePath: string;
}

export interface ProfileConfig {
	name: string;
	description: string;
	displayName?: string;
	enabled: boolean;
	tools?: string[];
	context?: ContextDefaults;
	persist?: boolean;
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
	permissionsProfile?: string;
	systemPromptMode: SystemPromptMode;
	systemPrompt: string;
	source: ConfigSource;
	filePath: string;
}

export interface ModelTierConfig {
	name: string;
	description?: string;
	model: string;
	provider?: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	source: ConfigSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

export interface ProfileDiscoveryResult {
	profiles: ProfileConfig[];
	projectProfilesDir: string | null;
}

export interface ModelTierDiscoveryResult {
	modelTiers: ModelTierConfig[];
	projectModelTiersFile: string | null;
}

export interface TasksConfigDefaults {
	context?: ContextDefaults;
	persist?: boolean;
	source: ConfigSource;
	filePath: string;
}

export interface ResourceDiscoveryResult {
	agents: AgentConfig[];
	profiles: ProfileConfig[];
	modelTiers: ModelTierConfig[];
	globalTasksConfig: TasksConfigDefaults | null;
	projectTasksConfig: TasksConfigDefaults | null;
	globalTasksFile: string;
	projectTasksFile: string | null;
	projectAgentsDir: string | null;
	projectProfilesDir: string | null;
	projectModelTiersFile: string | null;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["true", "yes", "1", "on"].includes(normalized)) return true;
		if (["false", "no", "0", "off"].includes(normalized)) return false;
	}
	return fallback;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["true", "yes", "1", "on"].includes(normalized)) return true;
		if (["false", "no", "0", "off"].includes(normalized)) return false;
	}
	return undefined;
}

function parseContextMode(value: unknown): ContextMode | undefined {
	return value === "fresh" || value === "fork" ? value : undefined;
}

function parseContextDefaults(value: unknown, hasValue = false): ContextDefaults | undefined {
	if (!hasValue) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { invalidShapeValue: value };
	}
	const record = value as Record<string, unknown>;
	const mode = parseContextMode(record.mode);
	const project = parseOptionalBoolean(record.project);
	const skills = parseOptionalBoolean(record.skills);
	const invalidModeValue =
		Object.prototype.hasOwnProperty.call(record, "mode") && mode === undefined && record.mode !== undefined
			? record.mode
			: undefined;
	if (mode === undefined && project === undefined && skills === undefined && invalidModeValue === undefined) return undefined;
	return {
		...(mode !== undefined ? { mode } : {}),
		...(project !== undefined ? { project } : {}),
		...(skills !== undefined ? { skills } : {}),
		...(invalidModeValue !== undefined ? { invalidModeValue } : {}),
	};
}

function parseString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function parseCsvList(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const items = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
		return items.length > 0 ? items : undefined;
	}
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "none") return [];
	const items = value.split(",").map((item) => item.trim()).filter(Boolean);
	return items.length > 0 ? items : undefined;
}

function parseAvailability(value: unknown): AgentAvailability | undefined {
	return value === "main" || value === "task" || value === "both" ? value : undefined;
}

function parseSystemPromptMode(value: unknown): SystemPromptMode {
	return value === "replace" ? "replace" : "append";
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function isFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function findNearestProjectDir(cwd: string, parts: string[]): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ...parts);
		if (isDirectory(candidate) || isFile(candidate)) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	const result = findNearestProjectDir(cwd, [".pi", "agents"]);
	return result && isDirectory(result) ? result : null;
}

function findNearestProjectProfilesDir(cwd: string): string | null {
	const result = findNearestProjectDir(cwd, [".pi", "profiles"]);
	return result && isDirectory(result) ? result : null;
}

function findNearestProjectModelTiersFile(cwd: string): string | null {
	const result = findNearestProjectDir(cwd, [".pi", "model-tiers.json"]);
	return result && isFile(result) ? result : null;
}

function findNearestProjectTasksFile(cwd: string): string | null {
	const result = findNearestProjectDir(cwd, [".pi", "tasks.json"]);
	return result && isFile(result) ? result : null;
}

function findAncestorDirs(cwd: string, parts: string[]): string[] {
	const dirs: string[] = [];
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ...parts);
		if (isDirectory(candidate)) dirs.push(candidate);
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}
	return dirs;
}

function expandHome(inputPath: string): string {
	if (inputPath === "~") return os.homedir();
	if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
	return inputPath;
}

function readSettingsSkillPaths(settingsPath: string): string[] {
	if (!isFile(settingsPath)) return [];
	try {
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const parsed = JSON.parse(raw) as { skills?: unknown };
		if (!Array.isArray(parsed.skills)) return [];
		const baseDir = path.dirname(settingsPath);
		return parsed.skills
			.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
			.map((entry) => expandHome(entry))
			.map((entry) => (path.isAbsolute(entry) ? entry : path.resolve(baseDir, entry)));
	} catch {
		return [];
	}
}

function getConfiguredSkillPaths(cwd: string): string[] {
	const paths: string[] = [];
	const globalSettings = path.join(getAgentDir(), "settings.json");
	paths.push(...readSettingsSkillPaths(globalSettings));

	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "settings.json");
		paths.push(...readSettingsSkillPaths(candidate));
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	return Array.from(new Set(paths));
}

function getSkillRoots(cwd: string): string[] {
	const roots = [
		path.join(getAgentDir(), "skills"),
		path.join(os.homedir(), ".agents", "skills"),
		...findAncestorDirs(cwd, [".pi", "skills"]),
		...findAncestorDirs(cwd, [".agents", "skills"]),
		...getConfiguredSkillPaths(cwd),
	];
	return Array.from(new Set(roots.filter((root) => isDirectory(root) || isFile(root))));
}

function findSkillInDirectory(root: string, skillName: string): string | null {
	const directDir = path.join(root, skillName);
	if (isDirectory(directDir) && isFile(path.join(directDir, "SKILL.md"))) {
		return directDir;
	}

	const directFile = path.join(root, `${skillName}.md`);
	if (isFile(directFile)) return directFile;

	const stack = [root];
	const visited = new Set<string>();
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (visited.has(current)) continue;
		visited.add(current);

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const entryPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === skillName && isFile(path.join(entryPath, "SKILL.md"))) return entryPath;
				stack.push(entryPath);
			} else if (entry.isFile() && entry.name === `${skillName}.md`) {
				return entryPath;
			}
		}
	}

	return null;
}

function loadMarkdownConfigs<TConfig>(
	dir: string,
	source: ConfigSource,
	parse: (frontmatter: Record<string, unknown>, body: string, filePath: string, source: ConfigSource) => TConfig | null,
): TConfig[] {
	const results: TConfig[] = [];
	if (!isDirectory(dir)) return results;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return results;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
		const parsed = parse(frontmatter, body, filePath, source);
		if (parsed) results.push(parsed);
	}

	return results;
}

function parseAgentConfig(
	frontmatter: Record<string, unknown>,
	body: string,
	filePath: string,
	source: ConfigSource,
): AgentConfig | null {
	const name = parseString(frontmatter.name);
	const description = parseString(frontmatter.description);
	const availability = parseAvailability(frontmatter.availability);
	if (!name || !description || !availability) return null;
	return {
		name,
		description,
		displayName: parseString(frontmatter.displayName ?? frontmatter.display_name),
		enabled: parseBoolean(frontmatter.enabled, true),
		availability,
		defaultProfile: parseString(frontmatter.defaultProfile ?? frontmatter.profile),
		defaultModelTier: parseString(frontmatter.defaultModelTier ?? frontmatter.modelTier),
		defaultSkills: parseCsvList(frontmatter.defaultSkills ?? frontmatter.skills),
		tools: parseCsvList(frontmatter.tools),
		model: parseString(frontmatter.model),
		systemPromptMode: parseSystemPromptMode(frontmatter.systemPromptMode),
		context: parseContextDefaults(frontmatter.context, Object.prototype.hasOwnProperty.call(frontmatter, "context")),
		persist: parseOptionalBoolean(frontmatter.persist),
		inheritProjectContext:
			frontmatter.inheritProjectContext === undefined ? undefined : parseBoolean(frontmatter.inheritProjectContext, false),
		inheritSkills: frontmatter.inheritSkills === undefined ? undefined : parseBoolean(frontmatter.inheritSkills, false),
		systemPrompt: body,
		source,
		filePath,
	};
}

function parseProfileConfig(
	frontmatter: Record<string, unknown>,
	body: string,
	filePath: string,
	source: ConfigSource,
): ProfileConfig | null {
	const name = parseString(frontmatter.name);
	const description = parseString(frontmatter.description);
	if (!name || !description) return null;
	return {
		name,
		description,
		displayName: parseString(frontmatter.displayName ?? frontmatter.display_name),
		enabled: parseBoolean(frontmatter.enabled, true),
		tools: parseCsvList(frontmatter.tools),
		context: parseContextDefaults(frontmatter.context, Object.prototype.hasOwnProperty.call(frontmatter, "context")),
		persist: parseOptionalBoolean(frontmatter.persist),
		inheritProjectContext:
			frontmatter.inheritProjectContext === undefined ? undefined : parseBoolean(frontmatter.inheritProjectContext, false),
		inheritSkills: frontmatter.inheritSkills === undefined ? undefined : parseBoolean(frontmatter.inheritSkills, false),
		permissionsProfile: parseString(frontmatter.permissionsProfile ?? frontmatter.permissions ?? frontmatter.permissionProfile),
		systemPromptMode: parseSystemPromptMode(frontmatter.systemPromptMode),
		systemPrompt: body,
		source,
		filePath,
	};
}

function loadAgentsFromDir(dir: string, source: ConfigSource): AgentConfig[] {
	return loadMarkdownConfigs(dir, source, parseAgentConfig);
}

function loadProfilesFromDir(dir: string, source: ConfigSource): ProfileConfig[] {
	return loadMarkdownConfigs(dir, source, parseProfileConfig);
}

function readJsonFile(filePath: string): unknown | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return undefined;
	}
}

function parseModelTierEntries(raw: unknown, filePath: string, source: ConfigSource): ModelTierConfig[] {
	const entries = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const results: ModelTierConfig[] = [];
	for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
		if (!value || typeof value !== "object") continue;
		const record = value as Record<string, unknown>;
		const model = parseString(record.model);
		if (!model) continue;
		results.push({
			name,
			description: parseString(record.description),
			model,
			provider: parseString(record.provider),
			thinkingLevel: record.thinkingLevel as ModelTierConfig["thinkingLevel"],
			source,
			filePath,
		});
	}
	return results;
}

function loadModelTiersFromFile(filePath: string, source: ConfigSource): ModelTierConfig[] {
	if (!isFile(filePath)) return [];
	const raw = readJsonFile(filePath);
	return parseModelTierEntries(raw, filePath, source);
}

function parseTasksConfig(raw: unknown, filePath: string, source: ConfigSource): TasksConfigDefaults | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	const hasContext = Object.prototype.hasOwnProperty.call(record, "context");
	const parsedContext = parseContextDefaults(record.context, hasContext);
	const legacyProjectContext = parseOptionalBoolean(record.inheritProjectContext);
	const legacySkills = parseOptionalBoolean(record.inheritSkills);
	const mode = parsedContext?.mode;
	const invalidModeValue = parsedContext?.invalidModeValue;
	const invalidShapeValue = parsedContext?.invalidShapeValue;
	const project = parsedContext?.project ?? legacyProjectContext;
	const skills = parsedContext?.skills ?? legacySkills;
	const context =
		mode === undefined && project === undefined && skills === undefined && invalidModeValue === undefined && invalidShapeValue === undefined
			? undefined
			: {
					...(mode !== undefined ? { mode } : {}),
					...(project !== undefined ? { project } : {}),
					...(skills !== undefined ? { skills } : {}),
					...(invalidModeValue !== undefined ? { invalidModeValue } : {}),
					...(invalidShapeValue !== undefined ? { invalidShapeValue } : {}),
				};
	const persist = parseOptionalBoolean(record.persist);
	return {
		...(context ? { context } : {}),
		...(persist !== undefined ? { persist } : {}),
		source,
		filePath,
	};
}

function loadTasksConfigFromFile(filePath: string, source: ConfigSource): TasksConfigDefaults | null {
	if (!isFile(filePath)) return null;
	const raw = readJsonFile(filePath);
	return parseTasksConfig(raw, filePath, source);
}

function mergeByName<T extends { name: string }>(items: T[], scope: AgentScope): T[] {
	const map = new Map<string, T>();
	for (const item of items) map.set(item.name, item);
	return Array.from(map.values());
}

export function resolveSkillPaths(skillNames: string[], cwd: string): { paths: string[]; missing: string[] } {
	const roots = getSkillRoots(cwd);
	const resolvedPaths: string[] = [];
	const missing: string[] = [];

	for (const skillName of skillNames) {
		let resolved: string | null = null;
		for (const root of roots) {
			if (isFile(root)) {
				if (path.basename(root) === `${skillName}.md` || path.basename(path.dirname(root)) === skillName) {
					resolved = root;
					break;
				}
				continue;
			}
			resolved = findSkillInDirectory(root, skillName);
			if (resolved) break;
		}
		if (resolved) resolvedPaths.push(resolved);
		else missing.push(skillName);
	}

	return { paths: Array.from(new Set(resolvedPaths)), missing };
}

export function discoverResources(cwd: string, scope: AgentScope): ResourceDiscoveryResult {
	const userAgentsDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const userProfilesDir = path.join(getAgentDir(), "profiles");
	const projectProfilesDir = findNearestProjectProfilesDir(cwd);
	const userModelTiersFile = path.join(getAgentDir(), "model-tiers.json");
	const projectModelTiersFile = findNearestProjectModelTiersFile(cwd);
	const globalTasksFile = path.join(getAgentDir(), "tasks.json");
	const projectTasksFile = findNearestProjectTasksFile(cwd);

	const includeUser = scope !== "project";
	const includeProject = scope !== "user";

	const userAgents = includeUser ? loadAgentsFromDir(userAgentsDir, "user") : [];
	const projectAgents = includeProject && projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, "project") : [];
	const userProfiles = includeUser ? loadProfilesFromDir(userProfilesDir, "user") : [];
	const projectProfiles = includeProject && projectProfilesDir ? loadProfilesFromDir(projectProfilesDir, "project") : [];
	const userModelTiers = includeUser ? loadModelTiersFromFile(userModelTiersFile, "user") : [];
	const projectModelTiers = includeProject && projectModelTiersFile ? loadModelTiersFromFile(projectModelTiersFile, "project") : [];
	const globalTasksConfig = loadTasksConfigFromFile(globalTasksFile, "user");
	const projectTasksConfig = projectTasksFile ? loadTasksConfigFromFile(projectTasksFile, "project") : null;

	const agents = scope === "both" ? mergeByName([...userAgents, ...projectAgents], scope) : mergeByName([...(scope === "user" ? userAgents : projectAgents)], scope);
	const profiles = scope === "both" ? mergeByName([...userProfiles, ...projectProfiles], scope) : mergeByName([...(scope === "user" ? userProfiles : projectProfiles)], scope);
	const modelTiers = scope === "both" ? mergeByName([...userModelTiers, ...projectModelTiers], scope) : mergeByName([...(scope === "user" ? userModelTiers : projectModelTiers)], scope);

	return {
		agents,
		profiles,
		modelTiers,
		globalTasksConfig,
		projectTasksConfig,
		globalTasksFile,
		projectTasksFile,
		projectAgentsDir,
		projectProfilesDir,
		projectModelTiersFile,
	};
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const resources = discoverResources(cwd, scope);
	return { agents: resources.agents, projectAgentsDir: resources.projectAgentsDir };
}

export function discoverProfiles(cwd: string, scope: AgentScope): ProfileDiscoveryResult {
	const resources = discoverResources(cwd, scope);
	return { profiles: resources.profiles, projectProfilesDir: resources.projectProfilesDir };
}

export function discoverModelTiers(cwd: string, scope: AgentScope): ModelTierDiscoveryResult {
	const resources = discoverResources(cwd, scope);
	return { modelTiers: resources.modelTiers, projectModelTiersFile: resources.projectModelTiersFile };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}, ${a.availability}${a.enabled ? "" : ", disabled"}): ${a.description}`).join("; "),
		remaining,
	};
}
