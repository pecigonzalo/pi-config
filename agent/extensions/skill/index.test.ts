import { describe, expect, it, mock } from "bun:test";

mock.module("@earendil-works/pi-tui", () => ({
	Text: class Text {
		constructor(..._args: unknown[]) {}
	},
}));

mock.module("typebox", () => ({
	Type: {
		Object: <T>(value: T) => value,
		String: <T>(value: T) => value,
	},
}));

const { __test__ } = await import("./index");

describe("skill extension lookup", () => {
	const loaded = __test__.extractLoadedSkills([
		{
			name: "team-skills",
			description: "Shared procedures",
			filePath: "/repo/.pi/skills/release-checklist.md",
			baseDir: "/repo/.pi/skills",
			disableModelInvocation: false,
		},
		{
			name: "role-architect",
			description: "Architecture guidance",
			filePath: "/repo/.pi/skills/role-architect/SKILL.md",
			baseDir: "/repo/.pi/skills/role-architect",
			disableModelInvocation: true,
		},
	]);

	it("resolves by canonical skill name", () => {
		const lookup = __test__.createSkillLookup(loaded);
		const resolved = __test__.resolveSkillRecord(lookup, "role-architect", "/repo");
		expect(resolved?.filePath).toBe("/repo/.pi/skills/role-architect/SKILL.md");
	});

	it("resolves root markdown skills by inferred filename alias", () => {
		const lookup = __test__.createSkillLookup(loaded);
		const resolved = __test__.resolveSkillRecord(lookup, "release-checklist", "/repo");
		expect(resolved?.name).toBe("team-skills");
		expect(resolved?.filePath).toBe("/repo/.pi/skills/release-checklist.md");
	});

	it("resolves by path when the skill is already loaded", () => {
		const lookup = __test__.createSkillLookup(loaded);
		expect(__test__.resolveSkillRecord(lookup, "/repo/.pi/skills/release-checklist.md", "/repo")?.name).toBe("team-skills");
		expect(__test__.resolveSkillRecord(lookup, ".pi/skills/release-checklist.md", "/repo")?.name).toBe("team-skills");
	});

	it("does not resolve unknown skills", () => {
		const lookup = __test__.createSkillLookup(loaded);
		expect(__test__.resolveSkillRecord(lookup, "missing-skill", "/repo")).toBeNull();
	});
});
