import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import {
	type EffectivePolicy,
	type ExternalPathPolicy,
	type PermissionMode,
	type PermissionsConfig,
	type ResolvedProtectedResources,
	type Rule,
	dedupeStrings,
} from "./shared";

export function parseJsonc(text: string): unknown {
	let noComments = "";
	let inString = false;
	let stringQuote = "";
	let escaping = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];

		if (inString) {
			noComments += ch;
			if (escaping) {
				escaping = false;
			} else if (ch === "\\") {
				escaping = true;
			} else if (ch === stringQuote) {
				inString = false;
				stringQuote = "";
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			inString = true;
			stringQuote = ch;
			noComments += ch;
			continue;
		}

		if (ch === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			if (i < text.length) noComments += "\n";
			continue;
		}

		if (ch === "/" && next === "*") {
			i += 2;
			while (i < text.length - 1 && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i++;
			continue;
		}

		noComments += ch;
	}

	let cleaned = "";
	inString = false;
	stringQuote = "";
	escaping = false;

	for (let i = 0; i < noComments.length; i++) {
		const ch = noComments[i];

		if (inString) {
			cleaned += ch;
			if (escaping) {
				escaping = false;
			} else if (ch === "\\") {
				escaping = true;
			} else if (ch === stringQuote) {
				inString = false;
				stringQuote = "";
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			inString = true;
			stringQuote = ch;
			cleaned += ch;
			continue;
		}

		if (ch === ",") {
			let j = i + 1;
			while (j < noComments.length && /\s/.test(noComments[j])) j++;
			if (j < noComments.length && (noComments[j] === "}" || noComments[j] === "]")) {
				continue;
			}
		}

		cleaned += ch;
	}

	return JSON.parse(cleaned);
}

export function readJsonFile(filePath: string): unknown | undefined {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return parseJsonc(raw);
	} catch {
		return undefined;
	}
}

export function mergeDefaultConfig(
	globalDefault: PermissionsConfig["default"] | undefined,
	projectDefault: PermissionsConfig["default"] | undefined,
): PermissionsConfig["default"] | undefined {
	if (!globalDefault && !projectDefault) return undefined;
	return {
		mode: projectDefault?.mode ?? globalDefault?.mode,
		externalPath: projectDefault?.externalPath ?? globalDefault?.externalPath,
		rules: [...(projectDefault?.rules ?? []), ...(globalDefault?.rules ?? [])],
	};
}

export function loadConfig(cwd: string): PermissionsConfig {
	const globalPath = path.join(getAgentDir(), "permissions.jsonc");
	const projectPath = path.join(cwd, ".pi", "permissions.jsonc");

	const global = readJsonFile(globalPath) as PermissionsConfig | undefined;
	const project = readJsonFile(projectPath) as PermissionsConfig | undefined;

	return {
		default: mergeDefaultConfig(global?.default, project?.default),
		agents: {
			...(global?.agents ?? {}),
			...(project?.agents ?? {}),
		},
		sandbox: {
			...(global?.sandbox ?? {}),
			...(project?.sandbox ?? {}),
		},
		approvals: {
			...(global?.approvals ?? {}),
			...(project?.approvals ?? {}),
		},
		protectedResources: {
			...(global?.protectedResources ?? {}),
			...(project?.protectedResources ?? {}),
		},
	};
}

const BUILTIN_PROTECTED_DENY_READ = [
	"\\.env(\\..+)?$",
	"\\.(pem|key|p12|pfx|crt|ca-bundle)$",
	"(^|[/])(\\.aws[/]|\\.ssh[/]|\\.gnupg[/])",
] as const;

const BUILTIN_PROTECTED_DENY_WRITE = [
	"\\.env(\\..+)?$",
	"\\.(pem|key|p12|pfx|crt|ca-bundle)$",
	"(^|[/])\\.git/(hooks/|config$)",
	"(^|[/])(\\.bashrc|\\.bash_profile|\\.zshrc|\\.zprofile|\\.profile)$",
	"(^|[/])\\.(gitconfig|gitmodules|ripgreprc|mcp\\.json)$",
	"(^|[/])(\\.vscode/|\\.idea/)",
	"(^|[/])\\.claude/(commands/|agents/)",
] as const;

