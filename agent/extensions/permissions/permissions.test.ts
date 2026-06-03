import { afterAll, beforeAll, describe, it, expect, mock } from "bun:test";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile as execFileCallback } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { approvalsCoverBash, approvalsCoverPaths, extractApprovalRecords, getApprovalsSettings } from "./approvals";
import { resolveCodemodePolicy } from "./codemode";
import { GIT_METADATA_PROTECTED_RESOURCE_MATCH } from "./protected-resources";
import { findGitRepoRoot, getFilesystemApprovalTargets, isPathOutsideCwd, ruleMatch } from "./matching";
import {
	canAutoApproveParsedBash,
	detectDangerousBashPattern,
	getFirstUnapprovedParsedCommand,
	isAllParsedCommandsAllowed,
	isParsedCommandAllowed,
	sandboxFallbackModeForPolicy,
} from "./shell-policy";
import {
	compileSandboxConfig,
	createSandboxedBashOps,
	formatSandboxPromptHint,
	getSandboxTmpDirMode,
	getWorkspaceWritePaths,
	isSandboxWriteAllowedForPath,
	runSandboxedCommand,
	SandboxRuntimeAdapter,
} from "./sandbox";
import type { SandboxCommandExecution } from "./sandbox";
import {
	runSandboxedCommandAfterHealthCheck,
	SandboxHealthMonitor,
	shouldProbeSandboxAfterIdle,
} from "./sandbox-lifecycle";
import { parseBashCommand, arityPrefix, isTreeSitterAvailable } from "./shell-parse";
import type { Rule, SandboxRuntimeConfigLike } from "./shared";

const execFile = promisify(execFileCallback);
const TEST_SCRATCH_DIR = path.join(process.cwd(), ".tmp", "permissions-tests");

const GIT_REPOSITORY_ENV_KEYS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_PREFIX",
] as const;

function gitTestEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of GIT_REPOSITORY_ENV_KEYS) delete env[key];
	return env;
}

function execTestGit(args: string[], cwd: string) {
	return execFile("git", args, { cwd, env: gitTestEnv() });
}

type ParsedBashCommand = Awaited<ReturnType<typeof parseBashCommand>>;

type ParsedBashSubcommand = ParsedBashCommand["commands"][number];

function commandAt(parsed: ParsedBashCommand, index: number): ParsedBashSubcommand {
	const command = parsed.commands[index];
	if (!command) throw new Error(`Expected parsed command at index ${index}`);
	return command;
}

let configModule: typeof import("./config");

beforeAll(async () => {
	const td = process.env.TMPDIR || os.tmpdir();
	await fs.mkdir(td, { recursive: true });
	await fs.rm(TEST_SCRATCH_DIR, { recursive: true, force: true });
	await fs.mkdir(TEST_SCRATCH_DIR, { recursive: true });
	mock.module("@earendil-works/pi-coding-agent", () => ({
		...piCodingAgent,
		getAgentDir: () => "/tmp",
	}));
	configModule = await import("./config");
});

