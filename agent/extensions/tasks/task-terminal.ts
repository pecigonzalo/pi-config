import { spawn } from "node:child_process";
import * as path from "node:path";

export const TASKS_WEZTERM_WORKSPACE = "pi-tasks";
export const TASKS_TERMINAL_BACKEND_ENV = "PI_TASKS_TERMINAL_BACKEND";
export const TASKS_WEZTERM_DOMAIN_ENV = "PI_TASKS_WEZTERM_DOMAIN";

export type TaskTerminalBackendId = "wezterm";
export type TaskTerminalBackendPreference = TaskTerminalBackendId | "auto" | "disabled";

export interface TaskTerminalAttachment {
	backend: TaskTerminalBackendId;
	targetId?: string;
	workspace?: string;
}

export interface TaskTerminalAttachmentFields {
	terminalBackend?: TaskTerminalBackendId;
	terminalTargetId?: string;
	terminalWorkspace?: string;
	weztermPaneId?: string;
	weztermWorkspace?: string;
}

export interface TaskTerminalBackendAvailability {
	available: boolean;
	reason?: string;
}

export interface TaskTerminalLaunchResult {
	ok: boolean;
	attachment?: TaskTerminalAttachment;
	error?: string;
}

export interface TaskTerminalOpenSessionOptions {
	sessionPath: string;
	cwd?: string;
	title?: string;
	workspace?: string;
	command: string;
	args: string[];
}

export interface TaskTerminalBackend {
	id: TaskTerminalBackendId;
	displayName: string;
	detectAvailability(): Promise<TaskTerminalBackendAvailability>;
	focus(attachment: TaskTerminalAttachment): Promise<{ ok: boolean; error?: string }>;
	openSession(options: TaskTerminalOpenSessionOptions): Promise<TaskTerminalLaunchResult>;
	formatAttachment(attachment: TaskTerminalAttachment): string;
}

interface CommandExecutionResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number | null;
	error?: string;
}

export function isTaskTerminalBackendId(value: unknown): value is TaskTerminalBackendId {
	return value === "wezterm";
}

export function getTaskTerminalAttachment(snapshot: TaskTerminalAttachmentFields): TaskTerminalAttachment | undefined {
	if (isTaskTerminalBackendId(snapshot.terminalBackend)) {
		const targetId =
			typeof snapshot.terminalTargetId === "string" && snapshot.terminalTargetId.trim()
				? snapshot.terminalTargetId
				: undefined;
		const workspace =
			typeof snapshot.terminalWorkspace === "string" && snapshot.terminalWorkspace.trim()
				? snapshot.terminalWorkspace
				: undefined;
		if (targetId || workspace) {
			return {
				backend: snapshot.terminalBackend,
				targetId,
				workspace,
			};
		}
	}
	if (typeof snapshot.weztermPaneId === "string" && snapshot.weztermPaneId.trim()) {
		return {
			backend: "wezterm",
			targetId: snapshot.weztermPaneId,
			workspace: snapshot.weztermWorkspace,
		};
	}
	return undefined;
}

export function applyTaskTerminalAttachment<T extends TaskTerminalAttachmentFields>(
	snapshot: T,
	attachment: TaskTerminalAttachment,
): T {
	const next = {
		...snapshot,
		terminalBackend: attachment.backend,
		terminalTargetId: attachment.targetId,
		terminalWorkspace: attachment.workspace,
	};
	if (attachment.backend === "wezterm") {
		return {
			...next,
			weztermPaneId: attachment.targetId,
			weztermWorkspace: attachment.workspace,
		} as T;
	}
	return next as T;
}

