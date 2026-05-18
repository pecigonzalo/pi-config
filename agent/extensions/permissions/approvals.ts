import { bashPrefixMatchesCommand, pathMatchesPrefix } from "./matching";
import type {
	ApprovalFile,
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
	if (approval.scopeType === "bash-prefix") return bashPrefixMatchesCommand(approval.scopeValue, command);
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

function isApprovalScopeType(value: unknown): value is ApprovalRecord["scopeType"] {
	return value === "path-prefix" || value === "tool" || value === "bash-exact" || value === "bash-prefix";
}

function toApprovalRecord(candidate: unknown): ApprovalRecord | undefined {
	if (!candidate || typeof candidate !== "object") return undefined;
	const value = candidate as Partial<ApprovalRecord>;
	if (typeof value.tool !== "string") return undefined;
	if (!isApprovalScopeType(value.scopeType)) return undefined;
	if (typeof value.scopeValue !== "string" || value.scopeValue.trim().length === 0) return undefined;
	if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return undefined;
	if (value.projectRoot !== undefined && typeof value.projectRoot !== "string") return undefined;
	if (value.agentName !== undefined && typeof value.agentName !== "string") return undefined;
	return {
		tool: value.tool,
		scopeType: value.scopeType,
		scopeValue: value.scopeValue,
		projectRoot: value.projectRoot,
		agentName: value.agentName,
		createdAt: value.createdAt,
	};
}

export function extractApprovalRecords(
	raw: unknown,
	onWarning?: (message: string) => void,
	filePath = "approvals file",
): ApprovalRecord[] {
	if (raw === undefined) return [];
	if (!raw || typeof raw !== "object") {
		onWarning?.(`Ignoring malformed approvals at ${filePath}: expected object root`);
		return [];
	}

	const file = raw as Partial<ApprovalFile>;
	if (!Array.isArray(file.approvals)) {
		onWarning?.(`Ignoring malformed approvals at ${filePath}: expected "approvals" array`);
		return [];
	}

	const result: ApprovalRecord[] = [];
	for (let i = 0; i < file.approvals.length; i++) {
		const parsed = toApprovalRecord(file.approvals[i]);
		if (!parsed) {
			onWarning?.(`Ignoring malformed approval entry #${i + 1} in ${filePath}`);
			continue;
		}
		result.push(parsed);
	}
	return result;
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
