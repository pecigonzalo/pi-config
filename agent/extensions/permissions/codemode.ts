import { compileSandboxConfig } from "./sandbox";
import {
	type CodemodeCapability,
	type CodemodeEffectivePolicy,
	type CodemodeMode,
	type EffectivePolicy,
	type SandboxSettings,
} from "./shared";

const MODE_CAPABILITIES: Record<CodemodeMode, CodemodeCapability[]> = {
	analysis: ["message", "artifact", "mcp"],
	orchestrator: ["message", "artifact", "task", "todo", "mcp"],
};

const MODE_RESTRICTION = {
	plan: 0,
	"workspace-write": 1,
	"full-access": 2,
} as const;

const EXTERNAL_PATH_RESTRICTION = {
	block: 0,
	ask: 1,
	allow: 2,
} as const;

export function constrainCodemodePolicy(
	activePolicy: EffectivePolicy,
	selectedPolicy: EffectivePolicy,
): EffectivePolicy {
	const mode =
		MODE_RESTRICTION[activePolicy.mode] <= MODE_RESTRICTION[selectedPolicy.mode]
			? activePolicy.mode
			: selectedPolicy.mode;
	const externalPath =
		EXTERNAL_PATH_RESTRICTION[activePolicy.externalPath] <= EXTERNAL_PATH_RESTRICTION[selectedPolicy.externalPath]
			? activePolicy.externalPath
			: selectedPolicy.externalPath;
	return {
		mode,
		externalPath,
		rules: [...activePolicy.rules, ...selectedPolicy.rules],
		protectedResources: activePolicy.protectedResources,
	};
}

export function resolveCodemodePolicy(
	activePolicy: EffectivePolicy,
	cwd: string,
	sandboxSettings: SandboxSettings | undefined,
	codeMode: CodemodeMode = "analysis",
	runtimeTmpDir?: string,
): CodemodeEffectivePolicy {
	const sandbox = compileSandboxConfig(activePolicy, cwd, sandboxSettings, runtimeTmpDir);

	return {
		codeMode,
		mode: activePolicy.mode,
		capabilities: MODE_CAPABILITIES[codeMode],
		allowProjectAgents: false,
		sandbox,
	};
}
