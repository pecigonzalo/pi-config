import { spawn } from "node:child_process";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

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

export type TaskTerminalProbeResult =
	{ status: "alive" } | { status: "stale"; error?: string } | { status: "unknown"; error?: string };

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
	probe(attachment: TaskTerminalAttachment): Promise<TaskTerminalProbeResult>;
	focus(attachment: TaskTerminalAttachment): Promise<{ ok: boolean; error?: string }>;
	close(attachment: TaskTerminalAttachment): Promise<{ ok: boolean; error?: string }>;
	openSession(options: TaskTerminalOpenSessionOptions): Promise<TaskTerminalLaunchResult>;
	formatAttachment(attachment: TaskTerminalAttachment): string;
}

export interface TaskTerminalCommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number | null;
	error?: string;
}

export type TaskTerminalCommandRunner = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeoutMs?: number },
) => Promise<TaskTerminalCommandResult>;

const TASK_TERMINAL_COMMAND_TIMEOUT_MS = 5_000;
const MAX_TASK_TERMINAL_COMMAND_OUTPUT_BYTES = 256 * 1024;
const TASK_TERMINAL_OUTPUT_TRUNCATION_MARKER = "\n[command output truncated]\n";
let commandRunner: TaskTerminalCommandRunner | undefined;

export function isTaskTerminalBackendId(value: unknown): value is TaskTerminalBackendId {
	return value === "wezterm";
}

function normalizeTaskTerminalTargetId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) return undefined;
	const numericValue = Number(trimmed);
	if (numericValue < 1 || !Number.isSafeInteger(numericValue) || String(numericValue) !== trimmed) {
		return undefined;
	}
	return trimmed;
}

