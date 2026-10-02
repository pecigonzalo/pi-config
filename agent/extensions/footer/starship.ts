import { execFile, type ChildProcess } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FooterLayoutName, FooterToolResultEvent } from "./core/types";
import type { FooterConfigController } from "./config";

const STARSHIP_MAX_TIMEOUT_MS = 10_000;

interface PromptCacheEntry {
	prompt: string | null;
}

function formatErrorMessage(error: unknown): string {
	if (!error) return "unknown error";
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}

function isMissingExecutable(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function normalizePromptLine(line: string): string | null {
	const ansi = line.replace(/\\\[/g, "").replace(/\\\]/g, "").replace(/%\{/g, "\x1b").replace(/%\}/g, "");

	const cleaned = ansi.replace(/(\x1b\[[0-9;]*m)+$/g, "").trimEnd();
	return cleaned || null;
}

export interface StarshipController {
	setRequestRender(requestRender: (() => void) | undefined): void;
	onSessionStart(): void;
	onTurnEnd(): void;
	onToolResult(event: FooterToolResultEvent): void;
	onSessionShutdown(): void;
	renderPrompt(ctx: ExtensionContext, width: number, layoutName: FooterLayoutName): string | null;
	hasPrompt(ctx: ExtensionContext, width: number, layoutName: FooterLayoutName): boolean;
}

export function createStarshipController(config: FooterConfigController): StarshipController {
	const cache = new Map<string, PromptCacheEntry>();
	const pending = new Set<string>();
	const reportedDiagnostics = new Set<string>();
	const activeChildren = new Set<ChildProcess>();
	const delayedRenderTimers = new Set<ReturnType<typeof setTimeout>>();
	let requestRender: (() => void) | undefined;
	let disposed = false;

	const reportDiagnostic = (ctx: ExtensionContext, key: string, message: string): void => {
		if (!ctx.hasUI || reportedDiagnostics.has(key)) return;
		reportedDiagnostics.add(key);
		ctx.ui.notify(message, "warning");
	};

	const invalidate = (): void => {
		cache.clear();
		pending.clear();
	};

	const scheduleDelayedRender = (delayMs: number): void => {
		const handle = setTimeout(() => {
			delayedRenderTimers.delete(handle);
			requestRender?.();
		}, delayMs);
		delayedRenderTimers.add(handle);
	};

	const abortAll = (): void => {
		for (const child of activeChildren) {
			try {
				child.kill("SIGTERM");
			} catch {
				// already gone
			}
		}
		activeChildren.clear();
		for (const handle of delayedRenderTimers) clearTimeout(handle);
		delayedRenderTimers.clear();
	};

	const isEnabled = (): boolean => config.getStarshipSettings().enabled;

	const getCacheKey = (cwd: string, width: number): string => `${cwd}::${Math.max(20, width)}`;

	const fetchPrompt = (ctx: ExtensionContext, width: number, cacheKey: string): void => {
		const settings = config.getStarshipSettings();
		const timeoutMs = Math.min(settings.timeoutMs, STARSHIP_MAX_TIMEOUT_MS);

		const handleFailure = (error: unknown): void => {
			cache.set(cacheKey, { prompt: null });
			if (isMissingExecutable(error)) {
				reportDiagnostic(
					ctx,
					`starship-missing:${settings.command}`,
					`Footer starship command not found (${settings.command}); using built-in path/git segments.`,
				);
			} else {
				reportDiagnostic(
					ctx,
					`starship-failed:${settings.command}`,
					`Footer starship prompt failed (${settings.command}): ${formatErrorMessage(error)}`,
				);
			}
		};

		let child: ChildProcess | undefined;
		try {
			child = execFile(
				settings.command,
				[
					"prompt",
					`--terminal-width=${Math.max(20, width)}`,
					"--status=0",
					"--keymap=",
					"--pipestatus=0",
					"--cmd-duration=0",
					"--jobs=0",
				],
				{
					cwd: ctx.cwd,
					timeout: timeoutMs,
					env: { ...process.env, PWD: ctx.cwd, STARSHIP_SHELL: settings.shell },
				},
				(error, stdout) => {
					if (child) activeChildren.delete(child);
					pending.delete(cacheKey);
					if (disposed) return;
					if (error) {
						handleFailure(error);
					} else {
						const prompt = normalizePromptLine(String(stdout ?? "").split("\n")[0] ?? "");
						cache.set(cacheKey, { prompt });
					}
					requestRender?.();
				},
			);
			activeChildren.add(child);
		} catch (error) {
			pending.delete(cacheKey);
			if (disposed) return;
			handleFailure(error);
			requestRender?.();
		}
	};

	const ensurePrompt = (ctx: ExtensionContext, width: number): PromptCacheEntry | undefined => {
		if (!isEnabled()) return undefined;

		const cacheKey = getCacheKey(ctx.cwd, width);
		const cached = cache.get(cacheKey);
		if (cached) return cached;

		if (!pending.has(cacheKey)) {
			pending.add(cacheKey);
			fetchPrompt(ctx, width, cacheKey);
		}

		return undefined;
	};

	return {
		setRequestRender(nextRequestRender) {
			requestRender = nextRequestRender;
		},

		onSessionStart() {
			disposed = false;
			invalidate();
			requestRender?.();
		},

		onTurnEnd() {
			invalidate();
			requestRender?.();
		},

		onToolResult(event) {
			if (event.toolName === "write" || event.toolName === "edit") {
				invalidate();
				requestRender?.();
			}

			if (event.toolName === "bash") {
				const command = String(event.input.command ?? "");
				if (/\bgit\s+(checkout|switch|merge|rebase|pull|reset)/.test(command)) {
					invalidate();
					scheduleDelayedRender(150);
				}
			}
		},

		onSessionShutdown() {
			disposed = true;
			abortAll();
			invalidate();
			requestRender = undefined;
		},

		renderPrompt(ctx, width, _layoutName) {
			return ensurePrompt(ctx, width)?.prompt ?? null;
		},

		hasPrompt(ctx, width, _layoutName) {
			return Boolean(ensurePrompt(ctx, width)?.prompt);
		},
	};
}