afterAll(async () => {
	await fs.rm(TEST_SCRATCH_DIR, { recursive: true, force: true });
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

	it("includes read-protected defaults in write-protected defaults", () => {
		const resolved = configModule.resolveProtectedResources({});

		expect(resolved.denyRead).toContain("\\.env(\\..+)?$");
		expect(resolved.denyWrite).toContain("\\.env(\\..+)?$");
		expect(resolved.denyRead).toContain("\\.(pem|key|p12|pfx|crt|ca-bundle)$");
		expect(resolved.denyWrite).toContain("\\.(pem|key|p12|pfx|crt|ca-bundle)$");
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

	it("interpolates environment variables in sandbox env values", () => {
		const old = process.env.PI_TEST_SOCKET_DIR;
		process.env.PI_TEST_SOCKET_DIR = "/tmp/pi sockets";
		try {
			const config = configModule.interpolateConfig({
				sandbox: {
					env: {
						GIT_SSH_COMMAND: "ssh -o ControlMaster=no -o ControlPath=${PI_TEST_SOCKET_DIR}/git.sock",
					},
				},
			});
			expect(config.sandbox?.env?.GIT_SSH_COMMAND).toBe("ssh -o ControlMaster=no -o ControlPath=/tmp/pi sockets/git.sock");
		} finally {
			if (old === undefined) delete process.env.PI_TEST_SOCKET_DIR;
			else process.env.PI_TEST_SOCKET_DIR = old;
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

	it("surfaces JSON parse errors for malformed files", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-config-parse-"));
		const filePath = path.join(tmp, "permissions.jsonc");
		await fs.writeFile(filePath, "{ invalid json", "utf8");
		const warnings: string[] = [];

		try {
			expect(configModule.readJsonFile(filePath, { onWarning: (message) => warnings.push(message) })).toBeUndefined();
			expect(warnings.some((message) => message.includes(filePath))).toBe(true);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("warns on malformed config roots instead of silently accepting them", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-config-root-"));
		const configDir = path.join(tmp, ".pi");
		const configPath = path.join(configDir, "permissions.jsonc");
		await fs.mkdir(configDir, { recursive: true });
		await fs.writeFile(configPath, "[]", "utf8");
		const warnings: string[] = [];

		try {
			configModule.loadConfig(tmp, { onWarning: (message) => warnings.push(message) });
			expect(warnings.some((message) => message.includes(configPath) && message.includes("expected object root"))).toBe(true);
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

	it("enforces token boundaries for bash-prefix approvals", () => {
		const settings = getApprovalsSettings({ approvals: { scopeByProject: true, scopeByAgent: true } });
		const approvals = [
			{
				tool: "bash",
				scopeType: "bash-prefix" as const,
				scopeValue: "rm",
				projectRoot: "/repo-a",
				agentName: "default",
				createdAt: Date.now(),
			},
		];

		expect(approvalsCoverBash(approvals, "rm -rf build", "/repo-a", "default", settings)).toBe(true);
		expect(approvalsCoverBash(approvals, "rmdir build", "/repo-a", "default", settings)).toBe(false);
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

describe("approval file parsing", () => {
	it("warns and drops malformed approval entries", () => {
		const warnings: string[] = [];
		const records = extractApprovalRecords(
			{
				approvals: [
					{ tool: "bash", scopeType: "bash-prefix", scopeValue: "git", createdAt: Date.now() },
					{ tool: "bash", scopeType: "bash-prefix", createdAt: Date.now() },
				],
			},
			(message) => warnings.push(message),
			"/tmp/permissions-approvals.json",
		);

		expect(records).toHaveLength(1);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Ignoring malformed approval entry #2");
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
		const originalGoCache = process.env.GOCACHE;
		const sandboxTmpDir = path.join(os.tmpdir(), "pi-test-cache-env");
		const globalGoCache = path.join(os.tmpdir(), "pi-test-global-go-cache");
		const chunks: string[] = [];
		let result: Awaited<ReturnType<typeof runSandboxedCommand>>;
		try {
			process.env.GOCACHE = globalGoCache;
			result = await runSandboxedCommand(
				{
					initialize: async () => {},
					reset: async () => {},
					wrapWithSandbox: async (command) => command,
				},
				{
					command: "printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \"$TMPDIR\" \"$XDG_CACHE_HOME\" \"$BUN_INSTALL_CACHE_DIR\" \"$NPM_CONFIG_CACHE\" \"$GOCACHE\" \"$GOTMPDIR\" \"$GOPATH\" \"$GOMODCACHE\"",
					cwd: process.cwd(),
					env: { TMPDIR: sandboxTmpDir },
					onData: (chunk) => chunks.push(chunk.toString("utf8")),
				},
			);
		} finally {
			if (originalGoCache === undefined) delete process.env.GOCACHE;
			else process.env.GOCACHE = originalGoCache;
		}

		expect(result.exitCode).toBe(0);
		expect(chunks.join("")).toBe([
			sandboxTmpDir,
			path.join(sandboxTmpDir, "xdg-cache"),
			path.join(sandboxTmpDir, "bun-cache"),
			path.join(sandboxTmpDir, "npm-cache"),
			globalGoCache,
			sandboxTmpDir,
			path.join(sandboxTmpDir, "go"),
			path.join(sandboxTmpDir, "go", "pkg", "mod"),
			"",
		].join("\n"));
	});

	it("lets sandbox env override Go cache redirection", async () => {
		const chunks: string[] = [];
		const result = await runSandboxedCommand(
			{
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command) => command,
			},
			{
				command: "printf '%s\n%s\n%s\n%s\n' \"$GOCACHE\" \"$GOTMPDIR\" \"$GOPATH\" \"$GOMODCACHE\"",
				cwd: process.cwd(),
				env: {
					GOCACHE: "/tmp/custom-go-cache",
					GOTMPDIR: "/tmp/custom-go-tmp",
					GOPATH: "/tmp/custom-go-path",
					GOMODCACHE: "/tmp/custom-go-mod-cache",
				},
				onData: (chunk) => chunks.push(chunk.toString("utf8")),
			},
		);

		expect(result.exitCode).toBe(0);
		expect(chunks.join("")).toBe([
			"/tmp/custom-go-cache",
			"/tmp/custom-go-tmp",
			"/tmp/custom-go-path",
			"/tmp/custom-go-mod-cache",
			"",
		].join("\n"));
	});

	it("uses runtime tmpdir overrides without mutating process env", async () => {
		const runtimeTmpDir = path.join(os.tmpdir(), "pi-runtime-tmp");
		const oldTmpDir = process.env.TMPDIR;
		const oldClaudeTmpDir = process.env.CLAUDE_TMPDIR;
		const chunks: string[] = [];
		let wrapTmpDir: string | undefined;
		let wrapClaudeTmpDir: string | undefined;

		const ops = createSandboxedBashOps(
			{
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command) => {
					wrapTmpDir = process.env.TMPDIR;
					wrapClaudeTmpDir = process.env.CLAUDE_TMPDIR;
					return command;
				},
			},
			runtimeTmpDir,
		);

		await ops.exec("printf '%s\n%s\n' \"$TMPDIR\" \"${CLAUDE_TMPDIR-unset}\"", process.cwd(), {
			onData: (chunk) => chunks.push(chunk.toString("utf8")),
		});

		expect(wrapTmpDir).toBe(runtimeTmpDir);
		expect(wrapClaudeTmpDir).toBe(runtimeTmpDir);
		expect(chunks.join("")).toBe([runtimeTmpDir, oldClaudeTmpDir ?? "unset", ""].join("\n"));
		expect(process.env.TMPDIR).toBe(oldTmpDir);
		expect(process.env.CLAUDE_TMPDIR).toBe(oldClaudeTmpDir);
	});

	it("passes the current sandbox config to each wrapped command", async () => {
		const sandboxConfig: SandboxRuntimeConfigLike = {
			filesystem: {
				allowWrite: ["/repo/current"],
				denyRead: [],
				denyWrite: [],
			},
			network: { allowLocalBinding: true },
		};
		let receivedConfig: Partial<SandboxRuntimeConfigLike> | undefined;

		const ops = createSandboxedBashOps(
			{
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command, _binShell, customConfig) => {
					receivedConfig = customConfig;
					return command;
				},
			},
			undefined,
			undefined,
			sandboxConfig,
		);

		await ops.exec("true", process.cwd(), { onData: () => {} });

		expect(receivedConfig).toBe(sandboxConfig);
	});

	it("resets the sandbox runtime only when the config key changes", async () => {
		const calls: string[] = [];
		const adapter = new SandboxRuntimeAdapter({
			initialize: async (_config) => {
				calls.push("initialize");
			},
			reset: async () => {
				calls.push("reset");
			},
			wrapWithSandbox: async (command) => command,
		});
		const sandboxConfig: SandboxRuntimeConfigLike = {
			filesystem: { denyRead: [], allowWrite: ["/repo"], denyWrite: [] },
			network: { allowLocalBinding: true },
		};

		await adapter.initialize(sandboxConfig, "key-1");
		await adapter.initialize(sandboxConfig, "key-1");
		await adapter.initialize(sandboxConfig, "key-2");

		expect(calls).toEqual(["reset", "initialize", "initialize", "reset", "initialize"]);
	});

	it("clears the adapter config key when reset", async () => {
		const calls: string[] = [];
		const adapter = new SandboxRuntimeAdapter({
			initialize: async (_config) => {
				calls.push("initialize");
			},
			reset: async () => {
				calls.push("reset");
			},
			wrapWithSandbox: async (command) => command,
		});
		const sandboxConfig: SandboxRuntimeConfigLike = {
			filesystem: { denyRead: [], allowWrite: ["/repo"], denyWrite: [] },
			network: { allowLocalBinding: true },
		};

		await adapter.initialize(sandboxConfig, "key-1");
		await adapter.reset();
		await adapter.initialize(sandboxConfig, "key-1");

		expect(calls).toEqual(["reset", "initialize", "reset", "reset", "initialize"]);
	});

	it("reports reset errors while still initializing with the requested config", async () => {
		const calls: string[] = [];
		const resetErrors: unknown[] = [];
		const adapter = new SandboxRuntimeAdapter({
			initialize: async (_config) => {
				calls.push("initialize");
			},
			reset: async () => {
				calls.push("reset");
				throw new Error("stale reset failed");
			},
			wrapWithSandbox: async (command) => command,
		});
		const sandboxConfig: SandboxRuntimeConfigLike = {
			filesystem: { denyRead: [], allowWrite: ["/repo"], denyWrite: [] },
			network: { allowLocalBinding: true },
		};

		await adapter.initialize(sandboxConfig, "key-1", {
			onResetError: (err) => resetErrors.push(err),
		});

		expect(calls).toEqual(["reset", "initialize"]);
		expect(resetErrors).toHaveLength(1);
		expect(resetErrors[0]).toBeInstanceOf(Error);
	});

	it("passes explicit execution policy through adapter command execution", async () => {
		const runtimeTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-adapter-exec-"));
		const sandboxConfig: SandboxRuntimeConfigLike = {
			filesystem: { denyRead: [], allowWrite: [runtimeTmpDir], denyWrite: [] },
			network: { allowLocalBinding: true },
		};
		const execution: SandboxCommandExecution = {
			config: sandboxConfig,
			tmpDir: runtimeTmpDir,
			env: { PI_TEST_ADAPTER_ENV: "adapter-env" },
		};
		let receivedConfig: Partial<SandboxRuntimeConfigLike> | undefined;
		const chunks: string[] = [];
		const adapter = new SandboxRuntimeAdapter({
			initialize: async () => {},
			reset: async () => {},
			wrapWithSandbox: async (command, _binShell, customConfig) => {
				receivedConfig = customConfig;
				return command;
			},
		});

		const result = await adapter.runCommand(execution, {
			command: "printf '%s\\n%s\\n' \"$TMPDIR\" \"$PI_TEST_ADAPTER_ENV\"",
			cwd: process.cwd(),
			onData: (chunk) => chunks.push(chunk.toString("utf8")),
		});

		expect(result.exitCode).toBe(0);
		expect(receivedConfig).toBe(sandboxConfig);
		expect(chunks.join("")).toBe(`${runtimeTmpDir}\nadapter-env\n`);
	});

	it("detects when an idle gap should trigger a sandbox health probe", () => {
		expect(shouldProbeSandboxAfterIdle(1_000, 1_999, 1_000)).toBe(false);
		expect(shouldProbeSandboxAfterIdle(1_000, 2_000, 1_000)).toBe(true);
		expect(shouldProbeSandboxAfterIdle(1_000, 2_001, 1_000)).toBe(true);
	});

	it("keeps sandbox health timestamps unchanged when pre-command checks fail", async () => {
		const healthMonitor = new SandboxHealthMonitor(1_000, 1_000);

		await expect(runSandboxedCommandAfterHealthCheck({
			healthMonitor,
			ensureHealthy: async () => {
				throw new Error("health check failed");
			},
			execute: async () => "unreachable",
			now: () => 3_000,
		})).rejects.toThrow("health check failed");

		expect(healthMonitor.getLastCommandAt()).toBe(1_000);
	});

	it("resets sandbox health timestamps at lifecycle boundaries", () => {
		const healthMonitor = new SandboxHealthMonitor(1_000, 1_000);
		healthMonitor.recordCommandFinished(3_000);

		healthMonitor.reset(4_000);

		expect(healthMonitor.getLastCommandAt()).toBe(4_000);
		expect(healthMonitor.shouldProbe(4_999)).toBe(false);
		expect(healthMonitor.shouldProbe(5_000)).toBe(true);
	});

	it("records sandbox command completion after successful health checks", async () => {
		const healthMonitor = new SandboxHealthMonitor(1_000, 1_000);

		const result = await runSandboxedCommandAfterHealthCheck({
			healthMonitor,
			ensureHealthy: async () => {},
			execute: async () => "done",
			now: () => 3_000,
		});

		expect(result).toBe("done");
		expect(healthMonitor.getLastCommandAt()).toBe(3_000);
	});

	it("records sandbox command completion after failed command execution", async () => {
		const healthMonitor = new SandboxHealthMonitor(1_000, 1_000);

		await expect(runSandboxedCommandAfterHealthCheck({
			healthMonitor,
			ensureHealthy: async () => {},
			execute: async () => {
				throw new Error("command failed");
			},
			now: () => 3_000,
		})).rejects.toThrow("command failed");

		expect(healthMonitor.getLastCommandAt()).toBe(3_000);
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

describe("permissions extension sandbox lifecycle", () => {
	type RegisteredTool = { execute: (...args: unknown[]) => Promise<unknown> };
	type RegisteredCommand = { handler: (args: string | undefined, ctx: ExtensionContext) => Promise<void> | void };

	async function setupPermissionsHarness(options: {
		mode: "plan" | "workspace-write";
		sandboxManager: { initialize: () => Promise<void>; reset: () => Promise<void>; wrapWithSandbox: (command: string) => Promise<string> };
		now: () => number;
		notifications?: string[];
	}) {
		await fs.mkdir(TEST_SCRATCH_DIR, { recursive: true });
		const tmp = await fs.mkdtemp(path.join(TEST_SCRATCH_DIR, "perm-extension-probe-"));
		const cwd = path.join(tmp, "repo");
		const sandboxTmpDir = path.join(tmp, "sandbox-tmp");
		await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".pi", "permissions.jsonc"),
			JSON.stringify({ default: { mode: options.mode }, sandbox: { enabled: true, tmpDir: sandboxTmpDir } }),
			"utf8",
		);
		mock.module("@anthropic-ai/sandbox-runtime", () => ({ SandboxManager: options.sandboxManager }));

		const originalDateNow = Date.now;
		Date.now = options.now;
		const tools = new Map<string, RegisteredTool>();
		const commands = new Map<string, RegisteredCommand>();
		const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<void> | void>>();
		const pi = {
			registerFlag: () => {},
			getFlag: () => false,
			registerTool: (tool: { name: string } & RegisteredTool) => {
				tools.set(tool.name, tool);
			},
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command);
			},
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		} as unknown as ExtensionAPI;
		const ctx = {
			cwd,
			hasUI: true,
			ui: { notify: (message: string) => options.notifications?.push(message) },
		} as unknown as ExtensionContext;

		const { default: registerPermissions } = await import("./permissions");
		registerPermissions(pi);
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);

		return {
			cwd,
			sandboxTmpDir,
			ctx,
			tools,
			commands,
			handlers,
			restore: async () => {
				Date.now = originalDateNow;
				await fs.rm(tmp, { recursive: true, force: true });
			},
		};
	}

	it("reports active sandbox status through the permissions command", async () => {
		let now = 0;
		const notifications: string[] = [];
		const harness = await setupPermissionsHarness({
			mode: "workspace-write",
			now: () => now,
			notifications,
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command: string) => command,
			},
		});
		try {
			await harness.commands.get("permissions")?.handler("sandbox status", harness.ctx);
		} finally {
			await harness.restore();
		}

		expect(notifications).toContain("Bash sandbox: active; bash exec mode: sandboxed");
	});

	it("reports fallback execution mode after the sandbox is disabled", async () => {
		let now = 0;
		const notifications: string[] = [];
		const harness = await setupPermissionsHarness({
			mode: "plan",
			now: () => now,
			notifications,
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command: string) => command,
			},
		});
		try {
			await harness.commands.get("permissions")?.handler("sandbox disable", harness.ctx);
		} finally {
			await harness.restore();
		}

		expect(notifications).toContain("Bash sandbox disabled for this session; bash exec mode: local (block-all-bash)");
	});

	it("runs sandbox repair through reset, initialize, and probe", async () => {
		let now = 0;
		let resetCount = 0;
		let initializeCount = 0;
		const notifications: string[] = [];
		const harness = await setupPermissionsHarness({
			mode: "workspace-write",
			now: () => now,
			notifications,
			sandboxManager: {
				initialize: async () => {
					initializeCount++;
				},
				reset: async () => {
					resetCount++;
				},
				wrapWithSandbox: async (command: string) => command,
			},
		});
		try {
			await harness.commands.get("permissions")?.handler("sandbox repair", harness.ctx);
		} finally {
			await harness.restore();
		}

		expect(resetCount).toBeGreaterThanOrEqual(2);
		expect(initializeCount).toBeGreaterThanOrEqual(2);
		expect(notifications.some((message) => message.startsWith("Bash sandbox repair completed."))).toBe(true);
	});

	it("uses tmpdir rather than cwd writes for idle health probes in plan mode", async () => {
		let now = 0;
		const wrappedCommands: string[] = [];
		const harness = await setupPermissionsHarness({
			mode: "plan",
			now: () => now,
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command: string) => {
					wrappedCommands.push(command);
					return command;
				},
			},
		});
		try {
			now = 5 * 60 * 1000;
			const bashTool = harness.tools.get("bash");
			if (!bashTool) throw new Error("bash tool was not registered");
			await bashTool.execute("probe-test", { command: "true" }, undefined, undefined, harness.ctx);
		} finally {
			await harness.restore();
		}

		expect(wrappedCommands.some((command) => command.includes(`${harness.sandboxTmpDir}${path.sep}.pi-sandbox-write-probe-`))).toBe(true);
		expect(wrappedCommands.some((command) => command.includes(`${harness.cwd}${path.sep}.pi-sandbox-write-probe-`))).toBe(false);
	});

	it("runs manual sandbox probes against tmpdir by default", async () => {
		let now = 0;
		const notifications: string[] = [];
		const wrappedCommands: string[] = [];
		const harness = await setupPermissionsHarness({
			mode: "workspace-write",
			now: () => now,
			notifications,
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command: string) => {
					wrappedCommands.push(command);
					return command;
				},
			},
		});
		try {
			await harness.commands.get("permissions")?.handler("sandbox probe", harness.ctx);
		} finally {
			await harness.restore();
		}

		expect(notifications.some((message) => message.includes("TMPDIR writes are allowed"))).toBe(true);
		expect(wrappedCommands.some((command) => command.includes(`${harness.sandboxTmpDir}${path.sep}.pi-sandbox-write-probe-`))).toBe(true);
		expect(wrappedCommands.some((command) => command.includes(`${harness.cwd}${path.sep}.pi-sandbox-write-probe-`))).toBe(false);
	});

	it("runs manual workspace probes only when explicitly requested", async () => {
		let now = 0;
		const notifications: string[] = [];
		const wrappedCommands: string[] = [];
		const harness = await setupPermissionsHarness({
			mode: "workspace-write",
			now: () => now,
			notifications,
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command: string) => {
					wrappedCommands.push(command);
					return command;
				},
			},
		});
		try {
			await harness.commands.get("permissions")?.handler("sandbox probe workspace", harness.ctx);
		} finally {
			await harness.restore();
		}

		expect(notifications.some((message) => message.includes("workspace writes are allowed"))).toBe(true);
		expect(wrappedCommands.some((command) => command.includes(`${harness.cwd}${path.sep}.pi-sandbox-write-probe-`))).toBe(true);
	});

	it("reports explicit manual workspace probes as skipped when policy does not allow workspace writes", async () => {
		let now = 0;
		const notifications: string[] = [];
		const wrappedCommands: string[] = [];
		const harness = await setupPermissionsHarness({
			mode: "plan",
			now: () => now,
			notifications,
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command: string) => {
					wrappedCommands.push(command);
					return command;
				},
			},
		});
		try {
			await harness.commands.get("permissions")?.handler("sandbox probe workspace", harness.ctx);
		} finally {
			await harness.restore();
		}

		expect(notifications.some((message) => message.includes("workspace write check skipped"))).toBe(true);
		expect(wrappedCommands.some((command) => command.includes(`${harness.cwd}${path.sep}.pi-sandbox-write-probe-`))).toBe(false);
	});

	it("retries idle health probes after failed pre-command repair attempts", async () => {
		let now = 0;
		let probeCount = 0;
		let commandCount = 0;
		const harness = await setupPermissionsHarness({
			mode: "workspace-write",
			now: () => now,
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command: string) => {
					if (command.includes(".pi-sandbox-write-probe-")) {
						probeCount++;
						throw new Error("stale sandbox runtime");
					}
					commandCount++;
					return command;
				},
			},
		});
		try {
			now = 5 * 60 * 1000;
			const bashTool = harness.tools.get("bash");
			if (!bashTool) throw new Error("bash tool was not registered");

			await expect(bashTool.execute("probe-test-1", { command: "true" }, undefined, undefined, harness.ctx)).rejects.toThrow("automatic repair failed");
			await expect(bashTool.execute("probe-test-2", { command: "true" }, undefined, undefined, harness.ctx)).rejects.toThrow("automatic repair failed");
		} finally {
			await harness.restore();
		}

		expect(probeCount).toBe(4);
		expect(commandCount).toBe(0);
	});

	it("executes the command after a successful automatic repair", async () => {
		let now = 0;
		let probeCount = 0;
		let commandCount = 0;
		const harness = await setupPermissionsHarness({
			mode: "workspace-write",
			now: () => now,
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command: string) => {
					if (command.includes(".pi-sandbox-write-probe-")) {
						probeCount++;
						if (probeCount === 1) throw new Error("stale sandbox runtime");
						return command;
					}
					commandCount++;
					return command;
				},
			},
		});
		try {
			now = 5 * 60 * 1000;
			const bashTool = harness.tools.get("bash");
			if (!bashTool) throw new Error("bash tool was not registered");

			await bashTool.execute("probe-test", { command: "true" }, undefined, undefined, harness.ctx);
		} finally {
			await harness.restore();
		}

		expect(probeCount).toBe(2);
		expect(commandCount).toBe(1);
	});
});

