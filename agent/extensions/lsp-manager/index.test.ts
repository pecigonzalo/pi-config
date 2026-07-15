import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __test__ as serviceTest, type LspManagerService, type LspStatusItem } from "./service";
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
		expect(serviceTest.serverForFile("main.tf")?.id).toBe("terraform");
		expect(serviceTest.serverForFile("terraform.tfvars")?.id).toBe("terraform");
		expect(serviceTest.serverForFile("README.md")).toBeUndefined();
	});

	it("maps Terraform file suffixes to Terraform language IDs", () => {
		const terraform = serviceTest.serverForFile("main.tf");

		expect(terraform?.languageId("main.tf")).toBe("terraform");
		expect(terraform?.languageId("prod.tfvars")).toBe("terraform-vars");
		expect(terraform?.languageId("network.tfcomponent.hcl")).toBe("terraform-stack");
		expect(terraform?.languageId("deploy.tfdeploy.hcl")).toBe("terraform-deploy");
		expect(terraform?.languageId("search.tfquery.hcl")).toBe("terraform-search");
		expect(serviceTest.serverForFile("packer.pkr.hcl")).toBeUndefined();
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

	it("returns empty client configuration for supported language server sections", () => {
		const result = serviceTest.resolveWorkspaceConfiguration({
			items: [
				{ scopeUri: "file:///repo", section: "gopls" },
				{ scopeUri: "file:///repo", section: "typescript.preferences" },
				{ scopeUri: "file:///repo" },
				{ scopeUri: "file:///repo", section: "unknown-server" },
			],
		});

		expect(result).toEqual([{}, {}, {}, null]);
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

	it("rejects abortable LSP waits when cancelled", async () => {
		const controller = new AbortController();
		const pending = new Promise(() => undefined) as Promise<string>;

		const result = serviceTest.withAbort(pending, controller.signal).catch((error: Error) => error.message);
		controller.abort();

		await expect(result).resolves.toBe("aborted");
		expect(serviceTest.isAborted(controller.signal)).toBe(true);
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
		expect(text).toContain(
			"- typescript: running, installed (typescript-language-server) — 2 open file(s), 1 diagnostic(s)",
		);
		expect(text).toContain("root: /repo");
		expect(text).toContain("- python: stopped, missing (pyright-langserver)");
	});
});

describe("lsp-manager extension registry", () => {
	it("publishes and responds to service requests through the event bus", () => {
		const handlers = new Map<string, Set<(payload: unknown) => void>>();
		const events = {
			emitted: [] as Array<[string, unknown]>,
			emit(name: string, payload: unknown) {
				this.emitted.push([name, payload]);
				for (const handler of handlers.get(name) ?? []) handler(payload);
			},
			on(name: string, handler: (payload: unknown) => void) {
				const listeners = handlers.get(name) ?? new Set<(payload: unknown) => void>();
				listeners.add(handler);
				handlers.set(name, listeners);
				return () => listeners.delete(handler);
			},
		};
		const pi = { events } as never;
		let service: LspManagerService | undefined = { status: () => [] } as unknown as LspManagerService;

		const unsubscribe = indexTest.registerServiceResponder(pi, () => service);
		indexTest.publishService(pi, service);
		expect(events.emitted[0]?.[0]).toBe("lsp-manager:ready");
		expect(indexTest.requestService(pi)).toBe(service);

		indexTest.clearService(pi, service);
		service = undefined;
		expect(events.emitted.some(([name]) => name === "lsp-manager:shutdown")).toBe(true);
		expect(indexTest.requestService(pi)).toBeUndefined();

		unsubscribe();
	});
});
