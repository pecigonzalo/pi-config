import { afterEach, describe, expect, it } from "bun:test";
import { TUI } from "@earendil-works/pi-tui";
import piRefreshThrottle, {
	DEFAULT_MIN_RENDER_INTERVAL_MS,
	positiveIntegerFromEnv,
	setTuiMinRenderInterval,
} from "./index";

const ORIGINAL_ENV = process.env.PI_TUI_MIN_RENDER_INTERVAL_MS;
const ORIGINAL_TUI_INTERVAL = (TUI as unknown as { MIN_RENDER_INTERVAL_MS: number }).MIN_RENDER_INTERVAL_MS;

afterEach(() => {
	if (ORIGINAL_ENV === undefined) delete process.env.PI_TUI_MIN_RENDER_INTERVAL_MS;
	else process.env.PI_TUI_MIN_RENDER_INTERVAL_MS = ORIGINAL_ENV;
	(TUI as unknown as { MIN_RENDER_INTERVAL_MS: number }).MIN_RENDER_INTERVAL_MS = ORIGINAL_TUI_INTERVAL;
});

describe("performance extension", () => {
	it("parses positive integer environment overrides", () => {
		delete process.env.PI_TUI_MIN_RENDER_INTERVAL_MS;
		expect(positiveIntegerFromEnv("PI_TUI_MIN_RENDER_INTERVAL_MS", DEFAULT_MIN_RENDER_INTERVAL_MS)).toBe(
			DEFAULT_MIN_RENDER_INTERVAL_MS,
		);

		process.env.PI_TUI_MIN_RENDER_INTERVAL_MS = "75";
		expect(positiveIntegerFromEnv("PI_TUI_MIN_RENDER_INTERVAL_MS", DEFAULT_MIN_RENDER_INTERVAL_MS)).toBe(75);

		process.env.PI_TUI_MIN_RENDER_INTERVAL_MS = "0";
		expect(positiveIntegerFromEnv("PI_TUI_MIN_RENDER_INTERVAL_MS", DEFAULT_MIN_RENDER_INTERVAL_MS)).toBe(
			DEFAULT_MIN_RENDER_INTERVAL_MS,
		);

		process.env.PI_TUI_MIN_RENDER_INTERVAL_MS = "invalid";
		expect(positiveIntegerFromEnv("PI_TUI_MIN_RENDER_INTERVAL_MS", DEFAULT_MIN_RENDER_INTERVAL_MS)).toBe(
			DEFAULT_MIN_RENDER_INTERVAL_MS,
		);
	});

	it("patches a writable TUI render throttle target", () => {
		const target = { MIN_RENDER_INTERVAL_MS: 16 };

		setTuiMinRenderInterval(target, 90);

		expect(target.MIN_RENDER_INTERVAL_MS).toBe(90);
	});

	it("fails clearly when the private TUI patch target is unavailable", () => {
		expect(() => setTuiMinRenderInterval({}, 90)).toThrow("MIN_RENDER_INTERVAL_MS is not writable");
	});

	it("patches the Pi 0.78 TUI runtime render throttle", () => {
		const descriptor = Object.getOwnPropertyDescriptor(TUI, "MIN_RENDER_INTERVAL_MS");
		expect(descriptor?.writable).toBe(true);

		process.env.PI_TUI_MIN_RENDER_INTERVAL_MS = "77";
		piRefreshThrottle({} as never);

		expect((TUI as unknown as { MIN_RENDER_INTERVAL_MS: number }).MIN_RENDER_INTERVAL_MS).toBe(77);
	});
});
