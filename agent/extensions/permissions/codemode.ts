import { compileSandboxConfig } from "./sandbox";
import {
	type CodemodeCapability,
	type CodemodeEffectivePolicy,
	type CodemodeProfileName,
	type EffectivePolicy,
	type SandboxSettings,
} from "./shared";

const PROFILE_CAPABILITIES: Record<CodemodeProfileName, CodemodeCapability[]> = {
	analysis: ["message", "artifact"],
	orchestrator: ["message", "artifact", "task", "todo"],
};

function codemodeSandboxSettingsFor(
	profile: CodemodeProfileName,
	sandboxSettings: SandboxSettings | undefined,
): SandboxSettings | undefined {
	if (profile === "analysis") {
		return { ...sandboxSettings, network: false };
	}
	return sandboxSettings;
}

function codemodePermissionModeFor(
	activePolicy: EffectivePolicy,
	profile: CodemodeProfileName,
): EffectivePolicy["mode"] {
	if (profile === "analysis") return "plan";
	if (activePolicy.mode === "full-access") return "workspace-write";
	return activePolicy.mode;
}

export function resolveCodemodePolicy(
	activePolicy: EffectivePolicy,
	cwd: string,
	sandboxSettings: SandboxSettings | undefined,
	profile: CodemodeProfileName = "analysis",
	runtimeTmpDir?: string,
): CodemodeEffectivePolicy {
	const mode = codemodePermissionModeFor(activePolicy, profile);
	const sandbox = compileSandboxConfig(
		{ ...activePolicy, mode },
		cwd,
		codemodeSandboxSettingsFor(profile, sandboxSettings),
		runtimeTmpDir,
	);

	return {
		profile,
		mode,
		capabilities: PROFILE_CAPABILITIES[profile],
		allowProjectAgents: false,
		sandbox,
	};
}
