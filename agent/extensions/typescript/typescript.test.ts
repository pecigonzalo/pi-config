import { beforeAll, describe, expect, it, mock } from "bun:test";

let __test__: Awaited<ReturnType<typeof import("./typescript")>>["__test"];

beforeAll(async () => {
	mock.module("@mariozechner/pi-ai", () => ({
		StringEnum: (values: readonly string[]) => ({ type: "string", enum: [...values] }),
	}));
	mock.module("@mariozechner/pi-coding-agent", () => ({
		getAgentDir: () => "/tmp",
		parseFrontmatter: (content: string) => ({ frontmatter: {}, body: content }),
	}));
	mock.module("@mariozechner/pi-tui", () => ({
		Text: class {
			constructor(_text: string) {}
		},
	}));
	mock.module("@sinclair/typebox", () => ({
		Type: {
			Object: (value: unknown) => value,
			String: (value?: unknown) => value,
			Optional: (value: unknown) => value,
			Number: (value?: unknown) => value,
		},
	}));

	__test__ = (await import("./typescript")).__test__;
});

describe("typescript tool helpers", () => {
	it("parses protocol output lines", () => {
		const parsed = __test__.parseProtocolOutput(
			[
				'__PI_CODEMODE_LOG__{"level":"info","args":["hello"]}',
				'__PI_CODEMODE_RESULT__{"ok":true,"result":{"answer":42}}',
			].join("\n"),
		);

		expect(parsed.logs).toEqual(["[info] hello"]);
		expect(parsed.result).toEqual({ ok: true, result: { answer: 42 } });
	});

	it("clamps timeout values", () => {
		expect(__test__.clampTimeout(undefined)).toBe(30);
		expect(__test__.clampTimeout(0)).toBe(1);
		expect(__test__.clampTimeout(500)).toBe(120);
		expect(__test__.clampTimeout(12)).toBe(12);
	});

	it("runner source includes protocol prefixes", () => {
		const source = __test__.buildRunnerSource("return 42;", ["message", "artifact"]);
		expect(source).toContain("__PI_CODEMODE_LOG__");
		expect(source).toContain("__PI_CODEMODE_RESULT__");
		expect(source).toContain("__PI_CODEMODE_BRIDGE_REQUEST__");
		expect(source).toContain("return 42;");
	});

	it("sanitizes artifact names", () => {
		expect(__test__.sanitizeArtifactName("../unsafe name?.md")).toBe("unsafe-name-.md");
	});

	it("detects sandbox launch failures", () => {
		expect(__test__.isSandboxLaunchFailure("sandbox-exec: sandbox_apply: Operation not permitted\n")).toBe(true);
		expect(__test__.isSandboxLaunchFailure("normal output")).toBe(false);
	});

	it("detects inherited sandbox from env", () => {
		process.env.PI_SANDBOX_ACTIVE = "1";
		process.env.PI_SANDBOX_REASON = "session sandbox";
		const info = __test__.getInheritedSandboxInfo();
		expect(info.active).toBe(true);
		expect(info.reason).toBe("session sandbox");
		delete process.env.PI_SANDBOX_ACTIVE;
		delete process.env.PI_SANDBOX_REASON;
	});

	it("requires explicit env opt-in for unsandboxed fallback", () => {
		delete process.env.PI_CODEMODE_ALLOW_UNSANDBOXED;
		expect(__test__.allowUnsandboxedFallback()).toBe(false);
		process.env.PI_CODEMODE_ALLOW_UNSANDBOXED = "1";
		expect(__test__.allowUnsandboxedFallback()).toBe(true);
		delete process.env.PI_CODEMODE_ALLOW_UNSANDBOXED;
	});
});
