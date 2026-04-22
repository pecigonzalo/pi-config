import { beforeAll, describe, it, expect, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { approvalsCoverBash, approvalsCoverPaths, getApprovalsSettings } from "./approvals";
import { resolveCodemodePolicy } from "./codemode";
import { isPathOutsideCwd, ruleMatch } from "./matching";
import {
	detectDangerousBashPattern,
	getBashPrefixCandidates,
	getFirstUnapprovedBashSegment,
	hasComplexBashSyntax,
	hasForbiddenSimpleBashCompoundSyntax,
	isAllowedBashCompound,
	isAllowedSimpleBashCommand,
	sandboxFallbackModeForPolicy,
	splitSimpleBashCompound,
} from "./shell-policy";
import { compileSandboxConfig, runSandboxedCommand } from "./sandbox";

let configModule: typeof import("./config");

beforeAll(async () => {
	const td = process.env.TMPDIR || os.tmpdir();
	await fs.mkdir(td, { recursive: true });
	mock.module("@mariozechner/pi-coding-agent", () => ({
		getAgentDir: () => "/tmp",
	}));
	configModule = await import("./config");
});

describe("permissions config merge", () => {
	it("deep-merges default config with project-local precedence", () => {
		const merged = configModule.mergeDefaultConfig(
			{ mode: "workspace-write", externalPath: "ask", rules: [{ tool: "read", action: "block" }] },
			{ externalPath: "block", rules: [{ tool: "bash", action: "ask" }] },
		);

		expect(merged?.mode).toBe("workspace-write");
		expect(merged?.externalPath).toBe("block");
		expect(merged?.rules?.map((r) => r.tool)).toEqual(["bash", "read"]);
	});

	it("resolves protected resources with explicit unprotect overrides", () => {
		const resolved = configModule.resolveProtectedResources({
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

		const isOutside = isPathOutsideCwd("link/secret.txt", cwd);
		expect(isOutside).toBe(true);

		await fs.rm(tmp, { recursive: true, force: true });
	});

	it("treats normal in-project paths as internal", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-test-"));
		const cwd = path.join(tmp, "cwd");
		await fs.mkdir(cwd, { recursive: true });
		await fs.writeFile(path.join(cwd, "a.txt"), "ok", "utf8");

		expect(isPathOutsideCwd("a.txt", cwd)).toBe(false);
		await fs.rm(tmp, { recursive: true, force: true });
	});
});

describe("scoped approvals", () => {
	it("does not reuse path approvals across project boundaries", () => {
		const settings = getApprovalsSettings({ approvals: { scopeByProject: true, scopeByAgent: true } });
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
			approvalsCoverPaths(approvals, "read", ["/repo-a/external/file.txt"], "/repo-a", "reviewer", settings),
		).toBe(true);
		expect(
			approvalsCoverPaths(approvals, "read", ["/repo-a/external/file.txt"], "/repo-b", "reviewer", settings),
		).toBe(false);
	});

	it("matches bash exact and prefix approvals", () => {
		const settings = getApprovalsSettings({ approvals: { scopeByProject: true, scopeByAgent: true } });
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

		expect(approvalsCoverBash(approvals, "git status", "/repo-a", "default", settings)).toBe(true);
		expect(approvalsCoverBash(approvals, "npm run test", "/repo-a", "default", settings)).toBe(true);
		expect(approvalsCoverBash(approvals, "npm run test", "/repo-a", "reviewer", settings)).toBe(false);
	});

	it("lets approvals cover a compound segment when evaluated separately", () => {
		const settings = getApprovalsSettings({ approvals: { scopeByProject: true, scopeByAgent: true } });
		const approvals = [
			{
				tool: "bash",
				scopeType: "bash-prefix" as const,
				scopeValue: "sed -n",
				projectRoot: "/repo-a",
				agentName: "default",
				createdAt: Date.now(),
			},
		];

		expect(approvalsCoverBash(approvals, "sed -n '1,200p'", "/repo-a", "default", settings)).toBe(true);
		expect(approvalsCoverBash(approvals, "rg foo | sed -n '1,200p'", "/repo-a", "default", settings)).toBe(false);
	});
});

describe("bash complexity and fallback", () => {
	it("detects complex shell commands", () => {
		expect(hasComplexBashSyntax("cat file.txt")).toBe(false);
		expect(hasComplexBashSyntax('rg -n "foo|bar|baz" permissions.ts')).toBe(false);
		expect(hasComplexBashSyntax("echo 'foo && bar || baz'")).toBe(false);
		expect(hasComplexBashSyntax("cat file.txt && rm -rf tmp")).toBe(true);
		expect(hasComplexBashSyntax("echo hi | wc -l")).toBe(true);
		expect(hasComplexBashSyntax("rg foo & head")).toBe(true);
		expect(hasComplexBashSyntax("printf '%s\\n' foo\nbar")).toBe(true);
	});

	it("recognizes shell syntax forbidden for simple compounds", () => {
		expect(hasForbiddenSimpleBashCompoundSyntax("rg foo src | head -10")).toBe(false);
		expect(hasForbiddenSimpleBashCompoundSyntax("rg foo src && head -10")).toBe(false);
		expect(hasForbiddenSimpleBashCompoundSyntax("rg foo src || head -10")).toBe(false);
		expect(hasForbiddenSimpleBashCompoundSyntax('rg -n "foo|bar" src')).toBe(false);
		expect(hasForbiddenSimpleBashCompoundSyntax("rg foo src > out.txt")).toBe(true);
		expect(hasForbiddenSimpleBashCompoundSyntax("rg foo src ; head -10")).toBe(true);
	});

	it("splits simple bash compounds but rejects unsupported edge cases", () => {
		expect(splitSimpleBashCompound("rg foo src | head -10")).toEqual(["rg foo src", "head -10"]);
		expect(splitSimpleBashCompound("find . -type f | rg permissions | head")).toEqual([
			"find . -type f",
			"rg permissions",
			"head",
		]);
		expect(splitSimpleBashCompound("rg foo src || head -10 && pwd")).toEqual([
			"rg foo src",
			"head -10",
			"pwd",
		]);
		expect(splitSimpleBashCompound("rg 'foo|bar||baz&&qux' src")).toEqual(["rg 'foo|bar||baz&&qux' src"]);
		expect(splitSimpleBashCompound('rg "foo|bar" src | head')).toEqual(['rg "foo|bar" src', "head"]);
		expect(splitSimpleBashCompound(String.raw`rg foo \| head`)).toEqual([String.raw`rg foo \| head`]);
		expect(splitSimpleBashCompound("| head -10")).toBeUndefined();
		expect(splitSimpleBashCompound("rg foo src |")).toBeUndefined();
		expect(splitSimpleBashCompound("rg foo src &&")).toBeUndefined();
		expect(splitSimpleBashCompound("rg foo src & head -10")).toBeUndefined();
		expect(splitSimpleBashCompound("rg 'foo src | head -10")).toBeUndefined();
		expect(splitSimpleBashCompound("rg foo src ; head -10")).toBeUndefined();
	});

	it("builds safe prefix candidates for bash approvals", () => {
		expect(getBashPrefixCandidates("git status --short")).toEqual(["git", "git status"]);
		expect(getBashPrefixCandidates("awk '{print $1}'")).toEqual(["awk"]);
		expect(getBashPrefixCandidates("npm run test")).toEqual(["npm", "npm run"]);
		expect(getBashPrefixCandidates(String.raw`rg foo\ bar`)).toEqual(["rg"]);
	});

	it("allows compounds only when every segment is individually allowed", () => {
		const rules = [
			{ tool: "bash", match: "cd *", action: "allow" as const },
			{ tool: "bash", match: "rg *", action: "allow" as const },
			{ tool: "bash", match: "find *", action: "allow" as const },
			{ tool: "bash", match: "head *", action: "allow" as const },
			{ tool: "bash", match: "sort *", action: "allow" as const },
			{ tool: "bash", match: "bun *", action: "allow" as const },
			{ tool: "bash", action: "ask" as const },
		];

		expect(isAllowedSimpleBashCommand("rg foo src", rules)).toBe(true);
		expect(isAllowedSimpleBashCommand("sed -n 1,10p file", rules)).toBe(false);
		expect(isAllowedBashCompound("rg foo src | head -10", rules)).toBe(true);
		expect(isAllowedBashCompound("find . -type f | rg foo | sort", rules)).toBe(true);
		expect(isAllowedBashCompound("cd /tmp && bun test", rules)).toBe(true);
		expect(getFirstUnapprovedBashSegment("cd /tmp && bun test", rules)).toBeUndefined();
		expect(isAllowedBashCompound("rg foo src || head -10 && pwd", [
			{ tool: "bash", match: "rg *", action: "allow" as const },
			{ tool: "bash", match: "find *", action: "allow" as const },
			{ tool: "bash", match: "head *", action: "allow" as const },
			{ tool: "bash", match: "sort *", action: "allow" as const },
			{ tool: "bash", match: "pwd *", action: "allow" as const },
			{ tool: "bash", action: "ask" as const },
		])).toBe(true);
		expect(isAllowedBashCompound("rg foo src | sed -n 1,10p", rules)).toBe(false);
		expect(getFirstUnapprovedBashSegment("rg foo src | sed -n 1,10p", rules)).toBe("sed -n 1,10p");
		expect(isAllowedBashCompound("rg foo src | sed -n 1,10p", rules, (command) => command.startsWith("sed -n"))).toBe(true);
		expect(getFirstUnapprovedBashSegment("rg foo src | sed -n 1,10p", rules, (command) => command.startsWith("sed -n"))).toBeUndefined();
		expect(isAllowedBashCompound("rg foo src | rm -rf tmp", rules)).toBe(false);
		expect(isAllowedBashCompound("rg foo src && head -10", rules)).toBe(true);
		expect(isAllowedBashCompound("rg foo src && head -10 & pwd", rules)).toBe(false);
	});

	it("detects dangerous bash patterns", () => {
		expect(detectDangerousBashPattern("rm -rf tmp")).toBe("Deletes files");
		expect(detectDangerousBashPattern("sudo ls")).toBe("Elevated privileges");
		expect(detectDangerousBashPattern("git status")).toBeUndefined();
	});

	it("returns expected sandbox fallback mode by permission mode", () => {
		expect(sandboxFallbackModeForPolicy("plan")).toBe("block-all-bash");
		expect(sandboxFallbackModeForPolicy("workspace-write")).toBe("ask-all-bash");
		expect(sandboxFallbackModeForPolicy("full-access")).toBe("normal");
	});
});

describe("simple matcher shorthand", () => {
	it("treats bash 'rg' as word-boundary shorthand", () => {
		const rule = { tool: "bash", match: "rg", action: "allow" as const };
		expect(ruleMatch(rule, "bash", "rg foo src")).toBe(true);
		expect(ruleMatch(rule, "bash", "xrg foo src")).toBe(false);
	});

	it("treats bash 'rg *' as command-prefix shorthand", () => {
		const rule = { tool: "bash", match: "rg *", action: "allow" as const };
		expect(ruleMatch(rule, "bash", "rg foo src")).toBe(true);
		expect(ruleMatch(rule, "bash", "rg")).toBe(true);
		expect(ruleMatch(rule, "bash", "grep foo src")).toBe(false);
	});

	it("keeps regex behavior when regex metacharacters are used", () => {
		const rule = { tool: "bash", match: "^git\\b", action: "allow" as const };
		expect(ruleMatch(rule, "bash", "git status")).toBe(true);
		expect(ruleMatch(rule, "bash", "xgit status")).toBe(false);
	});
});

describe("codemode policy", () => {
	const basePolicy = {
		mode: "workspace-write" as const,
		rules: [],
		externalPath: "ask" as const,
		protectedResources: { denyRead: [], denyWrite: [] },
	};

	it("maps analysis profile to plan mode with limited capabilities", () => {
		const resolved = resolveCodemodePolicy(basePolicy, "/repo", { enabled: true, network: true }, "analysis");
		expect(resolved.mode).toBe("plan");
		expect(resolved.capabilities).toEqual(["message", "artifact"]);
		expect(resolved.allowProjectAgents).toBe(false);
		expect(resolved.sandbox.enabled).toBe(true);
		expect(resolved.sandbox.config.network?.allowedDomains).toEqual([]);
	});

	it("keeps orchestrator constrained even when outer mode is full-access", () => {
		const resolved = resolveCodemodePolicy(
			{ ...basePolicy, mode: "full-access" },
			"/repo",
			{ enabled: true, network: true },
			"orchestrator",
		);
		expect(resolved.mode).toBe("workspace-write");
		expect(resolved.capabilities).toEqual(["message", "artifact", "task", "todo"]);
		expect(resolved.sandbox.enabled).toBe(true);
	});
});

describe("sandboxed command runner", () => {
	it("runs wrapped commands and streams output", async () => {
		const chunks: string[] = [];
		const result = await runSandboxedCommand(
			{
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command) => command,
			},
			{
				command: "printf 'hello from sandbox'",
				cwd: process.cwd(),
				onData: (chunk) => chunks.push(chunk.toString("utf8")),
			},
		);

		expect(result.exitCode).toBe(0);
		expect(chunks.join("")).toContain("hello from sandbox");
	});

	it("rejects with timeout errors", async () => {
		await expect(
			runSandboxedCommand(
				{
					initialize: async () => {},
					reset: async () => {},
					wrapWithSandbox: async (command) => command,
				},
				{
					command: "sleep 1",
					cwd: process.cwd(),
					timeout: 0.01,
				},
			),
		).rejects.toThrow("timeout:0.01");
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
		const compiled = compileSandboxConfig(policy, "/repo", { enabled: true, network: true });
		expect(compiled.config.network?.allowedDomains).toBeUndefined();
		expect(compiled.config.network?.deniedDomains).toBeUndefined();
	});

	it("applies explicit allow/deny domain lists when provided", () => {
		const compiled = compileSandboxConfig(policy, "/repo", {
			enabled: true,
			network: true,
			allowedDomains: ["api.github.com", "*.npmjs.org", "api.github.com"],
			deniedDomains: ["malicious.example.com", "malicious.example.com"],
		});
		expect(compiled.config.network?.allowedDomains).toEqual(["api.github.com", "*.npmjs.org"]);
		expect(compiled.config.network?.deniedDomains).toEqual(["malicious.example.com"]);
	});

	it("blocks all network when disabled", () => {
		const compiled = compileSandboxConfig(policy, "/repo", { enabled: true, network: false });
		expect(compiled.config.network?.allowedDomains).toEqual([]);
		expect(compiled.config.network?.deniedDomains).toEqual([]);
	});

	it("includes configured tmpDir in allowWrite", () => {
		const compiled = compileSandboxConfig(policy, "/repo", { enabled: true, tmpDir: "/tmp/custom-pi" });
		expect(compiled.config.filesystem?.allowWrite).toContain("/tmp/custom-pi");
	});
});
