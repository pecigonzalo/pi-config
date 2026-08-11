import { afterAll, beforeAll, describe, it, expect, mock, test } from "bun:test";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile as execFileCallback } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
	APPROVAL_CLOCK_SKEW_MS,
	approvalsCoverBash,
	approvalsCoverPaths,
	approvalsCoverTool,
	extractApprovalRecords,
	getApprovalsSettings,
} from "./approvals";
import { constrainCodemodePolicy, resolveCodemodePolicy } from "./codemode";
import { GIT_METADATA_PROTECTED_RESOURCE_MATCH } from "./protected-resources";
import {
	canonicalizePath,
	canonicalizePathToken,
	findGitRepoRoot,
	getFilesystemApprovalTargets,
	isPathOutsideCwd,
	matchRule,
	ruleMatch,
} from "./matching";
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
	matchSandboxBypassCommand,
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
import type { ApprovalRecord, Rule, SandboxManagerLike, SandboxRuntimeConfigLike } from "./shared";

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

	it("allows the user skill catalog through the built-in default policy", () => {
		const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
		const skillPath = path.join(home, ".agents", "skills", "standards-code", "SKILL.md");
		const policy = configModule.activePolicy({}, "default");

		for (const tool of ["read", "grep", "find", "ls"] as const) {
			const rule = matchRule(policy.rules, tool, { path: skillPath });
			expect(rule?.action).toBe("allow");
			expect(rule?.externalPathAction).toBe("allow");
		}

		expect(matchRule(policy.rules, "write", { path: skillPath })).toBeUndefined();
	});

	it("allows Pi package documentation through the built-in default policy", () => {
		const oldPackageDir = process.env.PI_PACKAGE_DIR;
		process.env.PI_PACKAGE_DIR = "/tmp/pi.package";
		try {
			const policy = configModule.activePolicy({}, "default");
			expect(matchRule(policy.rules, "read", { path: "/tmp/pi.package/README.md" })?.externalPathAction).toBe(
				"allow",
			);
			expect(
				matchRule(policy.rules, "read", { path: "/tmp/pi.package/docs/settings.md" })?.externalPathAction,
			).toBe("allow");
			expect(
				matchRule(policy.rules, "grep", { path: "/tmp/pi.package/examples/demo.ts" })?.externalPathAction,
			).toBe("allow");
			expect(matchRule(policy.rules, "ls", { path: "/tmp/pi.package" })?.externalPathAction).toBe("allow");
			expect(matchRule(policy.rules, "read", { path: "/tmp/pi.package/src/index.ts" })).toBeUndefined();
		} finally {
			if (oldPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = oldPackageDir;
		}
	});

	it("blocks direct writes to Git metadata through the built-in default policy", () => {
		const policy = configModule.activePolicy({}, "default");
		const gitObjectPath = path.join("/repo", ".git", "objects", "new-object");

		for (const tool of ["write", "edit"] as const) {
			const rule = matchRule(policy.rules, tool, { path: gitObjectPath });
			expect(rule?.action).toBe("block");
			expect(rule?.reason).toBe("Git internals");
		}
	});

	it("keeps Git hooks and config covered by protected resources rather than the generic rule", () => {
		const policy = configModule.activePolicy({}, "default");
		const hookPath = path.join("/repo", ".git", "hooks", "pre-commit");
		const configPath = path.join("/repo", ".git", "config");

		for (const tool of ["write", "edit"] as const) {
			const hookRule = matchRule(policy.rules, tool, { path: hookPath });
			expect(hookRule?.action).toBe("block");
			expect(hookRule?.reason).toBe("Blocked by protected resource policy");

			const configRule = matchRule(policy.rules, tool, { path: configPath });
			expect(configRule?.action).toBe("block");
			expect(configRule?.reason).toBe("Blocked by protected resource policy");
		}
	});

	it("keeps builtin invariants enforced ahead of user-configured rules", () => {
		const policy = configModule.activePolicy(
			{
				default: {
					rules: [
						{ tool: "write", match: "(^|[/])\\.git[/]", action: "allow", externalPathAction: "allow" },
						{ tool: "edit", match: "(^|[/])\\.git[/]", action: "allow", externalPathAction: "allow" },
					],
				},
			},
			"default",
		);
		const gitObjectPath = path.join("/repo", ".git", "objects", "new-object");

		for (const tool of ["write", "edit"] as const) {
			const rule = matchRule(policy.rules, tool, { path: gitObjectPath });
			expect(rule?.action).toBe("block");
			expect(rule?.reason).toBe("Git internals");
		}
	});

	it("lets user-configured rules override builtin defaults", () => {
		const policy = configModule.activePolicy(
			{
				default: {
					rules: [{ tool: "read", match: "\\.agents/skills", action: "block" }],
				},
			},
			"default",
		);
		const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
		const skillPath = path.join(home, ".agents", "skills", "standards-code", "SKILL.md");

		expect(matchRule(policy.rules, "read", { path: skillPath })?.action).toBe("block");
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

	it("can unprotect the MCP config without unprotecting other developer config files", () => {
		const resolved = configModule.resolveProtectedResources({
			protectedResources: {
				unprotectWrite: ["(^|[/])\\.mcp\\.json$"],
			},
		});

		expect(resolved.denyWrite).not.toContain("(^|[/])\\.mcp\\.json$");
		expect(resolved.denyWrite).toContain("(^|[/])\\.(gitconfig|gitmodules|ripgreprc)$");
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

	it("interpolates environment variables in rule match arrays", () => {
		const old = process.env.PI_PACKAGE_DIR;
		process.env.PI_PACKAGE_DIR = "/tmp/pi.package";
		try {
			const config = configModule.interpolateConfig({
				default: {
					rules: [
						{
							tool: "read",
							match: ["^${PI_PACKAGE_DIR}/docs(/|$)", "^${PI_PACKAGE_DIR}/examples(/|$)"],
							action: "allow",
						},
					],
				},
			});
			const rule = config.default?.rules?.[0];
			expect(rule?.match).toEqual(["^/tmp/pi\\.package/docs(/|$)", "^/tmp/pi\\.package/examples(/|$)"]);
			expect(ruleMatch(rule!, "read", "/tmp/pi.package/examples/demo.ts")).toBe(true);
			expect(ruleMatch(rule!, "read", "/tmp/piXpackage/examples/demo.ts")).toBe(false);
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
			expect(config.sandbox?.env?.GIT_SSH_COMMAND).toBe(
				"ssh -o ControlMaster=no -o ControlPath=/tmp/pi sockets/git.sock",
			);
		} finally {
			if (old === undefined) delete process.env.PI_TEST_SOCKET_DIR;
			else process.env.PI_TEST_SOCKET_DIR = old;
		}
	});

	it("interpolates environment variables in additional sandbox write paths as raw paths", () => {
		const old = process.env.PI_PACKAGE_DIR;
		process.env.PI_PACKAGE_DIR = "/tmp/pi.package";
		try {
			const config = configModule.interpolateConfig({
				sandbox: {
					addAllowWrite: ["${PI_PACKAGE_DIR}/cache"],
				},
			});
			expect(config.sandbox?.addAllowWrite).toEqual(["/tmp/pi.package/cache"]);
		} finally {
			if (old === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = old;
		}
	});

	it("interpolates environment variables in sandbox bypass commands as regex literals", () => {
		const old = process.env.PI_TEST_HOST;
		process.env.PI_TEST_HOST = "localhost:5173";
		try {
			const config = configModule.interpolateConfig({
				sandbox: {
					bypassCommands: ["^bunx\\s+@playwright/cli@latest\\s+open\\s+http://${PI_TEST_HOST}$"],
				},
			});
			expect(config.sandbox?.bypassCommands).toEqual([
				"^bunx\\s+@playwright/cli@latest\\s+open\\s+http://localhost:5173$",
			]);
			expect(
				matchSandboxBypassCommand(
					"bunx @playwright/cli@latest open http://localhost:5173",
					config.sandbox?.bypassCommands,
				),
			).toBe(config.sandbox?.bypassCommands?.[0]);
			expect(
				matchSandboxBypassCommand(
					"bunx @playwright/cli@latest open http://localhostX5173",
					config.sandbox?.bypassCommands,
				),
			).toBeUndefined();
		} finally {
			if (old === undefined) delete process.env.PI_TEST_HOST;
			else process.env.PI_TEST_HOST = old;
		}
	});

	it("infers the Pi package root from the running entrypoint path", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-pi-package-"));
		const root = path.join(tmp, "node_modules", "@earendil-works", "pi-coding-agent");
		await fs.mkdir(path.join(root, "dist"), { recursive: true });
		await fs.mkdir(path.join(root, "docs"), { recursive: true });
		await fs.mkdir(path.join(root, "examples"), { recursive: true });
		await fs.writeFile(path.join(root, "README.md"), "# Pi\n", "utf8");
		await fs.writeFile(
			path.join(root, "package.json"),
			JSON.stringify({
				name: "@earendil-works/pi-coding-agent",
				bin: { pi: "dist/cli.js" },
			}),
			"utf8",
		);
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
			expect(
				configModule.readJsonFile(filePath, { onWarning: (message) => warnings.push(message) }),
			).toBeUndefined();
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
			expect(
				warnings.some((message) => message.includes(configPath) && message.includes("expected object root")),
			).toBe(true);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});

describe("external path canonicalization", () => {
	it("canonicalizes nested missing paths through a symlink ancestor", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-test-"));
		const cwd = path.join(tmp, "cwd");
		const outside = path.join(tmp, "outside");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(outside, { recursive: true });

		try {
			const linkPath = path.join(cwd, "link");
			try {
				await fs.symlink(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (["EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) return;
				throw error;
			}

			const expected = path.join(await fs.realpath(outside), "missing", "nested", "file.txt");
			expect(canonicalizePathToken("link/missing/nested/file.txt", cwd)).toBe(expected);
			expect(isPathOutsideCwd("link/missing/nested/file.txt", cwd)).toBe(true);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("resolves dangling relative symlinks to missing external targets", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-test-"));
		const cwd = path.join(tmp, "cwd");
		const outside = path.join(tmp, "outside");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(outside, { recursive: true });

		try {
			const linkPath = path.join(cwd, "dangling");
			try {
				await fs.symlink(path.join("..", "outside", "missing-target"), linkPath, "dir");
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (["EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) return;
				throw error;
			}

			const expectedTarget = path.join(await fs.realpath(outside), "missing-target");
			expect(canonicalizePathToken("dangling", cwd)).toBe(expectedTarget);
			expect(isPathOutsideCwd("dangling", cwd)).toBe(true);
			expect(canonicalizePathToken("dangling/additional/child.txt", cwd)).toBe(
				path.join(expectedTarget, "additional", "child.txt"),
			);
			expect(isPathOutsideCwd("dangling/additional/child.txt", cwd)).toBe(true);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("resolves multi-hop symlinks that ultimately target a missing path", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-test-"));
		const cwd = path.join(tmp, "cwd");
		const links = path.join(tmp, "links");
		const outside = path.join(tmp, "outside");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(links, { recursive: true });
		await fs.mkdir(outside, { recursive: true });

		try {
			try {
				await fs.symlink(path.join("..", "outside", "missing-target"), path.join(links, "second"), "dir");
				await fs.symlink(path.join("..", "links", "second"), path.join(cwd, "first"), "dir");
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (["EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) return;
				throw error;
			}

			const expectedTarget = path.join(await fs.realpath(outside), "missing-target");
			expect(canonicalizePathToken("first", cwd)).toBe(expectedTarget);
			expect(canonicalizePathToken("first/unresolved/child.txt", cwd)).toBe(
				path.join(expectedTarget, "unresolved", "child.txt"),
			);
			expect(isPathOutsideCwd("first/unresolved/child.txt", cwd)).toBe(true);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("resolves dangling absolute symlinks to missing external targets", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-test-"));
		const cwd = path.join(tmp, "cwd");
		const missingTarget = path.join(tmp, "outside", "missing-target");
		await fs.mkdir(cwd, { recursive: true });

		try {
			const linkPath = path.join(cwd, "absolute-dangling");
			try {
				await fs.symlink(missingTarget, linkPath, "dir");
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (["EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) return;
				throw error;
			}

			expect(canonicalizePathToken("absolute-dangling", cwd)).toBe(
				path.join(await fs.realpath(tmp), "outside", "missing-target"),
			);
			expect(isPathOutsideCwd("absolute-dangling", cwd)).toBe(true);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("throws conservatively when canonicalizing a symlink cycle", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-test-"));
		const cwd = path.join(tmp, "cwd");
		await fs.mkdir(cwd, { recursive: true });

		try {
			try {
				await fs.symlink("cycle-b", path.join(cwd, "cycle-a"), "dir");
				await fs.symlink("cycle-a", path.join(cwd, "cycle-b"), "dir");
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (["EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) return;
				throw error;
			}

			expect(() => canonicalizePathToken("cycle-a/secret.txt", cwd)).toThrow(
				"Unable to safely resolve symlink chain",
			);
			expect(() => isPathOutsideCwd("cycle-a/secret.txt", cwd)).toThrow("Unable to safely resolve symlink chain");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("keeps multiple ordinary missing levels inside cwd", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-test-"));
		const cwd = path.join(tmp, "cwd");
		await fs.mkdir(cwd, { recursive: true });

		try {
			const expected = path.join(await fs.realpath(cwd), "one", "two", "file.txt");
			expect(canonicalizePathToken("one/two/file.txt", cwd)).toBe(expected);
			expect(isPathOutsideCwd("one/two/file.txt", cwd)).toBe(false);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("canonicalizes existing targets", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-test-"));
		const cwd = path.join(tmp, "cwd");
		const filePath = path.join(cwd, "existing.txt");
		await fs.mkdir(cwd, { recursive: true });
		await fs.writeFile(filePath, "ok", "utf8");

		try {
			expect(canonicalizePathToken("existing.txt", cwd)).toBe(await fs.realpath(filePath));
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("uses current-platform node:path separator and root semantics", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-test-"));
		const cwd = path.join(tmp, "cwd");
		await fs.mkdir(cwd, { recursive: true });

		try {
			const root = path.parse(path.resolve(cwd)).root;
			const canonicalCwd = await fs.realpath(cwd);
			expect(path.isAbsolute(root)).toBe(true);
			expect(root.endsWith(path.sep)).toBe(true);
			expect(canonicalizePath(root)).toBe(await fs.realpath(root));
			expect(canonicalizePathToken(`.${path.sep}missing${path.sep}..${path.sep}stable.txt`, cwd)).toBe(
				path.join(canonicalCwd, "stable.txt"),
			);
			expect(isPathOutsideCwd(`child${path.sep}file.txt`, cwd)).toBe(false);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
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

	it("preserves direct in-memory wildcard matching for every approval matcher", () => {
		const settings = getApprovalsSettings({ approvals: { scopeByProject: true, scopeByAgent: true } });
		const common = { tool: "*" as const, projectRoot: "/repo-a", agentName: "default", createdAt: Date.now() };

		expect(
			approvalsCoverPaths(
				[{ ...common, scopeType: "path-prefix", scopeValue: "/repo-a/external" }],
				"read",
				["/repo-a/external/file.txt"],
				"/repo-a",
				"default",
				settings,
			),
		).toBe(true);
		expect(
			approvalsCoverBash(
				[{ ...common, scopeType: "bash-prefix", scopeValue: "git" }],
				"git status",
				"/repo-a",
				"default",
				settings,
			),
		).toBe(true);
		expect(
			approvalsCoverTool(
				[{ ...common, scopeType: "tool", scopeValue: "*" }],
				"extension_tool",
				"/repo-a",
				"default",
				settings,
			),
		).toBe(true);
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

	it("rejects invalid tools, scopes, values, and timestamps", () => {
		const now = 1_000_000;
		const invalid = [
			{ tool: "unknown", scopeType: "tool", scopeValue: "different", createdAt: now },
			{ tool: "*", scopeType: "tool", scopeValue: "*", createdAt: now },
			{ tool: "custom_tool", scopeType: "path-prefix", scopeValue: "/tmp", createdAt: now },
			{ tool: "custom_tool", scopeType: "bash-prefix", scopeValue: "git", createdAt: now },
			{ tool: "read", scopeType: "bash-prefix", scopeValue: "git", createdAt: now },
			{ tool: "bash", scopeType: "path-prefix", scopeValue: "/tmp", createdAt: now },
			{ tool: "read", scopeType: "tool", scopeValue: "write", createdAt: now },
			{ tool: "read", scopeType: "path-prefix", scopeValue: "  ", createdAt: now },
			{ tool: "bash", scopeType: "tool", scopeValue: "bash", createdAt: Number.NaN },
			{ tool: "bash", scopeType: "tool", scopeValue: "bash", createdAt: Number.POSITIVE_INFINITY },
			{ tool: "bash", scopeType: "tool", scopeValue: "bash", createdAt: -1 },
			{ tool: "bash", scopeType: "tool", scopeValue: "bash", createdAt: now + APPROVAL_CLOCK_SKEW_MS + 1 },
		];
		const warnings: string[] = [];
		expect(
			extractApprovalRecords({ approvals: invalid }, (warning) => warnings.push(warning), "test", now),
		).toEqual([]);
		expect(warnings).toHaveLength(invalid.length);
	});

	it("rejects malformed concrete custom-tool names", () => {
		const now = 1_000_000;
		const names = [
			"extension tool",
			"extension\u00a0tool",
			"extension\ntool",
			"extension\u0000tool",
			"extension\u007ftool",
			"extension*tool",
		];
		const approvals = names.map((tool) => ({ tool, scopeType: "tool", scopeValue: tool, createdAt: now }));

		expect(extractApprovalRecords({ approvals }, undefined, "test", now)).toEqual([]);
	});

	it("rejects C1 controls in concrete custom-tool names", () => {
		const now = 1_000_000;
		const names = ["extension\u0080tool", "extension\u0085tool", "extension\u009ftool"];
		const approvals = names.map((tool) => ({ tool, scopeType: "tool", scopeValue: tool, createdAt: now }));

		expect(extractApprovalRecords({ approvals }, undefined, "test", now)).toEqual([]);
	});

	it("loads exact custom-tool approvals and covers only those tools", () => {
		const now = 1_000_000;
		const names = ["extension.tool", "extension-tool", "extension:tool/name"];
		const approvals: ApprovalRecord[] = names.map((tool) => ({
			tool,
			scopeType: "tool",
			scopeValue: tool,
			createdAt: now,
			projectRoot: "/repo",
			agentName: "default",
		}));
		const records = extractApprovalRecords({ approvals }, undefined, "test", now);
		const settings = getApprovalsSettings({ approvals: { scopeByProject: true, scopeByAgent: true } });

		expect(records).toEqual(approvals);
		for (const tool of names) expect(approvalsCoverTool(records, tool, "/repo", "default", settings)).toBe(true);
		expect(approvalsCoverTool(records, "other_tool", "/repo", "default", settings)).toBe(false);
	});

	it("accepts known valid combinations and timestamps within clock skew", () => {
		const now = 1_000_000;
		const approvals: ApprovalRecord[] = [
			{ tool: "bash", scopeType: "bash-exact", scopeValue: "git status", createdAt: now },
			{ tool: "read", scopeType: "path-prefix", scopeValue: "/repo", createdAt: now + APPROVAL_CLOCK_SKEW_MS },
			{
				tool: "mcp",
				scopeType: "tool",
				scopeValue: "mcp",
				createdAt: 0,
				projectRoot: "/repo",
				agentName: "default",
			},
		];
		expect(extractApprovalRecords({ approvals }, undefined, "test", now)).toEqual(approvals);
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

	it("lets command-prefix shorthand match package version suffixes", () => {
		const rule = { tool: "bash", match: "bunx @playwright/mcp *", action: "allow" as const };
		expect(ruleMatch(rule, "bash", "bunx @playwright/mcp@latest --port 3000")).toBe(true);
		expect(ruleMatch(rule, "bash", "DEBUG=pw:* bunx @playwright/mcp@latest --port 3000")).toBe(true);
		expect(ruleMatch(rule, "bash", "FOO='bar baz' DEBUG=1 bunx @playwright/mcp --port 3000")).toBe(true);
		expect(ruleMatch(rule, "bash", "bunx @playwright/mcp --port 3000")).toBe(true);
		expect(ruleMatch(rule, "bash", "bunx @playwright/mcp-server --port 3000")).toBe(false);
		expect(ruleMatch(rule, "bash", "echo bunx @playwright/mcp@latest")).toBe(false);
	});

	it("supports arrays of match patterns", () => {
		const rule = { tool: "bash", match: ["bunx @playwright/mcp *", "bunx playwright *"], action: "allow" as const };
		expect(ruleMatch(rule, "bash", "bunx @playwright/mcp@latest --port 3000")).toBe(true);
		expect(ruleMatch(rule, "bash", "bunx playwright test")).toBe(true);
		expect(ruleMatch(rule, "bash", "bunx @apify/mcpc@latest tools-list")).toBe(false);
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

	it("keeps the active permissions policy separate from analysis capabilities", () => {
		const resolved = resolveCodemodePolicy(
			basePolicy,
			"/repo",
			{ enabled: true, network: true, allowedDomains: ["api.example.com"] },
			"analysis",
		);
		expect(resolved.codeMode).toBe("analysis");
		expect(resolved.mode).toBe("workspace-write");
		expect(resolved.capabilities).toEqual(["message", "artifact", "mcp"]);
		expect(resolved.allowProjectAgents).toBe(false);
		expect(resolved.sandbox.enabled).toBe(true);
		expect(resolved.sandbox.config.network?.allowedDomains).toEqual(["api.example.com"]);
	});

	it("applies a selected permissions profile before resolving CodeMode capabilities", () => {
		const profilePolicy = configModule.activePolicy(
			{
				default: { mode: "workspace-write" },
				profiles: { "read-only": { inherit: true, mode: "plan" } },
			},
			"default",
			"read-only",
		);
		const resolved = resolveCodemodePolicy(profilePolicy, "/repo", { enabled: true }, "analysis");

		expect(resolved.mode).toBe("plan");
		expect(resolved.sandbox.config.filesystem?.allowWrite).not.toContain("/repo");
	});

	it("does not let a selected profile escalate the active session policy", () => {
		const current = configModule.activePolicy(
			{
				default: { mode: "workspace-write" },
				profiles: { "read-only": { inherit: true, mode: "plan" } },
			},
			"default",
			"read-only",
		);
		const requested = configModule.activePolicy({ default: { mode: "workspace-write" } }, "default", "default");
		const constrained = constrainCodemodePolicy(current, requested);

		expect(constrained.mode).toBe("plan");
		expect(constrained.externalPath).toBe("block");
	});

	it("keeps the active permissions policy separate from orchestrator capabilities", () => {
		const resolved = resolveCodemodePolicy(
			{ ...basePolicy, mode: "full-access" },
			"/repo",
			{ enabled: true, network: true },
			"orchestrator",
		);
		expect(resolved.codeMode).toBe("orchestrator");
		expect(resolved.mode).toBe("full-access");
		expect(resolved.capabilities).toEqual(["message", "artifact", "task", "todo", "mcp"]);
		expect(resolved.sandbox.enabled).toBe(true);
	});
});

describe("sandbox command bypass matching", () => {
	it("matches explicit localhost Playwright commands only", () => {
		const patterns = [
			"^bunx\\s+@playwright/cli(@[^\\s]+)?\\s+--browser\\s+firefox\\s+open\\s+https?://localhost(?::[0-9]+)?(?:/[^\\s]*)?\\s*$",
		];

		expect(
			matchSandboxBypassCommand(
				"bunx @playwright/cli@latest --browser firefox open http://localhost:5173",
				patterns,
			),
		).toBe(patterns[0]);
		expect(
			matchSandboxBypassCommand(
				"bunx @playwright/cli@latest --browser chromium open http://localhost:5173",
				patterns,
			),
		).toBeUndefined();
		expect(
			matchSandboxBypassCommand(
				"bunx @playwright/cli@latest --browser firefox open https://example.com",
				patterns,
			),
		).toBeUndefined();
	});

	it("supports simple bash-prefix bypass patterns", () => {
		expect(matchSandboxBypassCommand("open http://localhost:5173", ["open *"])).toBe("open *");
		expect(matchSandboxBypassCommand("printf open", ["open *"])).toBeUndefined();
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

	it("reuses the global Go download cache through a read-only file proxy", async () => {
		const originalGoModCache = process.env.GOMODCACHE;
		const originalGoProxy = process.env.GOPROXY;
		const sandboxTmpDir = path.join(os.tmpdir(), "pi-test-cache-env");
		const globalGoModCache = path.join(TEST_SCRATCH_DIR, "pi test global go mod cache");
		const chunks: string[] = [];
		let result: Awaited<ReturnType<typeof runSandboxedCommand>>;
		try {
			await fs.mkdir(path.join(globalGoModCache, "cache", "download"), { recursive: true });
			process.env.GOMODCACHE = globalGoModCache;
			process.env.GOPROXY = "https://proxy.golang.org,direct";
			result = await runSandboxedCommand(
				{
					initialize: async () => {},
					reset: async () => {},
					wrapWithSandbox: async (command) => command,
				},
				{
					command:
						'printf \'%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n\' "$TMPDIR" "$XDG_CACHE_HOME" "$BUN_INSTALL_CACHE_DIR" "$NPM_CONFIG_CACHE" "$GOCACHE" "$GOTMPDIR" "$GOPATH" "$GOMODCACHE" "$GOPROXY"',
					cwd: process.cwd(),
					env: { TMPDIR: sandboxTmpDir },
					onData: (chunk) => chunks.push(chunk.toString("utf8")),
				},
			);
		} finally {
			if (originalGoModCache === undefined) delete process.env.GOMODCACHE;
			else process.env.GOMODCACHE = originalGoModCache;
			if (originalGoProxy === undefined) delete process.env.GOPROXY;
			else process.env.GOPROXY = originalGoProxy;
			await fs.rm(globalGoModCache, { recursive: true, force: true });
		}

		expect(result.exitCode).toBe(0);
		expect(chunks.join("")).toBe(
			[
				sandboxTmpDir,
				path.join(sandboxTmpDir, "xdg-cache"),
				path.join(sandboxTmpDir, "bun-cache"),
				path.join(sandboxTmpDir, "npm-cache"),
				path.join(sandboxTmpDir, "go-build-cache"),
				sandboxTmpDir,
				path.join(sandboxTmpDir, "go"),
				path.join(sandboxTmpDir, "go", "pkg", "mod"),
				`${pathToFileURL(path.join(globalGoModCache, "cache", "download")).href},https://proxy.golang.org,direct`,
				"",
			].join("\n"),
		);
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
				command: 'printf \'%s\n%s\n%s\n%s\n%s\n\' "$GOCACHE" "$GOTMPDIR" "$GOPATH" "$GOMODCACHE" "$GOPROXY"',
				cwd: process.cwd(),
				env: {
					GOCACHE: "/tmp/custom-go-cache",
					GOTMPDIR: "/tmp/custom-go-tmp",
					GOPATH: "/tmp/custom-go-path",
					GOMODCACHE: "/tmp/custom-go-mod-cache",
					GOPROXY: "https://go.example.test,direct",
				},
				onData: (chunk) => chunks.push(chunk.toString("utf8")),
			},
		);

		expect(result.exitCode).toBe(0);
		expect(chunks.join("")).toBe(
			[
				"/tmp/custom-go-cache",
				"/tmp/custom-go-tmp",
				"/tmp/custom-go-path",
				"/tmp/custom-go-mod-cache",
				"https://go.example.test,direct",
				"",
			].join("\n"),
		);
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

		await ops.exec('printf \'%s\n%s\n\' "$TMPDIR" "${CLAUDE_TMPDIR-unset}"', process.cwd(), {
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

	it("reinitializes the sandbox runtime on every initialize call", async () => {
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

		expect(calls).toEqual(["reset", "initialize", "reset", "initialize", "reset", "initialize"]);
	});

	it("explicit reset remains supported between initialize calls", async () => {
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

	it("reports reset errors and aborts initialize when reset fails", async () => {
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

		await expect(
			adapter.initialize(sandboxConfig, "key-1", {
				onResetError: (err) => resetErrors.push(err),
			}),
		).rejects.toThrow("stale reset failed");

		expect(calls).toEqual(["reset"]);
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
			command: 'printf \'%s\\n%s\\n\' "$TMPDIR" "$PI_TEST_ADAPTER_ENV"',
			cwd: process.cwd(),
			onData: (chunk) => chunks.push(chunk.toString("utf8")),
		});

		expect(result.exitCode).toBe(0);
		expect(receivedConfig).toBe(sandboxConfig);
		expect(chunks.join("")).toBe(`${runtimeTmpDir}\nadapter-env\n`);
	});

	it("reinitializes manager network state for each runCommand execution", async () => {
		const runtimeTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-adapter-network-state-"));
		let activeConfig: SandboxRuntimeConfigLike | undefined = {
			filesystem: { denyRead: [], allowWrite: [runtimeTmpDir], denyWrite: [] },
			network: { allowedDomains: [], deniedDomains: [] },
		};
		const seenConfigDuringWrap: Array<SandboxRuntimeConfigLike | undefined> = [];
		const manager: SandboxManagerLike = {
			initialize: async (config) => {
				activeConfig = config;
			},
			reset: async () => {
				// reset intentionally leaves activeConfig unchanged to model stale upstream state
			},
			wrapWithSandbox: async (command) => {
				seenConfigDuringWrap.push(activeConfig);
				return command;
			},
		};
		const adapter = new SandboxRuntimeAdapter(manager);
		const unrestrictedConfig: SandboxRuntimeConfigLike = {
			filesystem: { denyRead: [], allowWrite: [runtimeTmpDir], denyWrite: [] },
			network: { allowLocalBinding: true },
		};
		const blockedConfig: SandboxRuntimeConfigLike = {
			filesystem: { denyRead: [], allowWrite: [runtimeTmpDir], denyWrite: [] },
			network: { allowedDomains: [], deniedDomains: [] },
		};

		await adapter.runCommand(
			{ config: unrestrictedConfig, tmpDir: runtimeTmpDir },
			{ command: "true", cwd: process.cwd() },
		);
		await adapter.runCommand(
			{ config: blockedConfig, tmpDir: runtimeTmpDir },
			{ command: "true", cwd: process.cwd() },
		);

		expect(seenConfigDuringWrap).toHaveLength(2);
		expect(seenConfigDuringWrap[0]).toBe(unrestrictedConfig);
		expect(seenConfigDuringWrap[1]).toBe(blockedConfig);
	});

	it("serializes executions across adapters sharing one manager", async () => {
		const runtimeTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-adapter-serial-"));
		const manager: SandboxManagerLike = {
			initialize: async () => {},
			reset: async () => {},
			wrapWithSandbox: async (command) => command,
		};
		const adapterA = new SandboxRuntimeAdapter(manager);
		const adapterB = new SandboxRuntimeAdapter(manager);
		const config: SandboxRuntimeConfigLike = {
			filesystem: { denyRead: [], allowWrite: [runtimeTmpDir], denyWrite: [] },
			network: { allowLocalBinding: true },
		};
		const spawnTimes: number[] = [];

		const first = adapterA.runCommand(
			{ config, tmpDir: runtimeTmpDir },
			{
				command: "sleep 0.25",
				cwd: process.cwd(),
				onSpawn: () => spawnTimes.push(Date.now()),
			},
		);
		const second = adapterB.runCommand(
			{ config, tmpDir: runtimeTmpDir },
			{
				command: "true",
				cwd: process.cwd(),
				onSpawn: () => spawnTimes.push(Date.now()),
			},
		);

		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult.exitCode).toBe(0);
		expect(secondResult.exitCode).toBe(0);
		expect(spawnTimes).toHaveLength(2);
		expect(spawnTimes[1]! - spawnTimes[0]!).toBeGreaterThanOrEqual(200);
	});

	it("detects when an idle gap should trigger a sandbox health probe", () => {
		expect(shouldProbeSandboxAfterIdle(1_000, 1_999, 1_000)).toBe(false);
		expect(shouldProbeSandboxAfterIdle(1_000, 2_000, 1_000)).toBe(true);
		expect(shouldProbeSandboxAfterIdle(1_000, 2_001, 1_000)).toBe(true);
	});

	it("keeps sandbox health timestamps unchanged when pre-command checks fail", async () => {
		const healthMonitor = new SandboxHealthMonitor(1_000, 1_000);

		await expect(
			runSandboxedCommandAfterHealthCheck({
				healthMonitor,
				ensureHealthy: async () => {
					throw new Error("health check failed");
				},
				execute: async () => "unreachable",
				now: () => 3_000,
			}),
		).rejects.toThrow("health check failed");

		expect(healthMonitor.getLastCommandAt()).toBe(1_000);
	});

	it("threads abort signals into sandbox health checks", async () => {
		const healthMonitor = new SandboxHealthMonitor(1_000, 1_000);
		const controller = new AbortController();
		let receivedSignal: AbortSignal | undefined;

		await expect(
			runSandboxedCommandAfterHealthCheck({
				healthMonitor,
				ensureHealthy: async (signal) => {
					receivedSignal = signal;
					controller.abort();
				},
				execute: async () => "unreachable",
				signal: controller.signal,
				now: () => 3_000,
			}),
		).rejects.toThrow("aborted");

		expect(receivedSignal).toBe(controller.signal);
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

		await expect(
			runSandboxedCommandAfterHealthCheck({
				healthMonitor,
				ensureHealthy: async () => {},
				execute: async () => {
					throw new Error("command failed");
				},
				now: () => 3_000,
			}),
		).rejects.toThrow("command failed");

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
		mode: "plan" | "workspace-write" | "full-access";
		rules?: Rule[];
		sandbox?: Record<string, unknown>;
		sandboxManager: {
			initialize: () => Promise<void>;
			reset: () => Promise<void>;
			wrapWithSandbox: (command: string) => Promise<string>;
		};
		now: () => number;
		notifications?: string[];
		approvalSelection?: string | ((choices: string[]) => string | undefined);
		blockReason?: string;
		approvalOptions?: string[][];
		approvalTitles?: string[];
		writeApprovalFile?: () => void;
	}) {
		await fs.mkdir(TEST_SCRATCH_DIR, { recursive: true });
		const tmp = await fs.mkdtemp(path.join(TEST_SCRATCH_DIR, "perm-extension-probe-"));
		const cwd = path.join(tmp, "repo");
		const sandboxTmpDir = path.join(tmp, "sandbox-tmp");
		await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".pi", "permissions.jsonc"),
			JSON.stringify({
				default: { mode: options.mode, rules: options.rules },
				sandbox: { enabled: true, tmpDir: sandboxTmpDir, ...(options.sandbox ?? {}) },
			}),
			"utf8",
		);
		mock.module("@anthropic-ai/sandbox-runtime", () => ({ SandboxManager: options.sandboxManager }));

		const originalDateNow = Date.now;
		Date.now = options.now;
		const tools = new Map<string, RegisteredTool>();
		const commands = new Map<string, RegisteredCommand>();
		const handlers = new Map<
			string,
			Array<(event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>
		>();
		const pi = {
			registerFlag: () => {},
			getFlag: () => false,
			registerTool: (tool: { name: string } & RegisteredTool) => {
				tools.set(tool.name, tool);
			},
			registerCommand: (name: string, command: RegisteredCommand) => {
				commands.set(name, command);
			},
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		} as unknown as ExtensionAPI;
		const ctx = {
			cwd,
			hasUI: true,
			ui: {
				notify: (message: string) => options.notifications?.push(message),
				select: async (title: string, choices: string[]) => {
					options.approvalTitles?.push(title);
					options.approvalOptions?.push(choices);
					return typeof options.approvalSelection === "function"
						? options.approvalSelection(choices)
						: options.approvalSelection;
				},
				input: async () => options.blockReason,
			},
		} as unknown as ExtensionContext;

		const { default: registerPermissions } = await import("./permissions");
		registerPermissions(pi, { writeApprovalFile: options.writeApprovalFile });
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

	async function requestReadApproval(
		approvalSelection: string | undefined,
		blockReason?: string,
	): Promise<{ result: { block: true; reason: string } | undefined; approvalOptions: string[][] }> {
		const approvalOptions: string[][] = [];
		const harness = await setupPermissionsHarness({
			mode: "full-access",
			rules: [{ tool: "read", action: "ask" }],
			now: () => 0,
			approvalSelection,
			blockReason,
			approvalOptions,
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command: string) => command,
			},
		});
		try {
			const toolCall = harness.handlers.get("tool_call")?.[0];
			if (!toolCall) throw new Error("tool_call handler was not registered");
			const result = (await toolCall({ toolName: "read", input: { path: "README.md" } }, harness.ctx)) as
				| { block: true; reason: string }
				| undefined;
			return { result, approvalOptions };
		} finally {
			await harness.restore();
		}
	}

	it("fails closed at the registered filesystem tool_call boundary for a cyclic path", async () => {
		const harness = await setupPermissionsHarness({
			mode: "full-access",
			rules: [{ tool: "read", action: "ask" }],
			now: () => 0,
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command: string) => command,
			},
		});
		try {
			try {
				await fs.symlink("cycle-b", path.join(harness.cwd, "cycle-a"), "dir");
				await fs.symlink("cycle-a", path.join(harness.cwd, "cycle-b"), "dir");
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (["EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) return;
				throw error;
			}

			const toolCall = harness.handlers.get("tool_call")?.[0];
			if (!toolCall) throw new Error("tool_call handler was not registered");
			await expect(
				toolCall({ toolName: "read", input: { path: "cycle-a/secret.txt" } }, harness.ctx),
			).rejects.toThrow("Unable to safely resolve symlink chain");
		} finally {
			await harness.restore();
		}
	});

	it("blocks when an approval selection is dismissed", async () => {
		const { result } = await requestReadApproval(undefined);

		expect(result).toEqual({ block: true, reason: "Blocked by user" });
	});

	it("blocks an unknown approval selection", async () => {
		const { result } = await requestReadApproval("Unexpected selection");

		expect(result).toEqual({ block: true, reason: "Blocked by user" });
	});

	it("allows an explicit Allow once selection", async () => {
		const { result, approvalOptions } = await requestReadApproval("Allow once");

		expect(result).toBeUndefined();
		expect(approvalOptions[0]?.[0]).toBe("Allow once");
	});

	it("shows bounded, labeled Bash command and approval-target previews with Allow once first", async () => {
		const approvalTitles: string[] = [];
		const approvalOptions: string[][] = [];
		const dangerousSuffix = "rm -rf /dangerous-suffix";
		const command = `echo safe && ${dangerousSuffix}`;
		const harness = await setupPermissionsHarness({
			mode: "full-access",
			rules: [
				{ tool: "bash", match: "^echo\\b", action: "allow" },
				{ tool: "bash", action: "ask" },
			],
			now: () => 0,
			approvalSelection: "Allow once",
			approvalOptions,
			approvalTitles,
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (value: string) => value,
			},
		});
		try {
			const toolCall = harness.handlers.get("tool_call")?.[0];
			if (!toolCall) throw new Error("tool_call handler was not registered");
			await toolCall({ toolName: "bash", input: { command } }, harness.ctx);
			expect(approvalTitles[0]).toContain(`Command:\n  ${command}`);
			expect(approvalTitles[0]).toContain(`Unapproved segment:\n  ${dangerousSuffix}`);
			expect(approvalTitles[0]).not.toContain("Note:\n  Unapproved shell segment:");
			expect(approvalTitles[0]).toContain("Reusable prefix:\n  rm *\n\nProfile: default");
			expect(approvalOptions[0]?.[0]).toBe("Allow once");
		} finally {
			await harness.restore();
		}
	});

	it("keeps a distinct approval target visible after a huge full command", async () => {
		const approvalTitles: string[] = [];
		const approvalOptions: string[][] = [];
		const target = "rm -rf /still-visible";
		const command = `echo ${"x".repeat(20_000)} && ${target}`;
		const harness = await setupPermissionsHarness({
			mode: "full-access",
			rules: [
				{ tool: "bash", match: "^echo\\b", action: "allow" },
				{ tool: "bash", action: "ask" },
			],
			now: () => 0,
			approvalSelection: "Allow once",
			approvalOptions,
			approvalTitles,
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (value: string) => value,
			},
		});
		try {
			const toolCall = harness.handlers.get("tool_call")?.[0];
			if (!toolCall) throw new Error("tool_call handler was not registered");
			await toolCall({ toolName: "bash", input: { command } }, harness.ctx);
			const title = approvalTitles[0] ?? "";
			expect(title).toContain("Command:\n");
			expect(title).toContain("[Preview shortened: omitted");
			expect(title).toContain(`&& ${target}\n\nUnapproved segment:\n  ${target}`);
			expect(title.length).toBeLessThan(2_000);
			expect(approvalOptions[0]?.[0]).toBe("Allow once");
			expect(approvalOptions[0]).toContain("Allow this exact segment for this session");
		} finally {
			await harness.restore();
		}
	});

	it("keeps a dangerous final line visible in full command and exact approval target sections", async () => {
		const approvalTitles: string[] = [];
		const finalLine = "rm -rf /dangerous-final-line";
		const command = `echo safe && printf '${"x".repeat(20_000)}'\n${finalLine}`;
		const harness = await setupPermissionsHarness({
			mode: "full-access",
			rules: [
				{ tool: "bash", match: "^echo\\b", action: "allow" },
				{ tool: "bash", action: "ask" },
			],
			now: () => 0,
			approvalSelection: "Allow once",
			approvalTitles,
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (value: string) => value,
			},
		});
		try {
			const toolCall = harness.handlers.get("tool_call")?.[0];
			if (!toolCall) throw new Error("tool_call handler was not registered");
			await toolCall({ toolName: "bash", input: { command } }, harness.ctx);
			const title = approvalTitles[0] ?? "";
			expect(title).toContain(`\n  ${finalLine}\n\nUnapproved segment:\n  printf `);
			expect(title).toContain("\n\nProfile: default");
			expect(title).toContain("[Preview shortened: omitted");
			expect(title.length).toBeLessThan(3_000);
		} finally {
			await harness.restore();
		}
	});

	it("bounds multiline reusable prefixes and includes their value in option labels", async () => {
		const approvalTitles: string[] = [];
		const approvalOptions: string[][] = [];
		const notifications: string[] = [];
		const candidate = `tool-${"p".repeat(600)}\nsecond-line`;
		const command = `${JSON.stringify(candidate)} argument`;
		const harness = await setupPermissionsHarness({
			mode: "full-access",
			rules: [{ tool: "bash", action: "ask" }],
			now: () => 0,
			approvalSelection: (choices) => choices.find((choice) => choice.startsWith("Allow `tool-")),
			approvalOptions,
			approvalTitles,
			notifications,
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (value: string) => value,
			},
		});
		try {
			const toolCall = harness.handlers.get("tool_call")?.[0];
			if (!toolCall) throw new Error("tool_call handler was not registered");
			await toolCall({ toolName: "bash", input: { command } }, harness.ctx);
			const title = approvalTitles[0] ?? "";
			const options = approvalOptions[0] ?? [];
			expect(title).toContain("Reusable prefix:\n  ");
			expect(title).toContain("[Preview shortened: omitted");
			expect(options[0]).toBe("Allow once");
			expect(
				options.some((option) => option.startsWith("Allow `tool-") && option.endsWith("` for this session")),
			).toBe(true);
			expect(options.some((option) => option.startsWith("Save `tool-") && option.endsWith("` permanently"))).toBe(
				true,
			);
			expect(Math.max(...options.map((option) => option.length))).toBeLessThan(80);
			const prefixNotification = notifications.find((message) => message.includes("bash-prefix:"));
			expect(prefixNotification).toContain("tool-");
			expect(prefixNotification).toContain("second-line");
		} finally {
			await harness.restore();
		}
	});

	it("shows explicit truncation notices for large Bash commands and generic details", async () => {
		const approvalTitles: string[] = [];
		const harness = await setupPermissionsHarness({
			mode: "full-access",
			rules: [
				{ tool: "bash", action: "ask" },
				{ tool: "mcp", action: "ask" },
			],
			now: () => 0,
			approvalSelection: "Block",
			approvalTitles,
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (value: string) => value,
			},
		});
		try {
			const toolCall = harness.handlers.get("tool_call")?.[0];
			if (!toolCall) throw new Error("tool_call handler was not registered");
			await toolCall({ toolName: "bash", input: { command: `echo ${"x".repeat(2_000)}` } }, harness.ctx);
			await toolCall({ toolName: "mcp", input: { command: "y".repeat(2_000) } }, harness.ctx);
			expect(approvalTitles).toHaveLength(2);
			expect(approvalTitles.every((title) => title.includes("[Preview shortened: omitted"))).toBe(true);
		} finally {
			await harness.restore();
		}
	});

	it.each([
		{
			name: "Bash exact permanent",
			toolName: "bash",
			input: { command: "permissions-save-failure-command --unique" },
			rules: [{ tool: "bash", action: "ask" }] as Rule[],
			pick: (choices: string[]) => choices.find((choice) => choice === "Save this exact command permanently"),
		},
		{
			name: "path permanent",
			toolName: "read",
			input: { path: "unique-save-failure.txt" },
			rules: [{ tool: "read", action: "ask" }] as Rule[],
			pick: (choices: string[]) => choices.find((choice) => choice.startsWith("Allow file permanently")),
		},
		{
			name: "tool permanent",
			toolName: "mcp",
			input: { server: "unique-save-failure", tool: "call" },
			rules: [{ tool: "mcp", action: "ask" }] as Rule[],
			pick: (choices: string[]) => choices.find((choice) => choice === "Allow tool permanently"),
		},
	])(
		"warns, suppresses success, rolls back, and prompts again for $name",
		async ({ toolName, input, rules, pick }) => {
			const notifications: string[] = [];
			const approvalOptions: string[][] = [];
			const harness = await setupPermissionsHarness({
				mode: "full-access",
				rules,
				now: () => 0,
				notifications,
				approvalOptions,
				approvalSelection: pick,
				writeApprovalFile: () => {
					throw new Error("injected save failure");
				},
				sandboxManager: {
					initialize: async () => {},
					reset: async () => {},
					wrapWithSandbox: async (command: string) => command,
				},
			});
			try {
				const toolCall = harness.handlers.get("tool_call")?.[0];
				if (!toolCall) throw new Error("tool_call handler was not registered");
				await toolCall({ toolName, input }, harness.ctx);
				await toolCall({ toolName, input }, harness.ctx);

				expect(approvalOptions).toHaveLength(2);
				expect(notifications.filter((message) => message.includes("Failed to save approvals"))).toHaveLength(2);
				expect(notifications.some((message) => message.includes("injected save failure"))).toBe(true);
				expect(
					notifications.some(
						(message) =>
							message.includes("saved permanently") ||
							message.includes("allowed permanently") ||
							message.includes("approved permanently"),
					),
				).toBe(false);
			} finally {
				await harness.restore();
			}
		},
	);

	it("does not claim saved approvals were cleared when reset persistence fails", async () => {
		const notifications: string[] = [];
		let writes = 0;
		const harness = await setupPermissionsHarness({
			mode: "full-access",
			rules: [{ tool: "read", action: "ask" }],
			now: () => 0,
			notifications,
			approvalSelection: (choices) => choices.find((choice) => choice === "Allow tool permanently"),
			writeApprovalFile: () => {
				writes++;
				if (writes > 1) throw new Error("reset save failure");
			},
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command: string) => command,
			},
		});
		try {
			const toolCall = harness.handlers.get("tool_call")?.[0];
			if (!toolCall) throw new Error("tool_call handler was not registered");
			await toolCall({ toolName: "read", input: { path: "reset-save-failure.txt" } }, harness.ctx);
			await harness.commands.get("permissions")?.handler("reset saved", harness.ctx);

			expect(notifications.some((message) => message.includes("reset save failure"))).toBe(true);
			expect(notifications.some((message) => message.includes("saved approvals cleared"))).toBe(false);
		} finally {
			await harness.restore();
		}
	});

	it("blocks an explicit Block selection", async () => {
		const { result } = await requestReadApproval("Block");

		expect(result).toEqual({ block: true, reason: "Blocked by user" });
	});

	it("blocks and steers with the supplied reason", async () => {
		const { result } = await requestReadApproval("Block and steer agent", "Use a read-only alternative");

		expect(result).toEqual({ block: true, reason: "Use a read-only alternative" });
	});

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

		expect(notifications).toContain(
			"Bash sandbox disabled for this session; bash exec mode: local (block-all-bash)",
		);
	});

	it("keeps the sandbox disabled across the next bash execution", async () => {
		let now = 0;
		let initializeCount = 0;
		const notifications: string[] = [];
		const wrappedCommands: string[] = [];
		const harness = await setupPermissionsHarness({
			mode: "full-access",
			now: () => now,
			notifications,
			sandboxManager: {
				initialize: async () => {
					initializeCount++;
				},
				reset: async () => {},
				wrapWithSandbox: async (command: string) => {
					wrappedCommands.push(command);
					return command;
				},
			},
		});
		try {
			await harness.commands.get("permissions")?.handler("sandbox disable", harness.ctx);
			const bashTool = harness.tools.get("bash");
			if (!bashTool) throw new Error("bash tool was not registered");

			await bashTool.execute("disabled-sandbox-test", { command: "true" }, undefined, undefined, harness.ctx);
			await harness.commands.get("permissions")?.handler("sandbox status", harness.ctx);
		} finally {
			await harness.restore();
		}

		expect(initializeCount).toBe(1);
		expect(wrappedCommands).toEqual([]);
		expect(notifications).toContain(
			"Bash sandbox: disabled by /permissions sandbox disable; bash exec mode: local",
		);
	});

	it("runs bash rules with sandbox=false without wrapping them", async () => {
		let now = 0;
		const notifications: string[] = [];
		const wrappedCommands: string[] = [];
		const harness = await setupPermissionsHarness({
			mode: "full-access",
			rules: [{ tool: "bash", match: "^printf\\s+bypass$", action: "allow", sandbox: false }],
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
			const bashTool = harness.tools.get("bash");
			if (!bashTool) throw new Error("bash tool was not registered");

			await bashTool.execute("bypass-test", { command: "printf bypass" }, undefined, undefined, harness.ctx);
		} finally {
			await harness.restore();
		}

		expect(wrappedCommands).toEqual([]);
		expect(notifications).toContain(
			"Bash sandbox bypassed for command matching: sandbox=false rule /^printf\\s+bypass$/",
		);
	});

	it("keeps non-matching commands sandboxed when sandbox=false rules are configured", async () => {
		let now = 0;
		const wrappedCommands: string[] = [];
		const harness = await setupPermissionsHarness({
			mode: "full-access",
			rules: [{ tool: "bash", match: "^printf\\s+bypass$", action: "allow", sandbox: false }],
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
			const bashTool = harness.tools.get("bash");
			if (!bashTool) throw new Error("bash tool was not registered");

			await bashTool.execute(
				"sandboxed-test",
				{ command: "printf sandboxed" },
				undefined,
				undefined,
				harness.ctx,
			);
		} finally {
			await harness.restore();
		}

		expect(wrappedCommands).toContain("printf sandboxed");
	});

	it("runs compound bash commands outside the sandbox when a parsed segment has sandbox=false", async () => {
		let now = 0;
		const notifications: string[] = [];
		const wrappedCommands: string[] = [];
		const harness = await setupPermissionsHarness({
			mode: "full-access",
			rules: [{ tool: "bash", match: "printf bypass *", action: "allow", sandbox: false }],
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
			const bashTool = harness.tools.get("bash");
			if (!bashTool) throw new Error("bash tool was not registered");

			await bashTool.execute(
				"compound-bypass-test",
				{ command: "set -euo pipefail\nprintf setup\nprintf bypass >/tmp/mcpc.json\nprintf done" },
				undefined,
				undefined,
				harness.ctx,
			);
		} finally {
			await harness.restore();
		}

		expect(wrappedCommands).toEqual([]);
		expect(notifications).toContain(
			"Bash sandbox bypassed for command matching: sandbox=false rule /printf bypass */ (matched shell segment)",
		);
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

		expect(
			wrappedCommands.some((command) =>
				command.includes(`${harness.sandboxTmpDir}${path.sep}.pi-sandbox-write-probe-`),
			),
		).toBe(true);
		expect(
			wrappedCommands.some((command) => command.includes(`${harness.cwd}${path.sep}.pi-sandbox-write-probe-`)),
		).toBe(false);
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
		expect(
			wrappedCommands.some((command) =>
				command.includes(`${harness.sandboxTmpDir}${path.sep}.pi-sandbox-write-probe-`),
			),
		).toBe(true);
		expect(
			wrappedCommands.some((command) => command.includes(`${harness.cwd}${path.sep}.pi-sandbox-write-probe-`)),
		).toBe(false);
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
		expect(
			wrappedCommands.some((command) => command.includes(`${harness.cwd}${path.sep}.pi-sandbox-write-probe-`)),
		).toBe(true);
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
		expect(
			wrappedCommands.some((command) => command.includes(`${harness.cwd}${path.sep}.pi-sandbox-write-probe-`)),
		).toBe(false);
	});

	it("blocks local fallback when sandbox state disappears before execution", async () => {
		let commandCount = 0;
		const harness = await setupPermissionsHarness({
			mode: "workspace-write",
			now: () => 0,
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command: string) => {
					commandCount++;
					return command;
				},
			},
		});
		try {
			const bashTool = harness.tools.get("bash");
			if (!bashTool) throw new Error("bash tool was not registered");

			const execution = bashTool.execute(
				"state-loss-test",
				{ command: "true" },
				undefined,
				undefined,
				harness.ctx,
			);
			for (const handler of harness.handlers.get("session_shutdown") ?? []) {
				await handler({}, harness.ctx);
			}

			await expect(execution).rejects.toThrow("blocked local fallback");
		} finally {
			await harness.restore();
		}

		expect(commandCount).toBe(0);
	});

	it("blocks execution when sandbox state is replaced before execution", async () => {
		let commandCount = 0;
		const harness = await setupPermissionsHarness({
			mode: "workspace-write",
			now: () => 0,
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command: string) => {
					commandCount++;
					return command;
				},
			},
		});
		try {
			const bashTool = harness.tools.get("bash");
			if (!bashTool) throw new Error("bash tool was not registered");

			const execution = bashTool.execute(
				"state-replacement-test",
				{ command: "true" },
				undefined,
				undefined,
				harness.ctx,
			);
			for (const handler of harness.handlers.get("session_shutdown") ?? []) {
				await handler({}, harness.ctx);
			}
			for (const handler of harness.handlers.get("session_start") ?? []) {
				await handler({}, harness.ctx);
			}

			await expect(execution).rejects.toThrow("blocked local fallback");
		} finally {
			await harness.restore();
		}

		expect(commandCount).toBe(0);
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

			await expect(
				bashTool.execute("probe-test-1", { command: "true" }, undefined, undefined, harness.ctx),
			).rejects.toThrow("automatic repair failed");
			await expect(
				bashTool.execute("probe-test-2", { command: "true" }, undefined, undefined, harness.ctx),
			).rejects.toThrow("automatic repair failed");
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

	it("blocks user bash when policy requires confirmation without UI", async () => {
		let now = 0;
		const harness = await setupPermissionsHarness({
			mode: "workspace-write",
			now: () => now,
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command: string) => command,
			},
		});
		try {
			const userBash = harness.handlers.get("user_bash")?.[0];
			if (!userBash) throw new Error("user_bash handler was not registered");
			const ctx = { ...harness.ctx, hasUI: false } as ExtensionContext;

			const result = (await userBash(
				{ command: "npm test", excludeFromContext: true, cwd: harness.cwd },
				ctx,
			)) as { result?: { output?: string; exitCode?: number } } | undefined;

			expect(result?.result?.exitCode).toBe(1);
			expect(result?.result?.output).toContain("Requires confirmation for bash but no UI is available");
		} finally {
			await harness.restore();
		}
	});

	it("runs user bash rules with sandbox=false without wrapping them", async () => {
		let now = 0;
		const notifications: string[] = [];
		const wrappedCommands: string[] = [];
		const harness = await setupPermissionsHarness({
			mode: "full-access",
			rules: [{ tool: "bash", match: "^printf\\s+user-bypass$", action: "allow", sandbox: false }],
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
			const userBash = harness.handlers.get("user_bash")?.[0];
			if (!userBash) throw new Error("user_bash handler was not registered");
			const result = (await userBash(
				{ command: "printf user-bypass", excludeFromContext: false, cwd: harness.cwd },
				harness.ctx,
			)) as { operations?: { exec: (...args: any[]) => Promise<unknown> } } | undefined;

			expect(result?.operations).toBeDefined();
			await result!.operations!.exec("printf user-bypass", harness.cwd, { onData: () => {} });
		} finally {
			await harness.restore();
		}

		expect(wrappedCommands).toEqual([]);
		expect(notifications).toContain(
			"Bash sandbox bypassed for command matching: sandbox=false rule /^printf\\s+user-bypass$/",
		);
	});

	it("keeps intentionally disabled user bash execution local", async () => {
		const harness = await setupPermissionsHarness({
			mode: "full-access",
			now: () => 0,
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command: string) => command,
			},
		});
		try {
			await harness.commands.get("permissions")?.handler("sandbox disable", harness.ctx);
			const userBash = harness.handlers.get("user_bash")?.[0];
			if (!userBash) throw new Error("user_bash handler was not registered");

			const result = await userBash(
				{ command: "printf local-user-bash", excludeFromContext: false, cwd: harness.cwd },
				harness.ctx,
			);

			expect(result).toBeUndefined();
		} finally {
			await harness.restore();
		}
	});

	it("blocks local user bash fallback when sandbox state disappears before execution", async () => {
		let commandCount = 0;
		const harness = await setupPermissionsHarness({
			mode: "full-access",
			now: () => 0,
			sandboxManager: {
				initialize: async () => {},
				reset: async () => {},
				wrapWithSandbox: async (command: string) => {
					commandCount++;
					return command;
				},
			},
		});
		try {
			const userBash = harness.handlers.get("user_bash")?.[0];
			if (!userBash) throw new Error("user_bash handler was not registered");
			const result = (await userBash(
				{ command: "true", excludeFromContext: false, cwd: harness.cwd },
				harness.ctx,
			)) as { operations?: { exec: (...args: any[]) => Promise<unknown> } } | undefined;
			if (!result?.operations) throw new Error("sandboxed user bash operations were not returned");

			for (const handler of harness.handlers.get("session_shutdown") ?? []) {
				await handler({}, harness.ctx);
			}

			const execution = result.operations.exec("true", harness.cwd, { onData: () => {} });
			await expect(execution).rejects.toThrow("blocked local fallback");
		} finally {
			await harness.restore();
		}

		expect(commandCount).toBe(0);
	});

	it("runs user bash through active sandbox operations", async () => {
		let now = 0;
		const wrappedCommands: string[] = [];
		const harness = await setupPermissionsHarness({
			mode: "full-access",
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
			const userBash = harness.handlers.get("user_bash")?.[0];
			if (!userBash) throw new Error("user_bash handler was not registered");
			const result = (await userBash(
				{ command: "printf user-bash", excludeFromContext: false, cwd: harness.cwd },
				harness.ctx,
			)) as { operations?: { exec: (...args: any[]) => Promise<unknown> } } | undefined;

			expect(result?.operations).toBeDefined();
			await result!.operations!.exec("printf user-bash", harness.cwd, { onData: () => {} });
		} finally {
			await harness.restore();
		}

		expect(wrappedCommands).toContain("printf user-bash");
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
		expect(
			compiled.config.network?.allowMachLookup?.filter((value) => value === "com.example.service"),
		).toHaveLength(1);
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
		const compiled = compileSandboxConfig({ ...policy, mode: "plan" }, "/repo", {
			enabled: true,
			tmpDir: "/tmp/custom-pi",
		});
		expect(isSandboxWriteAllowedForPath(compiled.config, "/tmp/custom-pi")).toBe(true);
		expect(isSandboxWriteAllowedForPath(compiled.config, "/repo")).toBe(false);
	});

	it("adds configured addAllowWrite paths to the default write allowances", () => {
		const compiled = compileSandboxConfig(policy, "/repo", {
			enabled: true,
			tmpDir: "/tmp/custom-pi",
			addAllowWrite: ["/tmp/custom-output"],
		});

		expect(isSandboxWriteAllowedForPath(compiled.config, "/tmp/custom-pi")).toBe(true);
		expect(isSandboxWriteAllowedForPath(compiled.config, "/tmp/custom-output")).toBe(true);
		expect(isSandboxWriteAllowedForPath(compiled.config, "/repo")).toBe(true);
	});

	it("keeps protected-resource globs from masking workspace write expectations", () => {
		expect(
			isSandboxWriteAllowedForPath(
				{
					filesystem: {
						allowWrite: ["/repo"],
						denyRead: [],
						denyWrite: ["/repo/**/.env", "/repo/**/.git/hooks/**"],
					},
				},
				"/repo",
			),
		).toBe(true);
	});

	it("recognizes broad deny globs that block direct workspace writes", () => {
		expect(
			isSandboxWriteAllowedForPath(
				{
					filesystem: {
						allowWrite: ["/repo"],
						denyRead: [],
						denyWrite: ["/repo/**"],
					},
				},
				"/repo",
			),
		).toBe(false);
	});

	it("expects workspace writes for the default protected-resource sandbox policy", () => {
		const compiled = compileSandboxConfig(policy, "/repo", { enabled: true, tmpDir: "/tmp/custom-pi" });
		expect(isSandboxWriteAllowedForPath(compiled.config, "/repo")).toBe(true);
	});

	it("allows Docker Buildx activity writes by default", () => {
		const compiled = compileSandboxConfig(policy, "/repo", { enabled: true, tmpDir: "/tmp/custom-pi" });
		expect(compiled.config.filesystem?.allowWrite).toContain(
			path.join(os.homedir(), ".docker", "buildx", "activity"),
		);
	});

	it("uses sandbox DOCKER_CONFIG for Docker Buildx write allowances", () => {
		const compiled = compileSandboxConfig(policy, "/repo", {
			enabled: true,
			tmpDir: "/tmp/custom-pi",
			env: { DOCKER_CONFIG: "/tmp/custom-docker-config" },
		});
		expect(compiled.config.filesystem?.allowWrite).toContain("/tmp/custom-docker-config/buildx/activity");
	});

	it("allows common Docker Unix sockets by default", () => {
		const compiled = compileSandboxConfig(policy, "/repo", { enabled: true, tmpDir: "/tmp/custom-pi" });
		expect(compiled.config.network?.allowUnixSockets).toContain(
			path.join(os.homedir(), ".docker", "run", "docker.sock"),
		);
		expect(compiled.config.network?.allowUnixSockets).toContain("/var/run/docker.sock");
		expect(compiled.config.network?.allowUnixSockets).toContain("/private/var/run/docker.sock");
	});

	it("allows Docker Unix socket from DOCKER_HOST", () => {
		const originalDockerHost = process.env.DOCKER_HOST;
		process.env.DOCKER_HOST = "unix:///tmp/custom-docker.sock";
		try {
			const compiled = compileSandboxConfig(policy, "/repo", { enabled: true, tmpDir: "/tmp/custom-pi" });
			expect(compiled.config.network?.allowUnixSockets).toContain("/tmp/custom-docker.sock");
		} finally {
			if (originalDockerHost === undefined) delete process.env.DOCKER_HOST;
			else process.env.DOCKER_HOST = originalDockerHost;
		}
	});

	it("keeps the user Go module cache read-only by default", () => {
		const originalGoModCache = process.env.GOMODCACHE;
		process.env.GOMODCACHE = "/tmp/custom-go-mod-cache";
		try {
			const compiled = compileSandboxConfig(policy, "/repo", { enabled: true, tmpDir: "/tmp/custom-pi" });
			expect(
				isSandboxWriteAllowedForPath(compiled.config, "/tmp/custom-go-mod-cache/cache/download/module.zip"),
			).toBe(false);
		} finally {
			if (originalGoModCache === undefined) delete process.env.GOMODCACHE;
			else process.env.GOMODCACHE = originalGoModCache;
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

	it("uses a sandbox-local Go build cache", async () => {
		try {
			await execFile("go", ["version"]);
		} catch {
			return;
		}

		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "perm-go-cache-"));
		const repo = path.join(tmp, "repo");

		try {
			await fs.mkdir(repo, { recursive: true });
			await fs.writeFile(path.join(repo, "go.mod"), "module example.com/pi-go-cache-test\n\ngo 1.18\n");
			await fs.writeFile(
				path.join(repo, "main_test.go"),
				`package gocachetest

import "testing"

const cacheBust = "${path.basename(tmp)}"

func TestGoCache(t *testing.T) {}
`,
			);
			const compiled = compileSandboxConfig(policy, repo, { enabled: true, network: true, tmpDir: tmp });
			expect(compiled.config.filesystem?.allowWrite).toContain(tmp);

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
			await fs.rm(tmp, { recursive: true, force: true });
		}
	}, 15_000);

	it("allows certificate fixtures in the sandbox Go cache without unprotecting workspace keys", () => {
		const protectedPolicy = {
			...policy,
			protectedResources: {
				denyRead: ["\\.(pem|key|p12|pfx|crt|ca-bundle)$"],
				denyWrite: ["\\.(pem|key|p12|pfx|crt|ca-bundle)$"],
			},
		};
		const compiled = compileSandboxConfig(protectedPolicy, "/repo", {
			enabled: true,
			tmpDir: "/tmp/custom-pi",
		});

		const denyWrite = compiled.config.filesystem?.denyWrite ?? [];
		expect(denyWrite).toContain("/repo/**/*.crt");
		expect(denyWrite).not.toContain("/tmp/custom-pi/**/*.crt");
		expect(isSandboxWriteAllowedForPath(compiled.config, "/tmp/custom-pi/go/pkg/mod/example/testdata")).toBe(true);
	});

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
			addAllowWrite: ["dist"],
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
		await execTestGit(
			["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "initial"],
			repo,
		);
		await execTestGit(["worktree", "add", "-q", worktree], repo);

		try {
			const repoRealPath = await fs.realpath(repo);
			const worktreeGitDir = (await execTestGit(["rev-parse", "--git-dir"], worktree)).stdout.trim();
			const worktreeGitPath = path.isAbsolute(worktreeGitDir)
				? worktreeGitDir
				: path.resolve(worktree, worktreeGitDir);
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

		const subshell = await parseBashCommand("(whoami)");
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

	it("handles command substitutions as nested commands", async () => {
		const parsed = await parseBashCommand('echo "$(cat file.txt)"');
		expect(parsed.isComplex).toBe(false);
		expect(parsed.commands.map((cmd) => cmd.name)).toEqual(["echo", "cat"]);
		expect(commandAt(parsed, 1).source).toBe("cat file.txt");
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

	it("does not let command substitutions hide unapproved commands", async () => {
		const parsed = await parseBashCommand('echo "$(rm -rf foo)"');
		expect(parsed.isComplex).toBe(false);
		expect(parsed.commands.map((cmd) => cmd.name)).toEqual(["echo", "rm"]);
		const unapproved = getFirstUnapprovedParsedCommand(parsed, allowRules);
		expect(unapproved).toBeDefined();
		expect(unapproved!.name).toBe("rm");
	});
});

import { PERMISSIONS_COMPLETIONS } from "./permissions";

test("permissions completions list all accepted subcommands", () => {
	expect(PERMISSIONS_COMPLETIONS.map((s) => s.value)).toEqual(["help", "approvals", "reset", "mode", "sandbox"]);
});

test("permissions completions filter by prefix", () => {
	const results = PERMISSIONS_COMPLETIONS.filter((s) => s.value.startsWith("ap"));
	expect(results.map((s) => s.value)).toEqual(["approvals"]);
});

test("permissions completions return nothing for unrecognised prefix", () => {
	expect(PERMISSIONS_COMPLETIONS.filter((s) => s.value.startsWith("xyz"))).toEqual([]);
});
