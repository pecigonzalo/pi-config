import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FooterLayoutName } from "./core/types";
import type { FooterConfigController } from "./config";

const execFileAsync = promisify(execFile);

interface PromptCacheEntry {
	prompt: string | null;
}

function formatErrorMessage(error: unknown): string {
	if (!error) return "unknown error";
	if (error instanceof Error && error.message) return error.message;
	return String(error);
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
	onToolResult(event: { toolName: string; input?: unknown }): void;
	onSessionShutdown(): void;
	renderPrompt(ctx: ExtensionContext, width: number, layoutName: FooterLayoutName): string | null;
	hasPrompt(ctx: ExtensionContext, width: number, layoutName: FooterLayoutName): boolean;
}

export function createStarshipController(config: FooterConfigController): StarshipController {
	const cache = new Map<string, PromptCacheEntry>();
	const pending = new Set<string>();
	const reportedDiagnostics = new Set<string>();
	let requestRender: (() => void) | undefined;

	const reportDiagnostic = (ctx: ExtensionContext, key: string, message: string): void => {
		if (!ctx.hasUI || reportedDiagnostics.has(key)) return;
		reportedDiagnostics.add(key);
		ctx.ui.notify(message, "warning");
	};

	const invalidate = (): void => {
		cache.clear();
		pending.clear();
	};

	const isEnabled = (): boolean => config.getStarshipSettings().enabled;

	const getCacheKey = (cwd: string, width: number): string => `${cwd}::${Math.max(20, width)}`;

	const fetchPrompt = async (ctx: ExtensionContext, width: number, cacheKey: string): Promise<void> => {
		const settings = config.getStarshipSettings();
		try {
			const { stdout } = await execFileAsync(
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
					timeout: settings.timeoutMs,
					env: { ...process.env, PWD: ctx.cwd, STARSHIP_SHELL: settings.shell },
				},
			);
			const prompt = normalizePromptLine(stdout.split("\n")[0] ?? "");
			cache.set(cacheKey, { prompt });
		} catch (error) {
			cache.set(cacheKey, { prompt: null });
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
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
		} finally {
			pending.delete(cacheKey);
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
			void fetchPrompt(ctx, width, cacheKey);
		}

		return undefined;
	};

	return {
		setRequestRender(nextRequestRender) {
			requestRender = nextRequestRender;
		},

		onSessionStart() {
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
				const command = String((event as { input?: { command?: unknown } }).input?.command ?? "");
				if (/\bgit\s+(checkout|switch|merge|rebase|pull|reset)/.test(command)) {
					invalidate();
					setTimeout(() => requestRender?.(), 150);
				}
			}
		},

		onSessionShutdown() {
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
