import { beforeAll, describe, it, expect, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
let __test__: Awaited<ReturnType<typeof import("./permissions")>>["__test"];

beforeAll(async () => {
	const td = process.env.TMPDIR || os.tmpdir();
	await fs.mkdir(td, { recursive: true });
	mock.module("@mariozechner/pi-coding-agent", () => ({
		createBashTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "" }] }) }),
		getAgentDir: () => "/tmp",
	}));
	mock.module("@mariozechner/pi-tui", () => ({
		matchesKey: () => false,
		Key: { escape: "escape" },
		Text: class {
			constructor(_text: string) {}
			render() { return []; }
			invalidate() {}
		},
	}));
	__test__ = (await import("./permissions")).__test__;
});

describe("permissions config merge", () => {
	it("deep-merges default config with project-local precedence", () => {
		const merged = __test__.mergeDefaultConfig(
			{ mode: "workspace-write", externalPath: "ask", rules: [{ tool: "read", action: "block" }] },
			{ externalPath: "block", rules: [{ tool: "bash", action: "ask" }] },
		);

		expect(merged?.mode).toBe("workspace-write");
		expect(merged?.externalPath).toBe("block");
		expect(merged?.rules?.map((r) => r.tool)).toEqual(["bash", "read"]);
	});

	it("resolves protected resources with explicit unprotect overrides", () => {
		const resolved = __test__.resolveProtectedResources({
			protectedResources: {
				enabled: true,
				defaults: true,
				addDenyRead: ["(^|[/])secrets/"],
				unprotectRead: ["\\.env(\\..+)?$"],
			},
		});

		expect(resolved.denyRead).toContain("(^|[/])secrets/");
		expect(resolved.denyRead).not.toContain("\\.env(\\..+)?$");
	});
});

describe("external path canonicalization", () => {
	it("detects symlink escapes as external", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-test-"));
		const cwd = path.join(tmp, "cwd");
		const outside = path.join(tmp, "outside");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(outside, { recursive: true });
		await fs.writeFile(path.join(outside, "secret.txt"), "x", "utf8");

		const linkPath = path.join(cwd, "link");
		await fs.symlink(outside, linkPath);

		const isOutside = __test__.isPathOutsideCwd("link/secret.txt", cwd);
		expect(isOutside).toBe(true);

		await fs.rm(tmp, { recursive: true, force: true });
	});

	it("treats normal in-project paths as internal", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-test-"));
		const cwd = path.join(tmp, "cwd");
		await fs.mkdir(cwd, { recursive: true });
		await fs.writeFile(path.join(cwd, "a.txt"), "ok", "utf8");

		expect(__test__.isPathOutsideCwd("a.txt", cwd)).toBe(false);
		await fs.rm(tmp, { recursive: true, force: true });
	});
});

describe("scoped approvals", () => {
	it("does not reuse path approvals across project boundaries", () => {
		const settings = __test__.getApprovalsSettings({ approvals: { scopeByProject: true, scopeByAgent: true } });
		const approvals = [
			{
				tool: "read",
				scopeType: "path-prefix" as const,
				scopeValue: "/repo-a/external",
				projectRoot: "/repo-a",
				agentName: "reviewer",
				createdAt: Date.now(),
			},
		];

		expect(
			__test__.approvalsCoverPaths(approvals, "read", ["/repo-a/external/file.txt"], "/repo-a", "reviewer", settings),
		).toBe(true);
		expect(
			__test__.approvalsCoverPaths(approvals, "read", ["/repo-a/external/file.txt"], "/repo-b", "reviewer", settings),
		).toBe(false);
	});

	it("matches bash exact and prefix approvals", () => {
		const settings = __test__.getApprovalsSettings({ approvals: { scopeByProject: true, scopeByAgent: true } });
		const approvals = [
			{
				tool: "bash",
				scopeType: "bash-exact" as const,
				scopeValue: "git status",
				projectRoot: "/repo-a",
				agentName: "default",
				createdAt: Date.now(),
			},
			{
				tool: "bash",
				scopeType: "bash-prefix" as const,
				scopeValue: "npm run",
				projectRoot: "/repo-a",
				agentName: "default",
				createdAt: Date.now(),
			},
		];

		expect(__test__.approvalsCoverBash(approvals, "git status", "/repo-a", "default", settings)).toBe(true);
		expect(__test__.approvalsCoverBash(approvals, "npm run test", "/repo-a", "default", settings)).toBe(true);
		expect(__test__.approvalsCoverBash(approvals, "npm run test", "/repo-a", "reviewer", settings)).toBe(false);
	});
});

