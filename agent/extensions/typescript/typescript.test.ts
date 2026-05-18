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
		const source = __test__.buildRunnerSource(["message", "artifact"]);
		expect(source).toContain("__PI_CODEMODE_LOG__");
		expect(source).toContain("__PI_CODEMODE_RESULT__");
		expect(source).toContain("__PI_CODEMODE_BRIDGE_REQUEST__");
		expect(source).toContain('import("./usercode.ts")');
	});

	it("splits imports and body", () => {
		const result = __test__.splitImportsAndBody(
			'import { readFileSync } from "node:fs";\nimport { join } from "node:path";\n\nconst x = 1;\nreturn x;',
		);
		expect(result.imports).toContain('import { readFileSync }');
		expect(result.imports).toContain('import { join }');
		expect(result.body).toContain('const x = 1;');
		expect(result.body).toContain('return x;');
	});

	it("splits code with no imports", () => {
		const result = __test__.splitImportsAndBody('const x = 1;\nreturn x;');
		expect(result.imports).toBe("");
		expect(result.body).toBe('const x = 1;\nreturn x;');
	});

	it("handles multi-line imports", () => {
		const code = 'import {\n  readFileSync,\n  writeFileSync,\n} from "node:fs";\n\nreturn 1;';
		const result = __test__.splitImportsAndBody(code);
		expect(result.imports).toContain('readFileSync');
		expect(result.imports).toContain('writeFileSync');
		expect(result.body).toContain('return 1;');
	});

	it("builds user module with imports at top level", () => {
		const mod = __test__.buildUserModule(
			'import { readFileSync } from "node:fs";\nconst x: string = "hello";\nreturn x;',
		);
		expect(mod).toMatch(/^import \{ readFileSync \}/);
		expect(mod).toContain('export default async function(host: any, state: any) {');
		expect(mod).toContain('return x;');
	});

	it("sanitizes artifact names", () => {
		expect(__test__.sanitizeArtifactName("../unsafe name?.md")).toBe("unsafe-name-.md");
	});

});
