import * as os from "node:os";
import * as path from "node:path";
import type { Rule } from "./shared";

const SKILLS_TOOLS = ["read", "grep", "find", "ls"] as const;
const PACKAGE_DIRECTORY_TOOLS = ["grep", "find"] as const;
const PATH_SEPARATOR_PATTERN = "[/\\\\]";
// Hooks and config are handled by protected-resources.ts, which also maps them into sandbox denies.
const OTHER_GIT_METADATA_MATCH = `(?:^|${PATH_SEPARATOR_PATTERN})\\.git${PATH_SEPARATOR_PATTERN}(?!hooks${PATH_SEPARATOR_PATTERN}|config$)`;

const GIT_METADATA_INVARIANTS: Rule[] = [
	{ tool: "write", match: OTHER_GIT_METADATA_MATCH, action: "block", reason: "Git internals" },
	{ tool: "edit", match: OTHER_GIT_METADATA_MATCH, action: "block", reason: "Git internals" },
];

function escapeRegexLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getUserSkillsPathMatch(): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
	const skillsPath = path.join(home, ".agents", "skills");
	return `^${escapeRegexLiteral(skillsPath)}(?:${PATH_SEPARATOR_PATTERN}|$)`;
}

function getPackageResourceMatch(packageDir: string, resourcePattern: string): string {
	return `^${escapeRegexLiteral(packageDir)}${PATH_SEPARATOR_PATTERN}${resourcePattern}`;
}

function getPackageDirectoryPattern(directory: string): string {
	return `${escapeRegexLiteral(directory)}(?:${PATH_SEPARATOR_PATTERN}|$)`;
}

export interface BuiltinPermissionRules {
	/** Enforced before user-configured rules; cannot be overridden by `default.rules`. */
	invariants: Rule[];
	/** Safe defaults; user-configured rules take precedence. */
	defaults: Rule[];
}

/** Returns permission rules for resources that the agent runtime needs by default. */
export function getBuiltinPermissionRules(piPackageDir?: string): BuiltinPermissionRules {
	const skillsMatch = getUserSkillsPathMatch();
	const defaults: Rule[] = SKILLS_TOOLS.map((tool) => ({
		tool,
		match: skillsMatch,
		action: "allow",
		externalPathAction: "allow",
	}));

	if (piPackageDir) {
		const docsPattern = getPackageDirectoryPattern("docs");
		const examplesPattern = getPackageDirectoryPattern("examples");
		defaults.push(
			{
				tool: "read",
				match: getPackageResourceMatch(
					piPackageDir,
					`(?:README\\.md|CHANGELOG\\.md|${docsPattern}|${examplesPattern})`,
				),
				action: "allow",
				externalPathAction: "allow",
			},
			...PACKAGE_DIRECTORY_TOOLS.map((tool) => ({
				tool,
				match: getPackageResourceMatch(piPackageDir, `(?:${docsPattern}|${examplesPattern})`),
				action: "allow" as const,
				externalPathAction: "allow" as const,
			})),
			{
				tool: "ls",
				match: `^${escapeRegexLiteral(piPackageDir)}(?:$|${PATH_SEPARATOR_PATTERN}(?:docs|examples)(?:${PATH_SEPARATOR_PATTERN}.*)?$)`,
				action: "allow",
				externalPathAction: "allow",
			},
		);
	}

	return { invariants: GIT_METADATA_INVARIANTS, defaults };
}
