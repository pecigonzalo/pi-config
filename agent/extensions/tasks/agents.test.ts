import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverResources, hasProjectTaskResources, resolveSkillPaths } from "./agents.js";

const tempDirs: string[] = [];

async function makeProject(): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-task-agents-test-"));
	tempDirs.push(cwd);
	return cwd;
}

async function writeProjectResources(cwd: string): Promise<void> {
	await fs.mkdir(path.join(cwd, ".pi", "agents"), { recursive: true });
	await fs.mkdir(path.join(cwd, ".pi", "profiles"), { recursive: true });
	await fs.writeFile(
		path.join(cwd, ".pi", "agents", "project-worker.md"),
		"---\nname: project-worker\ndescription: Project worker\navailability: task\n---\nProject behavior\n",
	);
	await fs.writeFile(
		path.join(cwd, ".pi", "profiles", "project-profile.md"),
		"---\nname: project-profile\ndescription: Project profile\n---\nProject profile behavior\n",
	);
	await fs.writeFile(
		path.join(cwd, ".pi", "tasks.json"),
		JSON.stringify({ context: { project: true }, efforts: { projectEffort: { model: "project-model" } } }),
	);
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("task resource project trust", () => {
	it("detects task-specific project resources that require an explicit trust decision", async () => {
		const cwd = await makeProject();
		expect(hasProjectTaskResources(cwd)).toBe(false);
		await writeProjectResources(cwd);
		expect(hasProjectTaskResources(cwd)).toBe(true);
	});

	it("ignores project resources reached through a symlinked config directory", async () => {
		const cwd = await makeProject();
		const outsideConfig = path.join(cwd, "outside-config");
		await fs.mkdir(path.join(outsideConfig, "agents"), { recursive: true });
		await fs.mkdir(path.join(outsideConfig, "skills", "escaped"), { recursive: true });
		const configuredOutside = path.join(cwd, "configured-outside.md");
		await fs.writeFile(
			path.join(outsideConfig, "agents", "escaped.md"),
			"---\nname: escaped\ndescription: Escaped\navailability: task\n---\noutside\n",
		);
		await fs.writeFile(path.join(outsideConfig, "skills", "escaped", "SKILL.md"), "outside");
		await fs.writeFile(configuredOutside, "outside configured skill");
		await fs.writeFile(path.join(outsideConfig, "settings.json"), JSON.stringify({ skills: [configuredOutside] }));
		await fs.symlink(outsideConfig, path.join(cwd, ".pi"));

		expect(hasProjectTaskResources(cwd)).toBe(false);
		expect(discoverResources(cwd, "both", true).agents.some((agent) => agent.name === "escaped")).toBe(false);
		expect(resolveSkillPaths(["escaped", "configured-outside"], cwd, true)).toEqual({
			paths: [],
			missing: ["escaped", "configured-outside"],
		});
	});

	it("ignores symlinked project agent and profile files", async () => {
		const cwd = await makeProject();
		const outsideAgent = path.join(cwd, "outside-agent.md");
		const outsideProfile = path.join(cwd, "outside-profile.md");
		await fs.mkdir(path.join(cwd, ".pi", "agents"), { recursive: true });
		await fs.mkdir(path.join(cwd, ".pi", "profiles"), { recursive: true });
		await fs.writeFile(outsideAgent, "---\nname: escaped-agent\ndescription: Escaped\navailability: task\n---\noutside\n");
		await fs.writeFile(outsideProfile, "---\nname: escaped-profile\ndescription: Escaped\n---\noutside\n");
		await fs.symlink(outsideAgent, path.join(cwd, ".pi", "agents", "escaped.md"));
		await fs.symlink(outsideProfile, path.join(cwd, ".pi", "profiles", "escaped.md"));

		const resources = discoverResources(cwd, "both", true);

		expect(resources.agents.some((agent) => agent.name === "escaped-agent")).toBe(false);
		expect(resources.profiles.some((profile) => profile.name === "escaped-profile")).toBe(false);
	});

	it("excludes all project resources and defaults when the project is untrusted", async () => {
		const cwd = await makeProject();
		await writeProjectResources(cwd);

		const resources = discoverResources(cwd, "both", false);

		expect(resources.agents.some((agent) => agent.name === "project-worker")).toBe(false);
		expect(resources.profiles.some((profile) => profile.name === "project-profile")).toBe(false);
		expect(resources.efforts.some((effort) => effort.name === "projectEffort")).toBe(false);
		expect(resources.projectTasksConfig).toBeNull();
	});

	it("includes project resources and defaults after the project is trusted", async () => {
		const cwd = await makeProject();
		await writeProjectResources(cwd);

		const resources = discoverResources(cwd, "both", true);

		expect(resources.agents.some((agent) => agent.name === "project-worker")).toBe(true);
		expect(resources.profiles.some((profile) => profile.name === "project-profile")).toBe(true);
		expect(resources.efforts.some((effort) => effort.name === "projectEffort")).toBe(true);
		expect(resources.projectTasksConfig?.context?.project).toBe(true);
	});

	it("does not load project defaults in user scope even when trusted", async () => {
		const cwd = await makeProject();
		await writeProjectResources(cwd);

		const resources = discoverResources(cwd, "user", true);

		expect(resources.projectTasksConfig).toBeNull();
		expect(resources.efforts.some((effort) => effort.name === "projectEffort")).toBe(false);
	});
});

describe("task skill path security", () => {
	it("rejects traversal skill names", async () => {
		const cwd = await makeProject();
		const outside = path.join(cwd, "outside");
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, "SKILL.md"), "outside");

		const result = resolveSkillPaths(["../outside", "..", "/absolute"], cwd, true);

		expect(result.paths).toEqual([]);
		expect(result.missing).toEqual(["../outside", "..", "/absolute"]);
	});

	it("rejects a project skill symlink that escapes its root", async () => {
		const cwd = await makeProject();
		const skillsRoot = path.join(cwd, ".pi", "skills");
		const outside = path.join(cwd, "outside-skill");
		await fs.mkdir(skillsRoot, { recursive: true });
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, "SKILL.md"), "outside");
		await fs.symlink(outside, path.join(skillsRoot, "escape"));

		const result = resolveSkillPaths(["escape"], cwd, true);

		expect(result).toEqual({ paths: [], missing: ["escape"] });
	});

	it("rejects skill directories whose SKILL.md symlink escapes the root", async () => {
		const cwd = await makeProject();
		const skillsRoot = path.join(cwd, ".pi", "skills");
		const outsideFile = path.join(cwd, "outside-SKILL.md");
		await fs.mkdir(path.join(skillsRoot, "direct"), { recursive: true });
		await fs.mkdir(path.join(skillsRoot, "nested", "recursive"), { recursive: true });
		await fs.writeFile(outsideFile, "outside");
		await fs.symlink(outsideFile, path.join(skillsRoot, "direct", "SKILL.md"));
		await fs.symlink(outsideFile, path.join(skillsRoot, "nested", "recursive", "SKILL.md"));

		const result = resolveSkillPaths(["direct", "recursive"], cwd, true);

		expect(result).toEqual({ paths: [], missing: ["direct", "recursive"] });
	});

	it("rejects configured skill roots that are symbolic links", async () => {
		const cwd = await makeProject();
		const outsideFile = path.join(cwd, "outside-configured.md");
		const configuredLink = path.join(cwd, ".pi", "configured.md");
		await fs.mkdir(path.dirname(configuredLink), { recursive: true });
		await fs.writeFile(outsideFile, "outside");
		await fs.symlink(outsideFile, configuredLink);
		await fs.writeFile(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ skills: [configuredLink] }));

		const result = resolveSkillPaths(["configured"], cwd, true);

		expect(result).toEqual({ paths: [], missing: ["configured"] });
	});

	it("rejects configured skill roots with a symbolic-link parent component", async () => {
		const cwd = await makeProject();
		const outsideDir = path.join(cwd, "outside-parent");
		const nestedDir = path.join(cwd, "nested");
		await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
		await fs.mkdir(outsideDir);
		await fs.mkdir(nestedDir);
		await fs.writeFile(path.join(outsideDir, "configured.md"), "outside");
		await fs.symlink(outsideDir, path.join(nestedDir, "link"));
		await fs.writeFile(
			path.join(cwd, ".pi", "settings.json"),
			JSON.stringify({ skills: [path.join(nestedDir, "link", "configured.md")] }),
		);

		const result = resolveSkillPaths(["configured"], cwd, true);

		expect(result).toEqual({ paths: [], missing: ["configured"] });
	});

	it("loads valid project skills only after trust is granted", async () => {
		const cwd = await makeProject();
		const skillDir = path.join(cwd, ".pi", "skills", "safe-skill");
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(path.join(skillDir, "SKILL.md"), "safe");

		expect(resolveSkillPaths(["safe-skill"], cwd, false)).toEqual({ paths: [], missing: ["safe-skill"] });
		expect(resolveSkillPaths(["safe-skill"], cwd, true)).toEqual({ paths: [await fs.realpath(skillDir)], missing: [] });
	});
});
