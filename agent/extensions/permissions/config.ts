import * as fs from "node:fs";
import * as os from "node:os";
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

export function escapeRegexLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function findPiPackageDirFrom(candidate: string | undefined): string | undefined {
	if (!candidate) return undefined;
	let dir = candidate;
	try {
		dir = fs.statSync(candidate).isDirectory() ? candidate : path.dirname(candidate);
	} catch {
		dir = path.dirname(candidate);
	}

	while (dir !== path.dirname(dir)) {
		const packageJsonPath = path.join(dir, "package.json");
		try {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { name?: string };
			if (pkg.name === "@mariozechner/pi-coding-agent") return dir;
		} catch {
			// Keep walking upward.
		}
		dir = path.dirname(dir);
	}

	return undefined;
}

export function getInterpolationVariables(): Record<string, string | undefined> {
	const vars: Record<string, string | undefined> = { ...process.env };
	vars.HOME ??= os.homedir();
	vars.PI_PACKAGE_DIR ??= findPiPackageDirFrom(process.argv[1]) ?? findPiPackageDirFrom(process.execPath);
	return vars;
}

export function interpolateEnvString(value: string, options: { regex?: boolean } = {}): string {
	const vars = getInterpolationVariables();
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
		const name = braced ?? bare;
		const raw = vars[name];
		if (raw === undefined || raw === "") return match;
		const expanded = expandHome(raw);
		return options.regex ? escapeRegexLiteral(expanded) : expanded;
	});
}

function interpolateStringArray(values: string[] | undefined, options?: { regex?: boolean }): string[] | undefined {
	return values?.map((value) => interpolateEnvString(value, options));
}

export function interpolateConfig(config: PermissionsConfig): PermissionsConfig {
	const interpolateRules = (rules: Rule[] | undefined): Rule[] | undefined =>
		rules?.map((rule) => ({
			...rule,
			match: rule.match === undefined ? undefined : interpolateEnvString(rule.match, { regex: true }),
		}));
	const interpolateProfile = <T extends { rules?: Rule[]; tmpDir?: string }>(profile: T | undefined): T | undefined => {
		if (!profile) return undefined;
		return {
			...profile,
			rules: interpolateRules(profile.rules),
			tmpDir: profile.tmpDir === undefined ? undefined : interpolateEnvString(profile.tmpDir),
		};
	};
	const interpolateProfileMap = (profiles: PermissionsConfig["profiles"]): PermissionsConfig["profiles"] | undefined => {
		if (!profiles) return undefined;
		return Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, interpolateProfile(profile)]));
	};

	return {
		...config,
		default: interpolateProfile(config.default),
		profiles: interpolateProfileMap(config.profiles),
		agents: interpolateProfileMap(config.agents),
		sandbox: config.sandbox
			? {
				...config.sandbox,
				tmpDir: config.sandbox.tmpDir === undefined ? undefined : interpolateEnvString(config.sandbox.tmpDir),
				allowUnixSockets: interpolateStringArray(config.sandbox.allowUnixSockets),
				allowWrite: interpolateStringArray(config.sandbox.allowWrite),
				denyRead: interpolateStringArray(config.sandbox.denyRead),
				denyWrite: interpolateStringArray(config.sandbox.denyWrite),
			}
			: undefined,
		protectedResources: config.protectedResources
			? {
				...config.protectedResources,
				addDenyRead: interpolateStringArray(config.protectedResources.addDenyRead, { regex: true }),
				addDenyWrite: interpolateStringArray(config.protectedResources.addDenyWrite, { regex: true }),
				unprotectRead: interpolateStringArray(config.protectedResources.unprotectRead, { regex: true }),
				unprotectWrite: interpolateStringArray(config.protectedResources.unprotectWrite, { regex: true }),
			}
			: undefined,
	};
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

	return interpolateConfig({
		default: mergeDefaultConfig(global?.default, project?.default),
		profiles: {
			...(global?.profiles ?? {}),
			...(project?.profiles ?? {}),
		},
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
	});
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

function mergePolicyLayer(
	base: { mode: PermissionMode; rules: Rule[]; externalPath: ExternalPathPolicy },
	layer: AgentProfile | undefined,
): { mode: PermissionMode; rules: Rule[]; externalPath: ExternalPathPolicy } {
	if (!layer) return base;
	const mode = layer.mode ?? base.mode;
	const compiled = compileModeDefaults(mode);
	const externalPath = layer.externalPath ?? (layer.mode ? compiled.externalPath : base.externalPath);
	const rules = layer.inherit === false
		? [...(layer.rules ?? []), ...compiled.rules]
		: [...(layer.rules ?? []), ...base.rules, ...(layer.mode ? compiled.rules : [])];
	return { mode, rules, externalPath };
}

export function activePolicy(config: PermissionsConfig, agentName: string, profileName?: string): EffectivePolicy {
	const protectedResources = resolveProtectedResources(config);
	const protectedRules = compileProtectedRules(protectedResources);
	const defaultMode = config.default?.mode ?? "workspace-write";
	const defaultCompiled = compileModeDefaults(defaultMode);
	let effective = {
		mode: defaultMode,
		rules: [...protectedRules, ...(config.default?.rules ?? []), ...defaultCompiled.rules],
		externalPath: config.default?.externalPath ?? defaultCompiled.externalPath,
	};

	effective = mergePolicyLayer(effective, profileName ? config.profiles?.[profileName] : undefined);
	effective = mergePolicyLayer(effective, agentName === "default" ? undefined : config.agents?.[agentName]);

	return {
		mode: effective.mode,
		rules: effective.rules,
		externalPath: effective.externalPath,
		protectedResources,
	};
}
