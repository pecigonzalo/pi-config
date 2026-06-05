import { beforeAll, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";

let __test__: any;
let extensionFactory: any;

beforeAll(async () => {
	mock.module("@earendil-works/pi-ai", () => ({
		StringEnum: (values: readonly string[]) => ({ type: "string", enum: [...values] }),
	}));
	mock.module("@earendil-works/pi-coding-agent", () => ({
		getAgentDir: () => "/tmp",
		parseFrontmatter: (content: string) => ({ frontmatter: {}, body: content }),
		DEFAULT_MAX_BYTES: 50 * 1024,
		DEFAULT_MAX_LINES: 2000,
		formatSize: (bytes: number) => `${bytes} B`,
		truncateHead: (content: string, options: { maxLines: number; maxBytes: number }) => {
			const lines = content.split("\n");
			let output = lines.slice(0, options.maxLines).join("\n");
			if (Buffer.byteLength(output, "utf8") > options.maxBytes) {
				let lo = 0;
				let hi = output.length;
				while (lo < hi) {
					const mid = Math.ceil((lo + hi) / 2);
					if (Buffer.byteLength(output.slice(0, mid), "utf8") <= options.maxBytes) lo = mid;
					else hi = mid - 1;
				}
				output = output.slice(0, lo);
			}
			return {
				content: output,
				truncated: output !== content,
				totalLines: lines.length,
				outputLines: output ? output.split("\n").length : 0,
				totalBytes: Buffer.byteLength(content, "utf8"),
				outputBytes: Buffer.byteLength(output, "utf8"),
			};
		},
	}));
	mock.module("@earendil-works/pi-tui", () => ({
		Text: class {
			constructor(_text: string) {}
		},
	}));
	mock.module("typebox", () => ({
		Type: {
			Object: (properties: unknown, options?: Record<string, unknown>) => ({ type: "object", properties, ...options }),
			String: (options?: Record<string, unknown>) => ({ type: "string", ...options }),
			Optional: (value: unknown) => value,
			Number: (options?: Record<string, unknown>) => ({ type: "number", ...options }),
			Array: (items: unknown, options?: Record<string, unknown>) => ({ type: "array", items, ...options }),
			Boolean: (options?: Record<string, unknown>) => ({ type: "boolean", ...options }),
			Any: (options?: Record<string, unknown>) => ({ ...options }),
		},
	}));
	const mockAgentsModule = () => ({
		discoverAgents: () => ({ agents: [], errors: [] }),
	});
	mock.module("../tasks/agents.js", mockAgentsModule);

	const mod = await import("./typescript");
	__test__ = mod.__test__;
	extensionFactory = mod.default;
});

describe("typescript tool helpers", () => {
	it("names the typescript tool in every prompt guideline", () => {
		let registeredTool: { promptGuidelines?: string[] } | undefined;
		extensionFactory({
			registerTool(tool: { promptGuidelines?: string[] }) {
				registeredTool = tool;
			},
		});

		expect(registeredTool?.promptGuidelines?.length).toBeGreaterThan(0);
		for (const guideline of registeredTool!.promptGuidelines!) {
			expect(guideline).toContain("typescript");
			expect(guideline.toLowerCase()).not.toContain("this tool");
		}
	});

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

	it("caps protocol logs by line count, byte budget, and line length", () => {
		const lines = Array.from({ length: 260 }, (_, index) => {
			const payload = { level: "info", args: [`line-${index}`, "x".repeat(5000)] };
			return `__PI_CODEMODE_LOG__${JSON.stringify(payload)}`;
		}).join("\n");
		const parsed = __test__.parseProtocolOutput(lines);
		expect(parsed.logs.length).toBeLessThanOrEqual(201);
		expect(parsed.logs.join("\n")).toContain("line truncated");
		expect(parsed.logs.join("\n")).toContain("Log output truncated");
	});

	it("truncates tool output with a byte+line notice", () => {
		const output = __test__.truncateToolOutput(Array.from({ length: 1200 }, (_, index) => `line-${index}`).join("\n"));
		expect(output.truncation.truncated).toBe(true);
		expect(output.text).toContain("[Output truncated: showing");
	});

	it("caps raw output capture and appends a truncation notice", () => {
		const state = __test__.createRawOutputCaptureState();
		__test__.appendRawOutput(state, "a".repeat(300 * 1024));
		const finalized = __test__.finalizeRawOutput(state);
		expect(finalized.notice).toContain("Raw output truncated");
		expect(finalized.text).toContain("Raw output truncated");
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

	describe("process termination escalation", () => {
		class FakeProcess extends EventEmitter {
			exitCode: number | null = null;
			signalCode: NodeJS.Signals | null = null;
			signals: string[] = [];

			kill(signal: NodeJS.Signals): boolean {
				this.signals.push(signal);
				if (signal === "SIGKILL") this.signalCode = signal;
				return true;
			}
		}

		it("sends SIGKILL when process does not exit", async () => {
			const proc = new FakeProcess();
			__test__.terminateProcessWithEscalation(proc as any, { timeoutMs: 10 });
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
		});

		it("skips SIGKILL when process closes during grace period", async () => {
			const proc = new FakeProcess();
			__test__.terminateProcessWithEscalation(proc as any, { timeoutMs: 20 });
			setTimeout(() => {
				proc.exitCode = 0;
				proc.emit("close", 0);
			}, 5);
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(proc.signals).toEqual(["SIGTERM"]);
		});
	});

});