export function resolveProtectedResources(config: PermissionsConfig): ResolvedProtectedResources {
	const settings = config.protectedResources ?? {};
	const enabled = settings.enabled ?? true;
	if (!enabled) return { denyRead: [], denyWrite: [] };

	const useDefaults = settings.defaults ?? true;
	const denyReadSource = [
		...(useDefaults ? BUILTIN_PROTECTED_DENY_READ : []),
		...(settings.addDenyRead ?? []),
	];
	const denyWriteSource = [
		...(useDefaults ? BUILTIN_PROTECTED_DENY_WRITE : []),
		...(settings.addDenyWrite ?? []),
	];
	const unprotectRead = new Set(settings.unprotectRead ?? []);
	const unprotectWrite = new Set(settings.unprotectWrite ?? []);

	return {
		denyRead: dedupeStrings(denyReadSource.filter((r) => !unprotectRead.has(r))),
		denyWrite: dedupeStrings(denyWriteSource.filter((r) => !unprotectWrite.has(r))),
	};
}

export function compileProtectedRules(protectedResources: ResolvedProtectedResources): Rule[] {
	const rules: Rule[] = [];
	for (const match of protectedResources.denyRead) {
		rules.push({ tool: "read", match, action: "block", reason: "Blocked by protected resource policy" });
	}
	for (const match of protectedResources.denyWrite) {
		rules.push({ tool: "write", match, action: "block", reason: "Blocked by protected resource policy" });
		rules.push({ tool: "edit", match, action: "block", reason: "Blocked by protected resource policy" });
	}
	return rules;
}

export function compileModeDefaults(mode: PermissionMode): { rules: Rule[]; externalPath: ExternalPathPolicy } {
	switch (mode) {
		case "plan":
			return {
				externalPath: "block",
				rules: [
					{ tool: "write", action: "block", reason: "Plan mode is read-only" },
					{ tool: "edit", action: "block", reason: "Plan mode is read-only" },
					{ tool: "bash", action: "ask", reason: "Plan mode requires confirmation for shell commands" },
				],
			};
		case "full-access":
			return {
				externalPath: "allow",
				rules: [],
			};
		case "workspace-write":
		default:
			return {
				externalPath: "ask",
				rules: [
					{
						tool: "bash",
						action: "ask",
						reason: "Workspace-write mode requires confirmation for shell commands unless explicitly allowed",
					},
				],
			};
	}
}

export function activePolicy(config: PermissionsConfig, agentName: string): EffectivePolicy {
	const protectedResources = resolveProtectedResources(config);
	const protectedRules = compileProtectedRules(protectedResources);
	const defaultMode = config.default?.mode ?? "workspace-write";
	const defaultCompiled = compileModeDefaults(defaultMode);
	const defaultRules = [...protectedRules, ...(config.default?.rules ?? []), ...defaultCompiled.rules];
	const defaultExternalPath = config.default?.externalPath ?? defaultCompiled.externalPath;

	if (agentName === "default" || !config.agents?.[agentName]) {
		return {
			mode: defaultMode,
			rules: defaultRules,
			externalPath: defaultExternalPath,
			protectedResources,
		};
	}

	const profile = config.agents[agentName];
	const profileMode = profile.mode ?? defaultMode;
	const profileCompiled = compileModeDefaults(profileMode);
	const profileExternalPath = profile.externalPath ?? (profile.mode ? profileCompiled.externalPath : defaultExternalPath);
	const profileRules = [...(profile.rules ?? [])];

	if (profile.inherit === false) {
		return {
			mode: profileMode,
			rules: [...protectedRules, ...profileRules, ...profileCompiled.rules],
			externalPath: profileExternalPath,
			protectedResources,
		};
	}

	return {
		mode: profileMode,
		rules: [...protectedRules, ...profileRules, ...(config.default?.rules ?? []), ...(profile.mode ? profileCompiled.rules : defaultCompiled.rules)],
		externalPath: profileExternalPath,
		protectedResources,
	};
}
