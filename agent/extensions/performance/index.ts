import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TUI } from "@earendil-works/pi-tui";

export const DEFAULT_MIN_RENDER_INTERVAL_MS = 60;
const TUI_RENDER_INTERVAL_PROPERTY = "MIN_RENDER_INTERVAL_MS";

type TuiRenderThrottleTarget = {
	MIN_RENDER_INTERVAL_MS: number;
};

export function positiveIntegerFromEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;

	const value = Number.parseInt(raw, 10);
	if (!Number.isFinite(value) || value <= 0) return fallback;
	return value;
}

function isWritableRenderThrottleTarget(target: unknown): target is TuiRenderThrottleTarget {
	if (!target || (typeof target !== "object" && typeof target !== "function")) return false;
	const descriptor = Object.getOwnPropertyDescriptor(target, TUI_RENDER_INTERVAL_PROPERTY);
	return descriptor?.writable === true && typeof descriptor.value === "number";
}

export function setTuiMinRenderInterval(target: unknown, minRenderIntervalMs: number): void {
	if (!isWritableRenderThrottleTarget(target)) {
		throw new Error(
			"Pi TUI MIN_RENDER_INTERVAL_MS is not writable; update the performance extension for this Pi version.",
		);
	}

	target.MIN_RENDER_INTERVAL_MS = minRenderIntervalMs;
}

export default function piRefreshThrottle(_pi: ExtensionAPI) {
	const minRenderIntervalMs = positiveIntegerFromEnv("PI_TUI_MIN_RENDER_INTERVAL_MS", DEFAULT_MIN_RENDER_INTERVAL_MS);

	// TUI exposes this as a private static in types, but the runtime JS field is writable in Pi 0.78.
	// Raising it from pi's default 16 ms (~60 FPS) coalesces streaming/render bursts.
	setTuiMinRenderInterval(TUI, minRenderIntervalMs);
}