export function getTaskTerminalAttachment(snapshot: TaskTerminalAttachmentFields): TaskTerminalAttachment | undefined {
	const genericTargetId = normalizeTaskTerminalTargetId(snapshot.terminalTargetId);
	if (isTaskTerminalBackendId(snapshot.terminalBackend) && genericTargetId) {
		return {
			backend: snapshot.terminalBackend,
			targetId: genericTargetId,
			workspace: snapshot.terminalWorkspace?.trim() || undefined,
		};
	}
	const legacyTargetId = normalizeTaskTerminalTargetId(snapshot.weztermPaneId);
	if (legacyTargetId) {
		return {
			backend: "wezterm",
			targetId: legacyTargetId,
			workspace: snapshot.weztermWorkspace?.trim() || undefined,
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

function capTaskTerminalOutput(value: string): string {
	const markerBytes = Buffer.byteLength(TASK_TERMINAL_OUTPUT_TRUNCATION_MARKER, "utf8");
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength <= MAX_TASK_TERMINAL_COMMAND_OUTPUT_BYTES) return value;
	let body = bytes.subarray(0, Math.max(0, MAX_TASK_TERMINAL_COMMAND_OUTPUT_BYTES - markerBytes)).toString("utf8");
	while (Buffer.byteLength(body, "utf8") > MAX_TASK_TERMINAL_COMMAND_OUTPUT_BYTES - markerBytes)
		body = body.slice(0, -1);
	return body + TASK_TERMINAL_OUTPUT_TRUNCATION_MARKER;
}

async function runCommand(
	command: string,
	args: string[],
	options?: { cwd?: string; timeoutMs?: number },
): Promise<TaskTerminalCommandResult> {
	if (commandRunner) {
		const result = await commandRunner(command, args, options);
		return {
			...result,
			stdout: capTaskTerminalOutput(result.stdout),
			stderr: capTaskTerminalOutput(result.stderr),
		};
	}
	return await new Promise<TaskTerminalCommandResult>((resolve) => {
		const proc = spawn(command, args, {
			cwd: options?.cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		let settled = false;
		const append = (current: string, text: string): string => {
			const remainingBytes = MAX_TASK_TERMINAL_COMMAND_OUTPUT_BYTES - Buffer.byteLength(current, "utf8");
			if (remainingBytes <= 0) return capTaskTerminalOutput(current);
			const textBytes = Buffer.byteLength(text, "utf8");
			if (textBytes <= remainingBytes) return current + text;
			const boundedText = Buffer.from(text, "utf8").subarray(0, remainingBytes).toString("utf8");
			return capTaskTerminalOutput(current + boundedText);
		};
		proc.stdout.on("data", (chunk: Buffer) => {
			stdout = append(stdout, stdoutDecoder.write(chunk));
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			stderr = append(stderr, stderrDecoder.write(chunk));
		});
		proc.once("error", (error) => {
			stdout = append(stdout, stdoutDecoder.end());
			stderr = append(stderr, stderrDecoder.end());
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
			stdout = append(stdout, stdoutDecoder.end());
			stderr = append(stderr, stderrDecoder.end());
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve({ ok: code === 0, stdout, stderr, code });
		});
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			proc.kill("SIGTERM");
			resolve({ ok: false, stdout, stderr, code: null, error: "command timed out" });
		}, options?.timeoutMs ?? TASK_TERMINAL_COMMAND_TIMEOUT_MS);
	});
}

function getWezTermDomain(): string {
	const configured = process.env[TASKS_WEZTERM_DOMAIN_ENV]?.trim();
	return configured || "pi";
}

export function setTaskTerminalCommandRunnerForTests(runner: TaskTerminalCommandRunner | undefined): void {
	commandRunner = runner;
	taskTerminalBackendAvailabilityCache.clear();
}

function formatCommandFailure(result: TaskTerminalCommandResult): string {
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
		async probe(attachment: TaskTerminalAttachment): Promise<TaskTerminalProbeResult> {
			if (!attachment.targetId?.trim()) return { status: "stale", error: "Attachment has no pane identity." };
			const result = await runCommand("wezterm", ["cli", "list", "--format", "json"], {
				timeoutMs: TASK_TERMINAL_COMMAND_TIMEOUT_MS,
			});
			if (!result.ok) {
				const detail = formatCommandFailure(result);
				return {
					status: /pane|not found|no such/i.test(detail) ? "stale" : "unknown",
					error: detail,
				};
			}
			try {
				if (result.stdout.includes(TASK_TERMINAL_OUTPUT_TRUNCATION_MARKER)) {
					return { status: "unknown", error: "WezTerm pane data exceeded the output limit." };
				}
				const panes = JSON.parse(result.stdout) as Array<{ pane_id?: number }>;
				return panes.some((pane) => String(pane.pane_id) === attachment.targetId)
					? { status: "alive" }
					: { status: "stale", error: `Pane ${attachment.targetId} was not found.` };
			} catch {
				return { status: "unknown", error: "WezTerm returned invalid pane data." };
			}
		},
		async focus(attachment: TaskTerminalAttachment): Promise<{ ok: boolean; error?: string }> {
			if (!attachment.targetId?.trim()) return { ok: false, error: "Attachment has no pane identity." };
			const result = await runCommand("wezterm", ["cli", "activate-pane", "--pane-id", attachment.targetId], {
				timeoutMs: TASK_TERMINAL_COMMAND_TIMEOUT_MS,
			});
			if (result.ok) return { ok: true };
			const detail = formatCommandFailure(result);
			return { ok: false, error: `WezTerm could not focus pane ${attachment.targetId}: ${detail}` };
		},
		async close(attachment: TaskTerminalAttachment): Promise<{ ok: boolean; error?: string }> {
			if (!attachment.targetId?.trim()) return { ok: false, error: "Attachment has no pane identity." };
			const result = await runCommand("wezterm", ["cli", "kill-pane", "--pane-id", attachment.targetId], {
				timeoutMs: TASK_TERMINAL_COMMAND_TIMEOUT_MS,
			});
			if (result.ok) return { ok: true };
			return {
				ok: false,
				error: `WezTerm could not close pane ${attachment.targetId}: ${formatCommandFailure(result)}`,
			};
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
			const result = await runCommand("wezterm", ["cli", "spawn", ...startArgs.slice(1)], {
				cwd: options.cwd ?? path.dirname(options.sessionPath),
				timeoutMs: TASK_TERMINAL_COMMAND_TIMEOUT_MS,
			});
			const output = result.stdout.trim();
			const targetId = normalizeTaskTerminalTargetId(output);
			if (!result.ok || !targetId) {
				return {
					ok: false,
					error: `Failed to launch WezTerm task session: ${formatCommandFailure(result)}`,
				};
			}
			return {
				ok: true,
				attachment: {
					backend: "wezterm",
					targetId,
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

export const __test__ = {
	capTaskTerminalOutput,
};