describe("bash complexity and fallback", () => {
	it("detects complex shell commands", () => {
		expect(__test__.isComplexBashCommand("cat file.txt")).toBe(false);
		expect(__test__.isComplexBashCommand("cat file.txt && rm -rf tmp")).toBe(true);
		expect(__test__.isComplexBashCommand("echo hi | wc -l")).toBe(true);
	});

	it("detects dangerous bash patterns", () => {
		expect(__test__.detectDangerousBashPattern("rm -rf tmp")).toBe("Deletes files");
		expect(__test__.detectDangerousBashPattern("sudo ls")).toBe("Elevated privileges");
		expect(__test__.detectDangerousBashPattern("git status")).toBeUndefined();
	});

	it("returns expected sandbox fallback mode by permission mode", () => {
		expect(__test__.sandboxFallbackModeForPolicy("plan")).toBe("block-all-bash");
		expect(__test__.sandboxFallbackModeForPolicy("workspace-write")).toBe("ask-all-bash");
		expect(__test__.sandboxFallbackModeForPolicy("full-access")).toBe("normal");
	});
});

describe("simple matcher shorthand", () => {
	it("treats bash 'rg' as word-boundary shorthand", () => {
		const rule = { tool: "bash", match: "rg", action: "allow" as const };
		expect(__test__.ruleMatch(rule, "bash", "rg foo src")).toBe(true);
		expect(__test__.ruleMatch(rule, "bash", "xrg foo src")).toBe(false);
	});

	it("treats bash 'rg *' as command-prefix shorthand", () => {
		const rule = { tool: "bash", match: "rg *", action: "allow" as const };
		expect(__test__.ruleMatch(rule, "bash", "rg foo src")).toBe(true);
		expect(__test__.ruleMatch(rule, "bash", "rg")).toBe(true);
		expect(__test__.ruleMatch(rule, "bash", "grep foo src")).toBe(false);
	});

	it("keeps regex behavior when regex metacharacters are used", () => {
		const rule = { tool: "bash", match: "^git\\b", action: "allow" as const };
		expect(__test__.ruleMatch(rule, "bash", "git status")).toBe(true);
		expect(__test__.ruleMatch(rule, "bash", "xgit status")).toBe(false);
	});
});

describe("sandbox network config", () => {
	const policy = {
		mode: "workspace-write" as const,
		rules: [],
		externalPath: "ask" as const,
		protectedResources: { denyRead: [], denyWrite: [] },
	};

	it("uses unrestricted network shape by default when enabled", () => {
		const compiled = __test__.compileSandboxConfig(policy, "/repo", { enabled: true, network: true });
		expect(compiled.config.network?.allowedDomains).toBeUndefined();
		expect(compiled.config.network?.deniedDomains).toBeUndefined();
	});

	it("applies explicit allow/deny domain lists when provided", () => {
		const compiled = __test__.compileSandboxConfig(policy, "/repo", {
			enabled: true,
			network: true,
			allowedDomains: ["api.github.com", "*.npmjs.org", "api.github.com"],
			deniedDomains: ["malicious.example.com", "malicious.example.com"],
		});
		expect(compiled.config.network?.allowedDomains).toEqual(["api.github.com", "*.npmjs.org"]);
		expect(compiled.config.network?.deniedDomains).toEqual(["malicious.example.com"]);
	});

	it("blocks all network when disabled", () => {
		const compiled = __test__.compileSandboxConfig(policy, "/repo", { enabled: true, network: false });
		expect(compiled.config.network?.allowedDomains).toEqual([]);
		expect(compiled.config.network?.deniedDomains).toEqual([]);
	});

	it("includes configured tmpDir in allowWrite", () => {
		const compiled = __test__.compileSandboxConfig(policy, "/repo", { enabled: true, tmpDir: "/tmp/custom-pi" });
		expect(compiled.config.filesystem?.allowWrite).toContain("/tmp/custom-pi");
	});
});
