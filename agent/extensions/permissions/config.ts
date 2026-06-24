import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getBuiltinProtectedResourceMatches } from "./protected-resources";
import {
	type AgentProfile,
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
			while (j < noComments.length) {
				const nextChar = noComments[j];
				if (nextChar === undefined || !/\s/.test(nextChar)) break;
				j++;
			}
			if (j < noComments.length && (noComments[j] === "}" || noComments[j] === "]")) {
				continue;
			}
		}

		cleaned += ch;
	}

	return JSON.parse(cleaned);
}

export function readJsonFile(
	filePath: string,
	options?: { onWarning?: (message: string) => void },
): unknown | undefined {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return parseJsonc(raw);
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
		const message = error instanceof Error ? error.message : String(error);
		options?.onWarning?.(`Failed to parse ${filePath}: ${message}`);
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

function toExistingDirectory(candidate: string | undefined): string | undefined {
	if (!candidate) return undefined;

	try {
		const real = fs.realpathSync.native(candidate);
		return fs.statSync(real).isDirectory() ? real : path.dirname(real);
	} catch {
		const resolved = path.resolve(candidate);
		try {
			return fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
		} catch {
			return path.dirname(resolved);
		}
	}
}

function looksLikePiPackageRoot(dir: string): boolean {
	const packageJsonPath = path.join(dir, "package.json");
	try {
		const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
			name?: string;
			bin?: string | Record<string, string>;
			piConfig?: unknown;
		};
		const hasExpectedResources =
			fs.existsSync(path.join(dir, "README.md")) &&
			fs.existsSync(path.join(dir, "docs")) &&
			fs.existsSync(path.join(dir, "examples"));
		if (!hasExpectedResources) return false;

		const hasPiBin = typeof pkg.bin === "object" && typeof pkg.bin.pi === "string";
		const nameLooksLikePi = typeof pkg.name === "string" && pkg.name.endsWith("/pi-coding-agent");
		return hasPiBin || nameLooksLikePi || pkg.piConfig !== undefined;
	} catch {
		return false;
	}
}

export function inferPiPackageDirFrom(candidate: string | undefined): string | undefined {
	let dir = toExistingDirectory(candidate);
	if (!dir) return undefined;

	while (dir !== path.dirname(dir)) {
		if (looksLikePiPackageRoot(dir)) return dir;
		dir = path.dirname(dir);
	}

	return undefined;
}

export function getInterpolationVariables(): Record<string, string | undefined> {
	const vars: Record<string, string | undefined> = { ...process.env };
	vars.HOME ??= os.homedir();

	const piPackageDir = vars.PI_PACKAGE_DIR ?? inferPiPackageDirFrom(process.argv[1]) ?? inferPiPackageDirFrom(process.execPath);
	if (piPackageDir) {
		vars.PI_PACKAGE_DIR = piPackageDir;
		vars.PI_DOCS_DIR ??= path.resolve(piPackageDir, "docs");
		vars.PI_EXAMPLES_DIR ??= path.resolve(piPackageDir, "examples");
		vars.PI_README_PATH ??= path.resolve(piPackageDir, "README.md");
		vars.PI_CHANGELOG_PATH ??= path.resolve(piPackageDir, "CHANGELOG.md");
	}

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

function interpolateStringRecord(values: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!values) return undefined;
	return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, interpolateEnvString(value)]));
}

export function interpolateConfig(config: PermissionsConfig): PermissionsConfig {
	const interpolateRuleMatch = (match: Rule["match"]): Rule["match"] => {
		if (match === undefined) return undefined;
		if (Array.isArray(match)) return match.map((pattern) => interpolateEnvString(pattern, { regex: true }));
		return interpolateEnvString(match, { regex: true });
	};
	const interpolateRules = (rules: Rule[] | undefined): Rule[] | undefined =>
		rules?.map((rule) => ({
			...rule,
			match: interpolateRuleMatch(rule.match),
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
		return Object.fromEntries(
			Object.entries(profiles)
				.map(([name, profile]) => [name, interpolateProfile(profile)] as const)
				.filter((entry): entry is readonly [string, AgentProfile] => entry[1] !== undefined),
		);
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
				allowMachLookup: interpolateStringArray(config.sandbox.allowMachLookup),
				bypassCommands: interpolateStringArray(config.sandbox.bypassCommands, { regex: true }),
				addAllowWrite: interpolateStringArray(config.sandbox.addAllowWrite),
				denyRead: interpolateStringArray(config.sandbox.denyRead),
				denyWrite: interpolateStringArray(config.sandbox.denyWrite),
				env: interpolateStringRecord(config.sandbox.env),
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

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

export function loadConfig(cwd: string, options?: { onWarning?: (message: string) => void }): PermissionsConfig {
	const globalPath = path.join(getAgentDir(), "permissions.jsonc");
	const projectPath = path.join(cwd, ".pi", "permissions.jsonc");

	const globalRaw = readJsonFile(globalPath, options);
	const projectRaw = readJsonFile(projectPath, options);

	if (globalRaw !== undefined && !asObjectRecord(globalRaw)) {
		options?.onWarning?.(`Ignoring malformed permissions config at ${globalPath}: expected object root`);
	}
	if (projectRaw !== undefined && !asObjectRecord(projectRaw)) {
		options?.onWarning?.(`Ignoring malformed permissions config at ${projectPath}: expected object root`);
	}

	const global = asObjectRecord(globalRaw) as PermissionsConfig | undefined;
	const project = asObjectRecord(projectRaw) as PermissionsConfig | undefined;

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

export function resolveProtectedResources(config: PermissionsConfig): ResolvedProtectedResources {
	const settings = config.protectedResources ?? {};
	const enabled = settings.enabled ?? true;
	if (!enabled) return { denyRead: [], denyWrite: [] };

	const useDefaults = settings.defaults ?? true;
	const denyReadSource = [
		...(useDefaults ? getBuiltinProtectedResourceMatches("read") : []),
		...(settings.addDenyRead ?? []),
	];
	const denyWriteSource = [
		...(useDefaults ? getBuiltinProtectedResourceMatches("write") : []),
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