describe("sandbox tmpDir mode", () => {
	it("defaults to shared", () => {
		expect(getSandboxTmpDirMode(undefined)).toBe("shared");
		expect(getSandboxTmpDirMode({})).toBe("shared");
	});

	it("respects explicit mode overrides", () => {
		expect(getSandboxTmpDirMode({ tmpDirMode: "session" })).toBe("session");
		expect(getSandboxTmpDirMode({ tmpDirMode: "shared" })).toBe("shared");
	});
});

describe("sandbox prompt hint", () => {
	it("summarizes sandbox filesystem and blocked network constraints", () => {
		const hint = formatSandboxPromptHint(
			{
				network: { allowedDomains: [], deniedDomains: [] },
				filesystem: {
					allowWrite: ["/repo", "/tmp/pi"],
					denyRead: ["/repo/**/.env", "/repo/**/.ssh/**"],
					denyWrite: ["/repo/**/.git/config"],
				},
			},
			{
				reason: "mode=plan, tmpDir=/tmp/pi",
				tmpDir: "/tmp/pi",
				cwd: "/repo",
			},
		);

		expect(hint).toContain("Sandbox hint for bash: OS sandbox is active");
		expect(hint).toContain("Filesystem writes are limited to: ., /tmp/pi");
		expect(hint).toContain("Protected paths blocked: read ./**/.env, ./**/.ssh/**; write ./**/.git/config");
		expect(hint).toContain("Network: blocked");
		expect(hint).toContain("TMPDIR=/tmp/pi");
	});

	it("keeps unrestricted network hints compact", () => {
		const hint = formatSandboxPromptHint(
			{
				network: { allowLocalBinding: true },
				filesystem: {
					allowWrite: ["/repo", "/repo/.git", "/tmp/pi", "/var/tmp/pi", "/tmp/extra"],
				},
			},
			{ cwd: "/repo" },
		);

		expect(hint).toContain("Network: unrestricted; localhost binding allowed");
		expect(hint).toContain("Filesystem writes are limited to: ., ./.git, /tmp/pi, /var/tmp/pi, … +1 more");
		expect(hint).not.toContain("Protected paths blocked");
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

	it("allows macOS DNS config lookup when network is enabled", () => {
		const compiled = compileSandboxConfig(policy, "/repo", { enabled: true, network: true });
		if (process.platform === "darwin") {
			expect(compiled.config.network?.allowMachLookup).toContain("com.apple.SystemConfiguration.configd");
		} else {
			expect(compiled.config.network?.allowMachLookup).toBeUndefined();
		}
	});

	it("forwards configured macOS Mach lookup allowances", () => {
		const compiled = compileSandboxConfig(policy, "/repo", {
			enabled: true,
			network: true,
			allowMachLookup: ["com.example.service", "com.example.service"],
		});
		expect(compiled.config.network?.allowMachLookup).toContain("com.example.service");
		expect(compiled.config.network?.allowMachLookup?.filter((value) => value === "com.example.service")).toHaveLength(1);
	});

	it("forwards weaker macOS network isolation for Go TLS verification when configured", () => {
		const disabled = compileSandboxConfig(policy, "/repo", { enabled: true, network: true });
		expect(disabled.config.enableWeakerNetworkIsolation).toBeUndefined();

		const enabled = compileSandboxConfig(policy, "/repo", {
			enabled: true,
			network: true,
			enableWeakerNetworkIsolation: true,
		});
		expect(enabled.config.enableWeakerNetworkIsolation).toBe(true);
	});

	it("forwards allowLocalBinding when configured", () => {
		const disabled = compileSandboxConfig(policy, "/repo", { enabled: true, network: true });
		expect(disabled.config.network?.allowLocalBinding).toBeUndefined();

		const enabled = compileSandboxConfig(policy, "/repo", {
			enabled: true,
			network: true,
			allowLocalBinding: true,
		});
		expect(enabled.config.network?.allowLocalBinding).toBe(true);
	});

	it("allows localhost binding even when outbound network is disabled when explicitly configured", () => {
		const compiled = compileSandboxConfig(policy, "/repo", {
			enabled: true,
			network: false,
			allowLocalBinding: true,
		});
		expect(compiled.config.network?.allowedDomains).toEqual([]);
		expect(compiled.config.network?.deniedDomains).toEqual([]);
		expect(compiled.config.network?.allowLocalBinding).toBe(true);
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

	it("treats plan mode tmpdir writes as healthy without expecting cwd writes", () => {
		const compiled = compileSandboxConfig({ ...policy, mode: "plan" }, "/repo", { enabled: true, tmpDir: "/tmp/custom-pi" });
		expect(isSandboxWriteAllowedForPath(compiled.config, "/tmp/custom-pi")).toBe(true);
		expect(isSandboxWriteAllowedForPath(compiled.config, "/repo")).toBe(false);
	});

	it("does not expect cwd writes when custom allowWrite excludes the workspace", () => {
		const compiled = compileSandboxConfig(policy, "/repo", {
			enabled: true,
			tmpDir: "/tmp/custom-pi",
			allowWrite: ["/tmp/custom-output"],
		});

		expect(isSandboxWriteAllowedForPath(compiled.config, "/tmp/custom-pi")).toBe(true);
		expect(isSandboxWriteAllowedForPath(compiled.config, "/repo")).toBe(false);
	});

	it("keeps protected-resource globs from masking workspace write expectations", () => {
		expect(isSandboxWriteAllowedForPath(
			{
				filesystem: {
					allowWrite: ["/repo"],
					denyRead: [],
					denyWrite: ["/repo/**/.env", "/repo/**/.git/hooks/**"],
				},
			},
			"/repo",
		)).toBe(true);
	});

	it("recognizes broad deny globs that block direct workspace writes", () => {
		expect(isSandboxWriteAllowedForPath(
			{
				filesystem: {
					allowWrite: ["/repo"],
					denyRead: [],
					denyWrite: ["/repo/**"],
				},
			},
			"/repo",
		)).toBe(false);
	});

	it("expects workspace writes for the default protected-resource sandbox policy", () => {
		const compiled = compileSandboxConfig(policy, "/repo", { enabled: true, tmpDir: "/tmp/custom-pi" });
		expect(isSandboxWriteAllowedForPath(compiled.config, "/repo")).toBe(true);
	});

	it("allows Docker Buildx activity writes by default", () => {
		const compiled = compileSandboxConfig(policy, "/repo", { enabled: true, tmpDir: "/tmp/custom-pi" });
		expect(compiled.config.filesystem?.allowWrite).toContain(path.join(os.homedir(), ".docker", "buildx", "activity"));
	});

	it("uses sandbox DOCKER_CONFIG for Docker Buildx write allowances", () => {
		const compiled = compileSandboxConfig(policy, "/repo", {
			enabled: true,
			tmpDir: "/tmp/custom-pi",
			env: { DOCKER_CONFIG: "/tmp/custom-docker-config" },
		});
		expect(compiled.config.filesystem?.allowWrite).toContain("/tmp/custom-docker-config/buildx/activity");
	});

	it("includes current GOCACHE in default allowWrite", () => {
		const originalGoCache = process.env.GOCACHE;
		process.env.GOCACHE = "/tmp/custom-go-cache";
		try {
			const compiled = compileSandboxConfig(policy, "/repo", { enabled: true, tmpDir: "/tmp/custom-pi" });
			expect(compiled.config.filesystem?.allowWrite).toContain("/tmp/custom-go-cache");
		} finally {
			if (originalGoCache === undefined) delete process.env.GOCACHE;
			else process.env.GOCACHE = originalGoCache;
		}
	});

	it("includes current GOCACHE path aliases in default allowWrite", async () => {
		const originalGoCache = process.env.GOCACHE;
		const tmp = await fs.mkdtemp(path.join(TEST_SCRATCH_DIR, "go-cache-alias-"));
		const realGoCache = path.join(tmp, "real-go-cache");
		const linkedGoCache = path.join(tmp, "linked-go-cache");
		try {
			await fs.mkdir(realGoCache, { recursive: true });
			await fs.symlink(realGoCache, linkedGoCache, "dir");
			process.env.GOCACHE = linkedGoCache;

			const compiled = compileSandboxConfig(policy, "/repo", { enabled: true, tmpDir: "/tmp/custom-pi" });

			expect(compiled.config.filesystem?.allowWrite).toContain(path.resolve(linkedGoCache));
			expect(compiled.config.filesystem?.allowWrite).toContain(await fs.realpath(realGoCache));
		} finally {
			if (originalGoCache === undefined) delete process.env.GOCACHE;
			else process.env.GOCACHE = originalGoCache;
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("allows configured Go cache and temp paths", () => {
		const compiled = compileSandboxConfig(policy, "/repo", {
			enabled: true,
			tmpDir: "/tmp/custom-pi",
			env: {
				GOCACHE: "/tmp/config-go-cache",
				GOTMPDIR: "/tmp/config-go-tmp",
				GOPATH: "/tmp/config-go-path",
			},
		});

		expect(compiled.config.filesystem?.allowWrite).toContain("/tmp/config-go-cache");
		expect(compiled.config.filesystem?.allowWrite).toContain("/tmp/config-go-tmp");
		expect(compiled.config.filesystem?.allowWrite).toContain("/tmp/config-go-path");
		expect(compiled.config.filesystem?.allowWrite).toContain("/tmp/config-go-path/pkg/mod");
	});

	it("allows configured GOMODCACHE independently of GOPATH", () => {
		const compiled = compileSandboxConfig(policy, "/repo", {
			enabled: true,
			tmpDir: "/tmp/custom-pi",
			env: {
				GOPATH: "/tmp/config-go-path",
				GOMODCACHE: "/tmp/config-go-mod-cache",
			},
		});

		expect(compiled.config.filesystem?.allowWrite).toContain("/tmp/config-go-path");
		expect(compiled.config.filesystem?.allowWrite).toContain("/tmp/config-go-mod-cache");
		expect(compiled.config.filesystem?.allowWrite).not.toContain("/tmp/config-go-path/pkg/mod");
	});

	it("allows macOS Library caches by default", () => {
		const compiled = compileSandboxConfig(policy, "/repo", { enabled: true, tmpDir: "/tmp/custom-pi" });
		if (process.platform === "darwin") {
			expect(compiled.config.filesystem?.allowWrite).toContain(path.join(os.homedir(), "Library", "Caches"));
		} else {
			expect(compiled.config.filesystem?.allowWrite).not.toContain(path.join(os.homedir(), "Library", "Caches"));
		}
	});

	it("enables pseudo-terminal support by default and allows opting out", () => {
		const defaultConfig = compileSandboxConfig(policy, "/repo", { enabled: true });
		expect(defaultConfig.config.allowPty).toBe(true);

		const optOutConfig = compileSandboxConfig(policy, "/repo", { enabled: true, allowPty: false });
		expect(optOutConfig.config.allowPty).toBe(false);
	});

	it("allows Go to populate current GOCACHE outside the workspace", async () => {
		let currentGoCache: string;
		try {
			currentGoCache = (await execFile("go", ["env", "GOCACHE"])).stdout.trim();
		} catch {
			return;
		}
		if (!currentGoCache || currentGoCache === "off" || !path.isAbsolute(currentGoCache)) return;

		const originalGoCache = process.env.GOCACHE;
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-go-cache-"));
		const repo = path.join(tmp, "repo");

		try {
			await fs.mkdir(repo, { recursive: true });
			await fs.writeFile(path.join(repo, "go.mod"), "module example.com/pi-go-cache-test\n\ngo 1.18\n");
			await fs.writeFile(path.join(repo, "main_test.go"), `package gocachetest

import "testing"

const cacheBust = "${path.basename(tmp)}"

func TestGoCache(t *testing.T) {}
`);
			process.env.GOCACHE = currentGoCache;

			const compiled = compileSandboxConfig(policy, repo, { enabled: true, network: true });
			expect(compiled.config.filesystem?.allowWrite).toContain(currentGoCache);

			const chunks: string[] = [];
			const result = await runSandboxedCommand(
				{
					initialize: async () => {},
					reset: async () => {},
					wrapWithSandbox: async (command) => command,
				},
				{
					command: "go test ./...",
					cwd: repo,
					timeout: 30,
					onData: (chunk) => chunks.push(chunk.toString("utf8")),
				},
			);

			if (result.exitCode !== 0) throw new Error(chunks.join(""));
		} finally {
			if (originalGoCache === undefined) delete process.env.GOCACHE;
			else process.env.GOCACHE = originalGoCache;
			await fs.rm(tmp, { recursive: true, force: true });
		}
	}, 15_000);

	it("uses sandbox path globs rather than permission regexes for protected resources", () => {
		const protectedPolicy = {
			...policy,
			protectedResources: {
				denyRead: ["\\.env(\\..+)?$", "(^|[/])(\\.aws[/]|\\.ssh[/]|\\.gnupg[/])"],
				denyWrite: [GIT_METADATA_PROTECTED_RESOURCE_MATCH],
			},
		};
		const compiled = compileSandboxConfig(protectedPolicy, "/repo", { enabled: true });
		const denyRead = compiled.config.filesystem?.denyRead ?? [];
		const denyWrite = compiled.config.filesystem?.denyWrite ?? [];

		expect(denyRead).toContain("/repo/**/.env");
		expect(denyRead).toContain("/repo/**/.ssh/**");
		expect(denyRead).not.toContain("\\.env(\\..+)?$");
		expect(denyWrite).toContain("/repo/**/.git/config");
		expect(denyWrite).not.toContain(GIT_METADATA_PROTECTED_RESOURCE_MATCH);
	});

	it("warns when protected resource regexes cannot be mapped to sandbox paths", () => {
		const protectedPolicy = {
			...policy,
			protectedResources: {
				denyRead: [],
				denyWrite: ["(^|[/])custom-secret(/|$)"],
			},
		};

		const compiled = compileSandboxConfig(protectedPolicy, "/repo", { enabled: true });

		expect(compiled.warnings).toContain(
			"Protected write pattern has no sandbox path mapping and is only enforced by Pi tools: (^|[/])custom-secret(/|$)",
		);
	});

	it("resolves configured sandbox paths relative to the command cwd", () => {
		const compiled = compileSandboxConfig(policy, "/repo/packages/app", {
			enabled: true,
			allowWrite: ["dist"],
			denyRead: ["secrets"],
			denyWrite: ["generated/locked"],
		});

		expect(compiled.config.filesystem?.allowWrite).toContain("/repo/packages/app/dist");
		expect(compiled.config.filesystem?.denyRead).toContain("/repo/packages/app/secrets");
		expect(compiled.config.filesystem?.denyWrite).toContain("/repo/packages/app/generated/locked");
	});

	it("allows git metadata writes when cwd is below the repo root", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-git-sandbox-"));
		const repo = path.join(tmp, "repo");
		const subdir = path.join(repo, "packages", "app");
		await fs.mkdir(subdir, { recursive: true });
		await execTestGit(["init", "-q"], repo);

		try {
			const repoRealPath = await fs.realpath(repo);
			const subdirRealPath = await fs.realpath(subdir);
			const writePaths = getWorkspaceWritePaths(subdir);
			expect(writePaths).toContain(subdirRealPath);
			expect(writePaths).toContain(path.join(repoRealPath, ".git"));

			const compiled = compileSandboxConfig(policy, subdir, { enabled: true });
			expect(compiled.config.filesystem?.allowWrite).toContain(path.join(repoRealPath, ".git"));
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("denies resolved git hooks and config writes when cwd is below the repo root", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-git-deny-subdir-"));
		const repo = path.join(tmp, "repo");
		const subdir = path.join(repo, "packages", "app");
		await fs.mkdir(subdir, { recursive: true });
		await execTestGit(["init", "-q"], repo);

		try {
			const repoRealPath = await fs.realpath(repo);
			const protectedPolicy = {
				...policy,
				protectedResources: { denyRead: [], denyWrite: [GIT_METADATA_PROTECTED_RESOURCE_MATCH] },
			};
			const compiled = compileSandboxConfig(protectedPolicy, subdir, { enabled: true });
			const denyWrite = compiled.config.filesystem?.denyWrite ?? [];

			expect(denyWrite).toContain(path.join(repoRealPath, ".git", "hooks"));
			expect(denyWrite).toContain(path.join(repoRealPath, ".git", "hooks", "**"));
			expect(denyWrite).toContain(path.join(repoRealPath, ".git", "config"));
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("denies resolved git hooks and config writes from worktrees", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-git-deny-worktree-"));
		const repo = path.join(tmp, "repo");
		const worktree = path.join(tmp, "worktree");
		await fs.mkdir(repo, { recursive: true });
		await execTestGit(["init", "-q"], repo);
		await fs.writeFile(path.join(repo, "README.md"), "# test\n");
		await execTestGit(["add", "README.md"], repo);
		await execTestGit(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "initial"], repo);
		await execTestGit(["worktree", "add", "-q", worktree], repo);

		try {
			const repoRealPath = await fs.realpath(repo);
			const worktreeGitDir = (await execTestGit(["rev-parse", "--git-dir"], worktree)).stdout.trim();
			const worktreeGitPath = path.isAbsolute(worktreeGitDir) ? worktreeGitDir : path.resolve(worktree, worktreeGitDir);
			const protectedPolicy = {
				...policy,
				protectedResources: { denyRead: [], denyWrite: [GIT_METADATA_PROTECTED_RESOURCE_MATCH] },
			};
			const compiled = compileSandboxConfig(protectedPolicy, worktree, { enabled: true });
			const denyWrite = compiled.config.filesystem?.denyWrite ?? [];

			expect(denyWrite).toContain(path.join(repoRealPath, ".git", "hooks"));
			expect(denyWrite).toContain(path.join(repoRealPath, ".git", "config"));
			expect(denyWrite).toContain(path.join(worktreeGitPath, "hooks"));
			expect(denyWrite).toContain(path.join(worktreeGitPath, "config"));
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
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

	it("defaults sandboxed Git SSH to disabling SSH control sockets", async () => {
		const originalGitSshCommand = process.env.GIT_SSH_COMMAND;
		delete process.env.GIT_SSH_COMMAND;
		const chunks: string[] = [];
		try {
			await runSandboxedCommand(
				{
					initialize: async () => {},
					reset: async () => {},
					wrapWithSandbox: async (command) => command,
				},
				{
					command: "printf '%s' \"$GIT_SSH_COMMAND\"",
					cwd: process.cwd(),
					onData: (chunk) => chunks.push(chunk.toString("utf8")),
				},
			);
			expect(chunks.join("")).toBe("ssh -o ControlMaster=no");
		} finally {
			if (originalGitSshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
			else process.env.GIT_SSH_COMMAND = originalGitSshCommand;
		}
	});

	it("lets sandbox env override the default Git SSH command", async () => {
		const chunks: string[] = [];
		await runSandboxedCommand(
			{
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command) => command,
			},
			{
				command: "printf '%s' \"$GIT_SSH_COMMAND\"",
				cwd: process.cwd(),
				env: { GIT_SSH_COMMAND: "ssh -o ControlMaster=auto" },
				onData: (chunk) => chunks.push(chunk.toString("utf8")),
			},
		);
		expect(chunks.join("")).toBe("ssh -o ControlMaster=auto");
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
		expect(commandAt(parsed, 0).name).toBe("git");
		expect(commandAt(parsed, 0).tokens).toEqual(["git", "status"]);
		expect(commandAt(parsed, 0).alwaysPattern).toBe("git status *");
	});

	it("separates redirections from commands", async () => {
		const parsed = await parseBashCommand("bun test 2>&1");
		expect(parsed.commands).toHaveLength(1);
		expect(commandAt(parsed, 0).name).toBe("bun");
		expect(commandAt(parsed, 0).tokens).toEqual(["bun", "test"]);
		expect(commandAt(parsed, 0).command).toBe("bun test");
		// source includes the redirect context
		expect(commandAt(parsed, 0).source).toBe("bun test 2>&1");
	});

	it("splits compound commands with redirects", async () => {
		const parsed = await parseBashCommand("cd /some/path && bun test 2>&1");
		expect(parsed.isComplex).toBe(false);
		expect(parsed.commands).toHaveLength(2);
		expect(commandAt(parsed, 0).name).toBe("cd");
		expect(commandAt(parsed, 0).tokens).toEqual(["cd", "/some/path"]);
		expect(commandAt(parsed, 1).name).toBe("bun");
		expect(commandAt(parsed, 1).tokens).toEqual(["bun", "test"]);
		expect(commandAt(parsed, 1).alwaysPattern).toBe("bun test *");
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
		expect(commandAt(parsed, 0).name).toBe("echo");
		expect(commandAt(parsed, 1).name).toBe("grep");
	});

	it("handles multi-command chains", async () => {
		const parsed = await parseBashCommand('cd /path && git add . && git commit -m "msg"');
		expect(parsed.commands).toHaveLength(3);
		expect(commandAt(parsed, 0).alwaysPattern).toBe("cd *");
		expect(commandAt(parsed, 1).alwaysPattern).toBe("git add *");
		expect(commandAt(parsed, 2).alwaysPattern).toBe("git commit *");
	});

	it("skips variable assignments in token extraction", async () => {
		const parsed = await parseBashCommand("FOO=bar bun test");
		expect(parsed.commands).toHaveLength(1);
		expect(commandAt(parsed, 0).name).toBe("bun");
		expect(commandAt(parsed, 0).tokens).toEqual(["bun", "test"]);
	});

	it("handles output redirection", async () => {
		const parsed = await parseBashCommand("cat file.txt > output.txt");
		expect(parsed.commands).toHaveLength(1);
		expect(commandAt(parsed, 0).name).toBe("cat");
		expect(commandAt(parsed, 0).tokens).toEqual(["cat", "file.txt"]);
		// source includes redirect for display
		expect(commandAt(parsed, 0).source).toBe("cat file.txt > output.txt");
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
		expect(canAutoApproveParsedBash(parsed, allowRules)).toBe(true);
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

	it("does not auto-approve complex commands even when parsed segments are allowed", async () => {
		const parsed = await parseBashCommand("for f in *.txt; do echo $f; done");
		expect(parsed.isComplex).toBe(true);
		expect(isAllParsedCommandsAllowed(parsed, allowRules)).toBe(true);
		expect(canAutoApproveParsedBash(parsed, allowRules)).toBe(false);
	});
});
