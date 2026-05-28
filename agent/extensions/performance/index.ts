import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TUI } from "@earendil-works/pi-tui";

const DEFAULT_MIN_RENDER_INTERVAL_MS = 60;

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function workingIndicatorFrames(): string[] {
  if (process.env.PI_WORKING_INDICATOR_STATIC === "1") return ["·"];
  return ["⠋", "⠹", "⠼", "⠦"];
}

export default function piRefreshThrottle(pi: ExtensionAPI) {
  const minRenderIntervalMs = positiveIntegerFromEnv(
    "PI_TUI_MIN_RENDER_INTERVAL_MS",
    DEFAULT_MIN_RENDER_INTERVAL_MS,
  );

  // TUI exposes this as a private static in types, but the runtime JS field is writable.
  // Raising it from pi's default 16 ms (~60 FPS) coalesces streaming/render bursts.
  (
    TUI as unknown as { MIN_RENDER_INTERVAL_MS: number }
  ).MIN_RENDER_INTERVAL_MS = minRenderIntervalMs;
}
