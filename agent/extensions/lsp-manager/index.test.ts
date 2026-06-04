import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __test__ as serviceTest, type LspStatusItem } from "./service";
import { __test__ as indexTest } from "./index";

function makeTempProject(): string {
  const root = join(tmpdir(), `pi-lsp-manager-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), "{}", "utf-8");
  writeFileSync(join(root, "src", "index.ts"), "const value = 1;\n", "utf-8");
  return root;
}

describe("lsp-manager helpers", () => {
  it("detects builtin server definitions by extension", () => {
    expect(serviceTest.serverForFile("src/index.ts")?.id).toBe("typescript");
    expect(serviceTest.serverForFile("main.go")?.id).toBe("go");
    expect(serviceTest.serverForFile("README.md")).toBeUndefined();
  });

  it("maps diagnostics into compact serializable items", () => {
    const item = serviceTest.diagnosticToItem("/repo/src/index.ts", {
      range: {
        start: { line: 4, character: 2 },
        end: { line: 4, character: 8 },
      },
      severity: 1,
      message: "Cannot find name 'foo'.",
      source: "ts",
      code: 2304,
    });

    expect(item).toEqual({
      file: "/repo/src/index.ts",
      line: 5,
      column: 3,
      severity: "error",
      message: "Cannot find name 'foo'.",
      source: "ts",
      code: "2304",
    });
  });

  it("filters diagnostics by maximum severity", () => {
    const diagnostics = [
      { severity: "error" as const, file: "a", line: 1, column: 1, message: "e" },
      { severity: "warning" as const, file: "a", line: 2, column: 1, message: "w" },
      { severity: "info" as const, file: "a", line: 3, column: 1, message: "i" },
    ];

    expect(serviceTest.filterBySeverity(diagnostics, "warning").map((item) => item.severity)).toEqual([
      "error",
      "warning",
    ]);
  });

  it("finds project roots by nearest marker", () => {
    const root = makeTempProject();
    try {
      const found = serviceTest.findNearestRoot(join(root, "src", "index.ts"), root, ["package.json"]);
      expect(found).toBe(serviceTest.normalizePath(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes pending initialization clients in shutdown snapshots", () => {
    const running = { id: "typescript", process: "running" };
    const pending = { id: "python", process: "pending" };
    const clients = new Map([["typescript:/repo", running]]);
    const pendingClients = new Set([pending, running]);

    expect(serviceTest.collectUniqueClients(clients.values(), pendingClients.values())).toEqual([running, pending]);
  });
});

describe("lsp-manager status command", () => {
  it("formats configured, missing, and running server states", () => {
    const statuses: LspStatusItem[] = [
      {
        id: "typescript",
        command: "typescript-language-server",
        extensions: [".ts"],
        available: true,
        running: true,
        openFiles: 2,
        diagnostics: 1,
        root: "/repo",
      },
      {
        id: "python",
        command: "pyright-langserver",
        extensions: [".py"],
        available: false,
        running: false,
        openFiles: 0,
        diagnostics: 0,
      },
    ];
    const service = { status: () => statuses } as never;

    const text = indexTest.formatStatus(service);

    expect(text).toContain("LSP servers:");
    expect(text).toContain("- typescript: running, installed (typescript-language-server) — 2 open file(s), 1 diagnostic(s)");
    expect(text).toContain("root: /repo");
    expect(text).toContain("- python: stopped, missing (pyright-langserver)");
  });
});

describe("lsp-manager extension registry", () => {
  it("publishes and clears the service registry entry", () => {
    const events = {
      emitted: [] as Array<[string, unknown]>,
      emit(name: string, payload: unknown) {
        this.emitted.push([name, payload]);
      },
    };
    const pi = { events } as never;
    const service = { status: () => [] } as never;

    indexTest.publishService(pi, service);
    expect((events as Record<string, unknown>)["lsp-manager:service"]).toBe(service);
    expect(events.emitted[0]?.[0]).toBe("lsp-manager:ready");

    indexTest.clearService(pi, service);
    expect((events as Record<string, unknown>)["lsp-manager:service"]).toBeUndefined();
  });
});
