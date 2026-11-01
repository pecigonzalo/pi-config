import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import skillPreservationExtension, { __test__ } from "./index";

describe("skill-preservation helpers", () => {
	it("infers skill names from SKILL.md and root markdown files", () => {
		expect(__test__.inferSkillNameFromPath("/repo/.pi/skills/role-architect/SKILL.md")).toBe("role-architect");
		expect(__test__.inferSkillNameFromPath("/repo/.pi/skills/release-checklist.md")).toBe("release-checklist");
	});

	it("resolves root markdown reads through known skill metadata", () => {
		const known = __test__.buildKnownSkillIndex([
			{
				name: "release-checklist",
				filePath: "/repo/.pi/skills/release-checklist.md",
				baseDir: "/repo/.pi/skills",
			},
		]);

		const matched = __test__.resolveSkillFromReadPath(".pi/skills/release-checklist.md", known);
		expect(matched).not.toBeNull();
		expect(matched?.name).toBe("release-checklist");
		expect(matched?.path).toBe("/repo/.pi/skills/release-checklist.md");
		expect(__test__.resolveSkillFromReadPath("README.md", known)).toBeNull();
	});

	it("reconstructs active skills from successful tool results and expanded /skill blocks", () => {
		const known = __test__.buildKnownSkillIndex([
			{
				name: "release-checklist",
				filePath: "/repo/.pi/skills/release-checklist.md",
				baseDir: "/repo/.pi/skills",
			},
		]);

		const entries: unknown[] = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "read-1",
							name: "read",
							arguments: { path: "/repo/.pi/skills/bad/SKILL.md" },
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					toolCallId: "read-1",
					isError: true,
					content: [],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "read-2",
							name: "read",
							arguments: { path: ".pi/skills/release-checklist.md" },
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					toolCallId: "read-2",
					isError: false,
					content: [],
				},
			},
			{
				type: "message",
				message: {
					role: "user",
					content: [
						{
							type: "text",
							text: '<skill name="incident-response" location="/repo/.pi/skills/incident-response/SKILL.md">\nrunbook\n</skill>',
						},
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "skill",
					toolCallId: "skill-1",
					isError: false,
					details: {
						name: "debug-plan",
						path: "/repo/.pi/skills/debug-plan.md",
						baseDir: "/repo/.pi/skills",
					},
					content: [],
				},
			},
		];

		const active = __test__.reconstructActiveSkills(entries, known);
		const names = Array.from(active.values())
			.map((skill) => skill.name)
			.sort();

		expect(names).toEqual(["debug-plan", "incident-response", "release-checklist"]);
	});

	it("builds notice lines including paths", () => {
		const note = __test__.buildSkillPreservationNotice([
			{ name: "incident-response", path: "/repo/.pi/skills/incident-response/SKILL.md" },
		]);
		expect(note).toContain("incident-response: /repo/.pi/skills/incident-response/SKILL.md");
		expect(note).toContain('skill(name: "...")');
		expect(note).toContain('read(path: "...")');
	});
});

describe("skill-preservation before_agent_start", () => {
	const skill = {
		name: "release-checklist",
		filePath: "/repo/.pi/skills/release-checklist.md",
		baseDir: "/repo/.pi/skills",
	};

	const skillBlock =
		'<skill name="release-checklist" location="/repo/.pi/skills/release-checklist.md">\nsteps\n</skill>';

	const branch = [
		{
			type: "message",
			message: { role: "user", content: [{ type: "text", text: skillBlock }] },
		},
	];

	function createHarness() {
		const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown>>();
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => Promise<unknown>) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		skillPreservationExtension(pi);
		return { handlers, ctx: { sessionManager: { getBranch: () => branch } } };
	}

	it("keeps the post-compaction notice for user turns instead of custom runs", async () => {
		const { handlers, ctx } = createHarness();
		const beforeAgentStart = handlers.get("before_agent_start");
		const sessionCompact = handlers.get("session_compact");
		if (!beforeAgentStart || !sessionCompact) throw new Error("handlers were not registered");

		const systemPromptOptions = { skills: [skill] };
		await beforeAgentStart({ messageType: "user", systemPrompt: "base", systemPromptOptions }, ctx);
		await sessionCompact({}, ctx);

		const customRun = await beforeAgentStart(
			{
				messageType: "custom",
				message: { role: "user", content: [] },
				systemPrompt: "base",
				systemPromptOptions,
			},
			ctx,
		);
		expect(customRun).toBeUndefined();

		const userRun = await beforeAgentStart({ messageType: "user", systemPrompt: "base", systemPromptOptions }, ctx);
		expect(userRun).toMatchObject({ systemPrompt: expect.stringContaining("Skill Preservation Notice") });
	});
});
