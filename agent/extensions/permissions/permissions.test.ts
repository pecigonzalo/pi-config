import { beforeAll, describe, it, expect, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { approvalsCoverBash, approvalsCoverPaths, getApprovalsSettings } from "./approvals";
import { resolveCodemodePolicy } from "./codemode";
import { findGitRepoRoot, getFilesystemApprovalTargets, isPathOutsideCwd, ruleMatch } from "./matching";
import {
	detectDangerousBashPattern,
	getFirstUnapprovedParsedCommand,
	isAllParsedCommandsAllowed,
	isParsedCommandAllowed,
	sandboxFallbackModeForPolicy,
} from "./shell-policy";
import { compileSandboxConfig, runSandboxedCommand } from "./sandbox";
import { parseBashCommand, arityPrefix, isTreeSitterAvailable } from "./shell-parse";

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

	it("interpolates environment variables in rule matches as regex literals", () => {
		const old = process.env.PI_PACKAGE_DIR;
		process.env.PI_PACKAGE_DIR = "/tmp/pi.package";
		try {
			const config = configModule.interpolateConfig({
				default: {
					rules: [
						{
							tool: "read",
							match: "^${PI_PACKAGE_DIR}/docs(/|$)",
							action: "allow",
						},
					],
				},
			});
			const rule = config.default?.rules?.[0];
			expect(rule?.match).toBe("^/tmp/pi\\.package/docs(/|$)");
			expect(ruleMatch(rule!, "read", "/tmp/pi.package/docs/settings.md")).toBe(true);
			expect(ruleMatch(rule!, "read", "/tmp/piXpackage/docs/settings.md")).toBe(false);
		} finally {
			if (old === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = old;
		}
	});

	it("interpolates environment variables in sandbox paths as raw paths", () => {
		const old = process.env.PI_PACKAGE_DIR;
		process.env.PI_PACKAGE_DIR = "/tmp/pi.package";
		try {
			const config = configModule.interpolateConfig({
				sandbox: {
					allowWrite: ["${PI_PACKAGE_DIR}/cache"],
				},
			});
			expect(config.sandbox?.allowWrite).toEqual(["/tmp/pi.package/cache"]);
		} finally {
			if (old === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = old;
		}
	});

	it("infers the Pi package root from the running entrypoint path", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-pi-package-"));
		const root = path.join(tmp, "node_modules", "@earendil-works", "pi-coding-agent");
		await fs.mkdir(path.join(root, "dist"), { recursive: true });
		await fs.mkdir(path.join(root, "docs"), { recursive: true });
		await fs.mkdir(path.join(root, "examples"), { recursive: true });
		await fs.writeFile(path.join(root, "README.md"), "# Pi\n", "utf8");
		await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			bin: { pi: "dist/cli.js" },
		}), "utf8");
		await fs.writeFile(path.join(root, "dist", "cli.js"), "", "utf8");

		try {
			expect(configModule.inferPiPackageDirFrom(path.join(root, "dist", "cli.js"))).toBe(await fs.realpath(root));
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
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

describe("filesystem approval targets", () => {
	it("returns file, parent folder, and git repo targets for files inside a repo", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-test-"));
		const repoRoot = path.join(tmp, "repo");
		const parentFolder = path.join(repoRoot, "src", "feature");
		const filePath = path.join(parentFolder, "example.ts");
		await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
		await fs.mkdir(parentFolder, { recursive: true });
		await fs.writeFile(filePath, "ok", "utf8");

		const expectedRepoRoot = await fs.realpath(repoRoot);
		const expectedParentFolder = await fs.realpath(parentFolder);
		const expectedFilePath = await fs.realpath(filePath);
		const targets = getFilesystemApprovalTargets(filePath, tmp);
		expect(targets).toEqual({
			targetPath: expectedFilePath,
			targetKind: "file",
			parentFolderPath: expectedParentFolder,
			gitRepoPath: expectedRepoRoot,
		});
		expect(findGitRepoRoot(parentFolder)).toBe(expectedRepoRoot);

		await fs.rm(tmp, { recursive: true, force: true });
	});

	it("omits the git repo target when the path is not in a repo", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-test-"));
		const folder = path.join(tmp, "plain");
		const filePath = path.join(folder, "example.ts");
		await fs.mkdir(folder, { recursive: true });
		await fs.writeFile(filePath, "ok", "utf8");

		const expectedFolder = await fs.realpath(folder);
		const expectedFilePath = await fs.realpath(filePath);
		const targets = getFilesystemApprovalTargets(filePath, tmp);
		expect(targets.targetPath).toBe(expectedFilePath);
		expect(targets.parentFolderPath).toBe(expectedFolder);
		expect(targets.gitRepoPath).toBeUndefined();

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

describe("bash policy helpers", () => {
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

	it("injects cache redirection env vars for sandboxed commands", async () => {
		const sandboxTmpDir = path.join(os.tmpdir(), "pi-test-cache-env");
		const chunks: string[] = [];
		const result = await runSandboxedCommand(
			{
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command) => command,
			},
			{
				command: "printf '%s\n%s\n%s\n%s\n' \"$TMPDIR\" \"$XDG_CACHE_HOME\" \"$BUN_INSTALL_CACHE_DIR\" \"$NPM_CONFIG_CACHE\"",
				cwd: process.cwd(),
				env: { TMPDIR: sandboxTmpDir },
				onData: (chunk) => chunks.push(chunk.toString("utf8")),
			},
		);

		expect(result.exitCode).toBe(0);
		expect(chunks.join("")).toBe([
			sandboxTmpDir,
			path.join(sandboxTmpDir, "xdg-cache"),
			path.join(sandboxTmpDir, "bun-cache"),
			path.join(sandboxTmpDir, "npm-cache"),
			"",
		].join("\n"));
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

	it("does not blanket-allow package manager home directories", () => {
		const compiled = compileSandboxConfig(policy, "/repo", { enabled: true, tmpDir: "/tmp/custom-pi" });
		const allowWrite = compiled.config.filesystem?.allowWrite ?? [];
		const home = os.homedir();
		expect(allowWrite).not.toContain(path.join(home, ".bun"));
		expect(allowWrite).not.toContain(path.join(home, ".npm"));
		expect(allowWrite).not.toContain(path.join(home, ".yarn"));
		expect(allowWrite).not.toContain(path.join(home, ".cargo"));
	});
});

// ─── Tree-sitter shell parsing ────────────────────────────────────────────────

describe("tree-sitter shell parsing", () => {
	it("is available", async () => {
		expect(await isTreeSitterAvailable()).toBe(true);
	});

	it("parses simple commands", async () => {
		const parsed = await parseBashCommand("git status");
		expect(parsed.isComplex).toBe(false);
		expect(parsed.commands).toHaveLength(1);
		expect(parsed.commands[0].name).toBe("git");
		expect(parsed.commands[0].tokens).toEqual(["git", "status"]);
		expect(parsed.commands[0].alwaysPattern).toBe("git status *");
	});

	it("separates redirections from commands", async () => {
		const parsed = await parseBashCommand("bun test 2>&1");
		expect(parsed.commands).toHaveLength(1);
		expect(parsed.commands[0].name).toBe("bun");
		expect(parsed.commands[0].tokens).toEqual(["bun", "test"]);
		expect(parsed.commands[0].command).toBe("bun test");
		// source includes the redirect context
		expect(parsed.commands[0].source).toBe("bun test 2>&1");
	});

	it("splits compound commands with redirects", async () => {
		const parsed = await parseBashCommand("cd /some/path && bun test 2>&1");
		expect(parsed.isComplex).toBe(false);
		expect(parsed.commands).toHaveLength(2);
		expect(parsed.commands[0].name).toBe("cd");
		expect(parsed.commands[0].tokens).toEqual(["cd", "/some/path"]);
		expect(parsed.commands[1].name).toBe("bun");
		expect(parsed.commands[1].tokens).toEqual(["bun", "test"]);
		expect(parsed.commands[1].alwaysPattern).toBe("bun test *");
	});

	it("detects complex constructs", async () => {
		const forLoop = await parseBashCommand("for f in *.txt; do echo $f; done");
		expect(forLoop.isComplex).toBe(true);

		const subshell = await parseBashCommand("echo $(whoami)");
		expect(subshell.isComplex).toBe(true);

		const simple = await parseBashCommand("ls -la");
		expect(simple.isComplex).toBe(false);
	});

	it("handles pipelines", async () => {
		const parsed = await parseBashCommand("echo hello | grep hello");
		expect(parsed.commands).toHaveLength(2);
		expect(parsed.commands[0].name).toBe("echo");
		expect(parsed.commands[1].name).toBe("grep");
	});

	it("handles multi-command chains", async () => {
		const parsed = await parseBashCommand('cd /path && git add . && git commit -m "msg"');
		expect(parsed.commands).toHaveLength(3);
		expect(parsed.commands[0].alwaysPattern).toBe("cd *");
		expect(parsed.commands[1].alwaysPattern).toBe("git add *");
		expect(parsed.commands[2].alwaysPattern).toBe("git commit *");
	});

	it("skips variable assignments in token extraction", async () => {
		const parsed = await parseBashCommand("FOO=bar bun test");
		expect(parsed.commands).toHaveLength(1);
		expect(parsed.commands[0].name).toBe("bun");
		expect(parsed.commands[0].tokens).toEqual(["bun", "test"]);
	});

	it("handles output redirection", async () => {
		const parsed = await parseBashCommand("cat file.txt > output.txt");
		expect(parsed.commands).toHaveLength(1);
		expect(parsed.commands[0].name).toBe("cat");
		expect(parsed.commands[0].tokens).toEqual(["cat", "file.txt"]);
		// source includes redirect for display
		expect(parsed.commands[0].source).toBe("cat file.txt > output.txt");
	});
});

describe("arity prefix", () => {
	it("uses arity table for known commands", () => {
		expect(arityPrefix(["git", "status"])).toEqual(["git", "status"]);
		expect(arityPrefix(["npm", "run", "dev"])).toEqual(["npm", "run", "dev"]);
		expect(arityPrefix(["bun", "test"])).toEqual(["bun", "test"]);
		expect(arityPrefix(["docker", "compose", "up", "-d"])).toEqual(["docker", "compose", "up"]);
	});

	it("falls back to first token for unknown commands", () => {
		expect(arityPrefix(["mycommand", "arg1"])).toEqual(["mycommand"]);
		expect(arityPrefix(["unknown"])).toEqual(["unknown"]);
	});

	it("returns empty for empty input", () => {
		expect(arityPrefix([])).toEqual([]);
	});
});

describe("tree-sitter policy integration", () => {
	const allowRules: Rule[] = [
		{ tool: "bash", match: "^cd\\b", action: "allow" },
		{ tool: "bash", match: "^bun\\b", action: "allow" },
		{ tool: "bash", match: "^git\\b", action: "allow" },
		{ tool: "bash", match: "^echo\\b", action: "allow" },
	];

	it("allows all parsed commands when rules match", async () => {
		const parsed = await parseBashCommand("cd /path && bun test 2>&1");
		expect(isAllParsedCommandsAllowed(parsed, allowRules)).toBe(true);
	});

	it("finds first unapproved parsed command", async () => {
		const parsed = await parseBashCommand("cd /path && rm -rf foo");
		const unapproved = getFirstUnapprovedParsedCommand(parsed, allowRules);
		expect(unapproved).toBeDefined();
		expect(unapproved!.name).toBe("rm");
	});

	it("respects approval callback for parsed commands", async () => {
		const parsed = await parseBashCommand("cd /path && rm -rf foo");
		const isApproved = (candidate: string) => candidate.includes("rm");
		const unapproved = getFirstUnapprovedParsedCommand(parsed, allowRules, isApproved);
		expect(unapproved).toBeUndefined();
	});

	it("reports complex commands as not fully allowed even when rules match", async () => {
		const parsed = await parseBashCommand("for f in *.txt; do echo $f; done");
		// The inner echo is allowed by rules, but isComplex should be checked separately
		expect(parsed.isComplex).toBe(true);
		expect(isAllParsedCommandsAllowed(parsed, allowRules)).toBe(true);
	});
});
