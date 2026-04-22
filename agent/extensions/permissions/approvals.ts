import { pathMatchesPrefix } from "./matching";
import type {
	ApprovalRecord,
	ApprovalsSettings,
	PermissionToolName,
	PermissionsConfig,
	ResolvedApprovalsSettings,
} from "./shared";

export function getApprovalsSettings(config: PermissionsConfig): ResolvedApprovalsSettings {
	return {
		scopeByProject: config.approvals?.scopeByProject ?? true,
		scopeByAgent: config.approvals?.scopeByAgent ?? true,
		maxAgeDays: config.approvals?.maxAgeDays,
	};
}

function approvalScopeMatch(
	approval: ApprovalRecord,
	toolName: PermissionToolName,
	targetPath: string,
	projectRoot: string,
	agentName: string,
	settings: ResolvedApprovalsSettings,
): boolean {
	if (approval.tool !== toolName && approval.tool !== "*") return false;
	if (settings.scopeByProject && approval.projectRoot !== projectRoot) return false;
	if (settings.scopeByAgent && approval.agentName !== agentName) return false;
	if (approval.scopeType !== "path-prefix") return false;
	return pathMatchesPrefix(targetPath, approval.scopeValue);
}

export function approvalsCoverPaths(
	approvals: ApprovalRecord[],
	toolName: PermissionToolName,
	paths: string[],
	projectRoot: string,
	agentName: string,
	settings: ResolvedApprovalsSettings,
): boolean {
	if (paths.length === 0) return true;
	return paths.every((p) => approvals.some((a) => approvalScopeMatch(a, toolName, p, projectRoot, agentName, settings)));
}

export function dedupeApprovals(approvals: ApprovalRecord[]): ApprovalRecord[] {
	const seen = new Set<string>();
	const result: ApprovalRecord[] = [];
	for (const a of approvals) {
		const key = `${a.tool}::${a.scopeType}::${a.scopeValue}::${a.projectRoot ?? "*"}::${a.agentName ?? "*"}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(a);
	}
	return result;
}

export function formatApprovalScope(approval: ApprovalRecord): string {
	if (approval.scopeType === "path-prefix") return approval.scopeValue;
	if (approval.scopeType === "bash-prefix") return `bash-prefix:${approval.scopeValue} *`;
	return `${approval.scopeType}:${approval.scopeValue}`;
}

export function pruneExpiredApprovals(
	approvals: ApprovalRecord[],
	settings: ResolvedApprovalsSettings,
	now = Date.now(),
): ApprovalRecord[] {
	if (!settings.maxAgeDays || settings.maxAgeDays <= 0) return approvals;
	const maxAgeMs = settings.maxAgeDays * 24 * 60 * 60 * 1000;
	return approvals.filter((a) => now - a.createdAt <= maxAgeMs);
}

function bashApprovalMatches(
	approval: ApprovalRecord,
	command: string,
	projectRoot: string,
	agentName: string,
	settings: ResolvedApprovalsSettings,
): boolean {
	if (approval.tool !== "bash" && approval.tool !== "*") return false;
	if (settings.scopeByProject && approval.projectRoot !== projectRoot) return false;
	if (settings.scopeByAgent && approval.agentName !== agentName) return false;
	if (approval.scopeType === "bash-exact") return approval.scopeValue === command;
	if (approval.scopeType === "bash-prefix") return command.startsWith(approval.scopeValue);
	return false;
}

export function approvalsCoverTool(
	approvals: ApprovalRecord[],
	toolName: PermissionToolName,
	projectRoot: string,
	agentName: string,
	settings: ResolvedApprovalsSettings,
): boolean {
	return approvals.some((a) => {
		if (a.scopeType !== "tool") return false;
		if (a.tool !== toolName && a.tool !== "*") return false;
		if (settings.scopeByProject && a.projectRoot !== projectRoot) return false;
		if (settings.scopeByAgent && a.agentName !== agentName) return false;
		return true;
	});
}

export function approvalsCoverBash(
	approvals: ApprovalRecord[],
	command: string,
	projectRoot: string,
	agentName: string,
	settings: ResolvedApprovalsSettings,
): boolean {
	if (!command.trim()) return false;
	return approvals.some((a) => bashApprovalMatches(a, command, projectRoot, agentName, settings));
}