async function runCommand(
	command: string,
	args: string[],
	options?: { cwd?: string },
): Promise<CommandExecutionResult> {
	return await new Promise<CommandExecutionResult>((resolve) => {
		const proc = spawn(command, args, {
			cwd: options?.cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		proc.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		proc.once("error", (error) => {
			if (settled) return;
			settled = true;
			resolve({
				ok: false,
				stdout,
				stderr,
				code: null,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		proc.once("close", (code) => {
			if (settled) return;
			settled = true;
			resolve({ ok: code === 0, stdout, stderr, code });
		});
	});
}

async function runDetachedCommand(
	command: string,
	args: string[],
	options?: { cwd?: string },
): Promise<{ ok: boolean; error?: string }> {
	return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
		let settled = false;
		try {
			const proc = spawn(command, args, {
				cwd: options?.cwd,
				env: process.env,
				stdio: "ignore",
				detached: true,
			});
			proc.once("error", (error) => {
				if (settled) return;
				settled = true;
				resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
			});
			proc.unref();
			setTimeout(() => {
				if (settled) return;
				settled = true;
				resolve({ ok: true });
			}, 50);
		} catch (error) {
			resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	});
}

function getWezTermDomain(): string {
	const configured = process.env[TASKS_WEZTERM_DOMAIN_ENV]?.trim();
	return configured || "pi";
}

async function openWezTermWorkspace(workspace?: string): Promise<{ ok: boolean; error?: string }> {
	const resolvedWorkspace = workspace?.trim() || TASKS_WEZTERM_WORKSPACE;
	const domain = getWezTermDomain();
	const result = await runDetachedCommand("wezterm", [
		"start",
		"--workspace",
		resolvedWorkspace,
		"--domain",
		domain,
		"--attach",
	]);
	if (result.ok) return { ok: true };
	return {
		ok: false,
		error: `WezTerm could not open workspace ${resolvedWorkspace} on domain ${domain}: ${result.error ?? "failed to start"}`,
	};
}

function formatCommandFailure(result: CommandExecutionResult): string {
	if (result.error) return result.error;
	const stderr = result.stderr.trim();
	if (stderr) return stderr;
	const stdout = result.stdout.trim();
	if (stdout) return stdout;
	return `exit code ${result.code ?? "unknown"}`;
}

export function parseTaskTerminalBackendPreference(raw = process.env[TASKS_TERMINAL_BACKEND_ENV]): {
	preference: TaskTerminalBackendPreference;
	unsupported?: string;
} {
	const trimmed = raw?.trim().toLowerCase();
	if (!trimmed || trimmed === "auto") return { preference: "auto" };
	if (trimmed === "wezterm") return { preference: "wezterm" };
	if (trimmed === "disabled" || trimmed === "off" || trimmed === "none" || trimmed === "false" || trimmed === "0") {
		return { preference: "disabled" };
	}
	return { preference: "disabled", unsupported: trimmed };
}

const taskTerminalBackendAvailabilityCache = new Map<TaskTerminalBackendId, Promise<TaskTerminalBackendAvailability>>();

const taskTerminalBackends: Record<TaskTerminalBackendId, TaskTerminalBackend> = {
	wezterm: {
		id: "wezterm",
		displayName: "WezTerm",
		async detectAvailability(): Promise<TaskTerminalBackendAvailability> {
			const cached = taskTerminalBackendAvailabilityCache.get("wezterm");
			if (cached) return await cached;
			const pending = (async (): Promise<TaskTerminalBackendAvailability> => {
				const result = await runCommand("wezterm", ["--version"]);
				if (result.ok) return { available: true };
				return { available: false, reason: formatCommandFailure(result) };
			})();
			taskTerminalBackendAvailabilityCache.set("wezterm", pending);
			return await pending;
		},
		async focus(attachment: TaskTerminalAttachment): Promise<{ ok: boolean; error?: string }> {
			const workspaceResult = await openWezTermWorkspace(attachment.workspace);
			if (!workspaceResult.ok) return workspaceResult;
			if (!attachment.targetId?.trim()) return { ok: true };
			await new Promise((resolve) => setTimeout(resolve, 250));
			const result = await runCommand("wezterm", ["cli", "activate-pane", "--pane-id", attachment.targetId]);
			if (result.ok) return { ok: true };
			const detail = formatCommandFailure(result);
			return { ok: false, error: `WezTerm could not focus pane ${attachment.targetId}: ${detail}` };
		},
		async openSession(options: TaskTerminalOpenSessionOptions): Promise<TaskTerminalLaunchResult> {
			const workspace = options.workspace?.trim() || TASKS_WEZTERM_WORKSPACE;
			const domain = getWezTermDomain();
			const startArgs = [
				"start",
				"--workspace",
				workspace,
				"--domain",
				domain,
				"--new-tab",
				"--cwd",
				options.cwd ?? path.dirname(options.sessionPath),
				"--",
				options.command,
				...options.args,
			];
			const result = await runDetachedCommand("wezterm", startArgs, {
				cwd: options.cwd ?? path.dirname(options.sessionPath),
			});
			if (!result.ok) {
				return {
					ok: false,
					error: `Failed to launch WezTerm task session: ${result.error ?? "failed to start"}`,
				};
			}
			return {
				ok: true,
				attachment: {
					backend: "wezterm",
					workspace,
				},
			};
		},
		formatAttachment(attachment: TaskTerminalAttachment): string {
			if (attachment.targetId?.trim()) {
				return `WezTerm pane ${attachment.targetId}${attachment.workspace ? ` · ${attachment.workspace}` : ""}`;
			}
			return `WezTerm workspace ${attachment.workspace ?? TASKS_WEZTERM_WORKSPACE}`;
		},
	},
};

export async function resolveTaskTerminalBackendById(
	id: TaskTerminalBackendId,
): Promise<{ backend?: TaskTerminalBackend; reason?: string }> {
	const backend = taskTerminalBackends[id];
	const availability = await backend.detectAvailability();
	if (availability.available) return { backend };
	return { reason: `${backend.displayName} is unavailable${availability.reason ? `: ${availability.reason}` : "."}` };
}

export async function resolveConfiguredTaskTerminalBackend(): Promise<{
	backend?: TaskTerminalBackend;
	reason?: string;
}> {
	const preference = parseTaskTerminalBackendPreference();
	if (preference.unsupported) {
		return {
			reason: `Unsupported ${TASKS_TERMINAL_BACKEND_ENV} value "${preference.unsupported}". Use auto, wezterm, or disabled.`,
		};
	}
	if (preference.preference === "disabled") {
		return { reason: `Task terminal integration is disabled (${TASKS_TERMINAL_BACKEND_ENV}=disabled).` };
	}
	if (preference.preference !== "auto") {
		return await resolveTaskTerminalBackendById(preference.preference);
	}
	for (const backendId of Object.keys(taskTerminalBackends) as TaskTerminalBackendId[]) {
		const resolved = await resolveTaskTerminalBackendById(backendId);
		if (resolved.backend) return resolved;
	}
	return {
		reason: `No supported task terminal backend is available. Set ${TASKS_TERMINAL_BACKEND_ENV}=wezterm to require WezTerm or ${TASKS_TERMINAL_BACKEND_ENV}=disabled to turn this off.`,
	};
}

export function formatTaskTerminalAttachment(attachment: TaskTerminalAttachment): string {
	return (
		taskTerminalBackends[attachment.backend]?.formatAttachment(attachment) ??
		`${attachment.backend} ${attachment.targetId}`
	);
}

export function getTaskAttachActionLabel(): string {
	const preference = parseTaskTerminalBackendPreference();
	if (preference.preference === "wezterm") return "Attach in WezTerm";
	return "Attach in terminal";
}
