import { describe, expect, test } from "bun:test";
import { __test } from "./index";

const sourceFile = {
	absPath: "/repo/src/auth.ts",
	relPath: "src/auth.ts",
	language: "typescript",
	size: 100,
};

const goSourceFile = {
	absPath: "/repo/internal/broker/server.go",
	relPath: "internal/broker/server.go",
	language: "go",
	size: 100,
};

describe("code-intel Phase 1 extraction", () => {
	test("extracts TypeScript declarations and methods", () => {
		const defs = __test.extractDefinitions(
			sourceFile,
			`export interface AuthOptions {\n  tokenTtl: number;\n}\n\nexport class AuthService {\n  constructor(private store: TokenStore) {}\n  async login(email: string, password: string): Promise<Token> {\n    return this.store.create(email);\n  }\n}\n\nexport const buildAuth = (store: TokenStore) => new AuthService(store);\n`,
		);

		expect(defs.map((def) => `${def.kind}:${def.name}`)).toContain("interface:AuthOptions");
		expect(defs.map((def) => `${def.kind}:${def.name}`)).toContain("class:AuthService");
		expect(defs.map((def) => `${def.kind}:${def.name}`)).toContain("method:login");
		expect(defs.map((def) => `${def.kind}:${def.name}`)).toContain("function:buildAuth");
	});

	test("finds brace-delimited symbol ranges", () => {
		const lines = `export class AuthService {\n  async login() {\n    if (true) {\n      return 1;\n    }\n  }\n}\n\nexport function outside() {}`.split("\n");

		expect(__test.findDefinitionEnd(lines, 0, "typescript")).toBe(6);
		expect(__test.findDefinitionEnd(lines, 1, "typescript")).toBe(5);
	});

	test("extracts go interface members as declaration symbols", () => {
		const defs = __test.extractDefinitions(
			goSourceFile,
			`type clusterState interface {\n\tIsLeader() bool\n\tCreateTopic(ctx context.Context, name string) error\n}\n`,
		);

		expect(defs.map((def) => `${def.kind}:${def.name}`)).toContain("type:clusterState");
		expect(defs.map((def) => `${def.kind}:${def.name}`)).toContain("interface_method:IsLeader");
		expect(defs.map((def) => `${def.kind}:${def.name}`)).toContain("interface_method:CreateTopic");
		expect(defs.find((def) => def.name === "CreateTopic")?.declaration).toBe(true);
		expect(defs.find((def) => def.name === "CreateTopic")?.container).toBe("clusterState");
	});

	test("uses declaration-aware ranges", () => {
		const lines = `type clusterState interface {\n\tCreateTopic(ctx context.Context, name string) error\n}`.split("\n");
		const declaration = {
			name: "CreateTopic",
			kind: "interface_method",
			file: "internal/broker/server.go",
			line: 1,
			column: 1,
			text: "\tCreateTopic(ctx context.Context, name string) error",
			signatureLines: ["\tCreateTopic(ctx context.Context, name string) error"],
			score: 0,
			declaration: true,
		};

		expect(__test.getDefinitionEnd(declaration, lines, "go")).toBe(1);
	});

	test("ranks externally referenced definitions higher", () => {
		const authDef = {
			name: "AuthService",
			kind: "class",
			file: "src/auth.ts",
			line: 1,
			column: 13,
			text: "class AuthService {}",
			signatureLines: ["class AuthService {}"],
			score: 0,
		};
		const localDef = {
			...authDef,
			name: "LocalHelper",
			kind: "function",
			text: "function LocalHelper() {}",
			signatureLines: ["function LocalHelper() {}"],
		};

		const refs = new Map([
			["AuthService", new Map([["src/routes.ts", 3]])],
			["LocalHelper", new Map([["src/auth.ts", 1]])],
		]);
		const ranked = __test.rankDefinitions(
			new Map([
				["AuthService", [authDef]],
				["LocalHelper", [localDef]],
			]),
			refs,
			new Set(),
		);

		expect(ranked[0]?.name).toBe("AuthService");
	});

	test("parses tree-sitter tags output", () => {
		const parsed = __test.parseTreeSitterTagsOutput(
			`    /repo/src/auth.ts\n        AuthService      | class        def (4, 13) - (4, 24) \`export class AuthService {\`\n        TokenStore       | class        ref (5, 30) - (5, 40) \`constructor(private store: TokenStore) {}\`\n`,
			"/repo",
		);

		const fileTags = parsed.byFile.get("src/auth.ts");
		expect(parsed.definitionCount).toBe(1);
		expect(parsed.referenceCount).toBe(1);
		expect(fileTags?.definitions[0]?.name).toBe("AuthService");
		expect(fileTags?.definitions[0]?.kind).toBe("class");
		expect(fileTags?.references.get("TokenStore")).toBe(1);
	});

	test("hydrates tree-sitter tags into definitions", () => {
		const defs = __test.hydrateTreeSitterDefinitions(
			sourceFile,
			`export class AuthService {\n  login() {}\n}`,
			[{ name: "AuthService", kind: "class", role: "def", file: "src/auth.ts", line: 0, column: 13 }],
		);

		expect(defs[0]?.backend).toBe("tree-sitter-tags");
		expect(defs[0]?.signatureLines[0]).toContain("AuthService");
	});

	test("reports unsupported extensions when map scope has no supported files", () => {
		const notes = __test.renderScanDiagnostics(
			{
				unsupportedExtensions: new Map([
					[".zig", 4],
					[".vue", 2],
				]),
				fallbackPatternLanguages: new Map(),
			},
			0,
		);

		expect(notes.join("\n")).toContain("No supported source files were analyzed");
		expect(notes.join("\n")).toContain(".zig (4)");
	});

	test("reports fallback language extraction limits", () => {
		const notes = __test.renderScanDiagnostics(
			{
				unsupportedExtensions: new Map(),
				fallbackPatternLanguages: new Map([
					["scala", 3],
					["elixir", 1],
				]),
			},
			2,
		);

		expect(notes.join("\n")).toContain("generic fallback patterns");
		expect(notes.join("\n")).toContain("scala (3 file(s))");
	});

	test("extracts go multi-line imports without the import block header", () => {
		const imports = __test.extractImportLines(
			`package broker\n\nimport (\n\t"context"\n\tpb "example/pb"\n)\n\nfunc f() {}`.split("\n"),
			"go",
		);

		expect(imports.map((item) => item.text.trim())).toEqual(['"context"', 'pb "example/pb"']);
	});

	test("merges tree-sitter and syntax definitions while preferring tree-sitter duplicates", () => {
		const treeSitterDef = {
			name: "CreateTopic",
			kind: "method",
			file: "internal/broker/server.go",
			line: 10,
			column: 18,
			text: "func (s *Server) CreateTopic() {}",
			signatureLines: ["func (s *Server) CreateTopic() {}"],
			score: 0,
			backend: "tree-sitter-tags" as const,
		};
		const duplicateSyntaxDef = { ...treeSitterDef, backend: "syntax-pattern" as const };
		const syntaxOnlyDef = {
			...treeSitterDef,
			name: "clusterState",
			kind: "type",
			line: 2,
			column: 5,
			text: "type clusterState interface {",
			signatureLines: ["type clusterState interface {"],
			backend: "syntax-pattern" as const,
		};

		const merged = __test.mergeDefinitions([treeSitterDef], [duplicateSyntaxDef, syntaxOnlyDef]);

		expect(merged.map((def) => `${def.kind}:${def.name}:${def.backend}`)).toEqual([
			"type:clusterState:syntax-pattern",
			"method:CreateTopic:tree-sitter-tags",
		]);
	});

	test("renders enclosing context for text-only symbol matches", () => {
		const text = `type clusterState interface {\n\tIsLeader() bool\n\tCreateTopic(ctx context.Context, name string) error\n}\n`;
		const definitions = __test.extractDefinitions(goSourceFile, text);
		const fallback = __test.renderTextMatchFallback(goSourceFile, text, definitions, "CreateTopic");

		expect(fallback).toContain('No extracted symbol found for "CreateTopic".');
		expect(fallback).toContain("Text match fallback: found 1 identifier match(es)");
		expect(fallback).toContain("enclosing interface_method declaration CreateTopic");
		expect(fallback).toContain("matched line 3");
		expect(fallback).toContain("CreateTopic(ctx context.Context, name string) error");
	});

	test("filters definitions by slice mode", () => {
		const defs = [
			{ name: "CreateTopic", kind: "interface_method", declaration: true },
			{ name: "CreateTopic", kind: "method", declaration: false },
		] as any;

		expect(__test.filterBySliceMode(defs, "declaration")).toHaveLength(1);
		expect(__test.filterBySliceMode(defs, "implementation")).toHaveLength(1);
		expect(__test.filterBySliceMode(defs, "any")).toHaveLength(2);
	});

	test("parses symbol query DSL filters", () => {
		const parsed = __test.parseSymbolQuery('kind:method file:internal/broker name:CreateTopic queue');
		expect(parsed.kind).toBe("method");
		expect(parsed.file).toBe("internal/broker");
		expect(parsed.name).toBe("createtopic");
		expect(parsed.text).toBe("queue");
		expect(parsed.filters.length).toBe(3);
	});

	test("matches symbol query DSL filters", () => {
		const parsed = __test.parseSymbolQuery("kind:method file:internal/broker name:CreateTopic");
		const match = __test.matchesSymbolQuery(
			{ name: "CreateTopic", kind: "method", file: "internal/broker/server.go" },
			parsed,
		);
		const noMatch = __test.matchesSymbolQuery(
			{ name: "CreateTopic", kind: "interface_method", file: "internal/broker/server.go" },
			parsed,
		);

		expect(match).toBe(true);
		expect(noMatch).toBe(false);
	});
});
