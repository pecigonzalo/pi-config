/**
 * Skill Preservation Extension
 *
 * After compaction the agent loses awareness of which skills were loaded.
 * This extension:
 *   1. Tracks every SKILL.md the agent reads during a session (via tool_call)
 *   2. On compaction (session_compact), sets a flag
 *   3. On the next agent turn (before_agent_start), injects a one-time note into
 *      the system prompt listing the skills that were active, so the agent knows
 *      to reload them if still relevant
 *
 * No new turns are triggered; the note is silently appended to the system prompt
 * for a single turn, then cleared.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// Skill name → SKILL.md absolute path (accumulated across the session)
	const activeSkills = new Map<string, string>();

	// Whether to inject the reminder on the next agent turn
	let pendingReload = false;

	// ── Helpers ─────────────────────────────────────────────────────────────

	/**
	 * Extracts the skill name from a SKILL.md file path.
	 * e.g. "/home/user/.pi/agent/skills/role-architect/SKILL.md" → "role-architect"
	 */
	function skillNameFromPath(filePath: string): string | null {
		const match = filePath.replace(/\\/g, "/").match(/\/([^/]+)\/SKILL\.md$/i);
		return match?.[1] ?? null;
	}

	/**
	 * Scans the session branch for read tool calls targeting SKILL.md files
	 * and rebuilds the activeSkills map. Called on session_start and session_tree
	 * so state is correct after resume, fork, or tree navigation.
	 */
	function reconstructSkills(ctx: ExtensionContext): void {
		activeSkills.clear();

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "assistant") continue;

			for (const part of msg.content) {
				if (part.type !== "toolCall" || part.name !== "read") continue;

				const args = part.arguments as Record<string, unknown>;
				// The read tool uses "path"; some older invocations may use "file_path"
				const fp = (args.path ?? args.file_path) as string | undefined;
				if (typeof fp === "string" && /\/SKILL\.md$/i.test(fp)) {
					const name = skillNameFromPath(fp);
					if (name) activeSkills.set(name, fp);
				}
			}
		}
	}

	// ── Session lifecycle ────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Clear the pending flag on new/resumed/forked sessions — a fresh context
		// doesn't need the compaction reminder from a prior run.
		pendingReload = false;
		reconstructSkills(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		// After tree navigation the active branch changes; rebuild from it.
		// Keep pendingReload as-is: if a compaction just fired we still want to remind.
		reconstructSkills(ctx);
	});

	// ── Real-time skill tracking ─────────────────────────────────────────────

	pi.on("tool_call", async (event, _ctx) => {
		if (event.toolName !== "read") return undefined;

		const input = event.input as Record<string, unknown>;
		const fp = (input.path ?? input.file_path) as string | undefined;

		if (typeof fp === "string" && /\/SKILL\.md$/i.test(fp)) {
			const name = skillNameFromPath(fp);
			if (name) activeSkills.set(name, fp);
		}

		return undefined; // never block
	});

	// ── Compaction detection ─────────────────────────────────────────────────

	pi.on("session_compact", async (_event, _ctx) => {
		if (activeSkills.size > 0) {
			pendingReload = true;
		}
	});

	// ── Reminder injection ───────────────────────────────────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!pendingReload || activeSkills.size === 0) return undefined;

		// Consume the flag — inject once, then stay silent.
		pendingReload = false;

		const skillList = Array.from(activeSkills.keys())
			.map((name) => `  - ${name}`)
			.join("\n");

		const note = [
			"",
			"---",
			"**Skill Preservation Notice**: The following skills were loaded before the",
			"last compaction and may still be relevant to the current task. Use the",
			"`read` tool to reload their `SKILL.md` files if you still need their guidance:",
			skillList,
			"---",
		].join("\n");

		return {
			systemPrompt: event.systemPrompt + note,
		};
	});
}
