/**
 * Session Guard Extension
 *
 * Protects against accidental session loss and enforces git hygiene before
 * context switches. Combines the patterns from confirm-destructive.ts and
 * dirty-repo-guard.ts into a single configurable extension.
 *
 * All guards are off by default — enable what you need in permissions.jsonc:
 *
 *   "sessionGuard": {
 *     "confirmNewSession": true,
 *     "confirmSwitchSession": true,
 *     "confirmFork": false,
 *     "dirtyRepo": "warn"
 *   }
 *
 * Fields:
 *   confirmNewSession    — prompt before /new clears the current session
 *                          default: false
 *   confirmSwitchSession — prompt before /resume when there are unsaved messages
 *                          default: false
 *   confirmFork          — prompt before /fork or /clone creates a branch
 *                          default: false
 *   dirtyRepo            — what to do when uncommitted git changes exist
 *                          "off"   — no check (default)
 *                          "warn"  — prompt; the user can proceed anyway
 *                          "block" — always cancel (works without a UI, safe for scripts)
 *
 * Config is read from ~/.pi/agent/permissions.jsonc (global) and
 * .pi/permissions.jsonc (project-local); project-local wins on conflict.
 */

import type { ExtensionAPI, ExtensionContext, SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SessionGuardSettings {
	confirmNewSession?: boolean;
	confirmSwitchSession?: boolean;
	confirmFork?: boolean;
	dirtyRepo?: "off" | "warn" | "block";
}

// ─── Config loading ───────────────────────────────────────────────────────────

function parseJsonc(text: string): unknown {
	let noComments = "";
	let inString = false;
	let stringQuote = "";
	let escaping = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];

		if (inString) {
			noComments += ch;
			if (escaping) {
				escaping = false;
			} else if (ch === "\\") {
				escaping = true;
			} else if (ch === stringQuote) {
				inString = false;
				stringQuote = "";
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			inString = true;
			stringQuote = ch;
			noComments += ch;
			continue;
		}

		if (ch === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			if (i < text.length) noComments += "\n";
			continue;
		}

		if (ch === "/" && next === "*") {
			i += 2;
			while (i < text.length - 1 && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i++;
			continue;
		}

		noComments += ch;
	}

	let cleaned = "";
	inString = false;
	stringQuote = "";
	escaping = false;

	for (let i = 0; i < noComments.length; i++) {
		const ch = noComments[i];

		if (inString) {
			cleaned += ch;
			if (escaping) {
				escaping = false;
			} else if (ch === "\\") {
				escaping = true;
			} else if (ch === stringQuote) {
				inString = false;
				stringQuote = "";
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			inString = true;
			stringQuote = ch;
			cleaned += ch;
			continue;
		}

		if (ch === ",") {
			let j = i + 1;
			while (j < noComments.length && /\s/.test(noComments[j])) j++;
			if (j < noComments.length && (noComments[j] === "}" || noComments[j] === "]")) {
				continue;
			}
		}

		cleaned += ch;
	}

	return JSON.parse(cleaned);
}

/** Reads a .json or .jsonc file with support for comments and trailing commas. */
function readJsonFile(filePath: string): unknown | undefined {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return parseJsonc(raw);
	} catch {
		return undefined;
	}
}

function loadSettings(cwd: string): SessionGuardSettings {
	const globalPath = path.join(getAgentDir(), "permissions.jsonc");
	const projectPath = path.join(cwd, ".pi", "permissions.jsonc");

	const global = ((readJsonFile(globalPath) as { default?: { sessionGuard?: SessionGuardSettings } } | undefined)?.default
		?.sessionGuard ?? undefined) as SessionGuardSettings | undefined;
	const project = ((readJsonFile(projectPath) as { default?: { sessionGuard?: SessionGuardSettings } } | undefined)?.default
		?.sessionGuard ?? undefined) as SessionGuardSettings | undefined;

	// Project-local wins on each key
	return { ...global, ...project };
}

// ─── Dirty-repo check ─────────────────────────────────────────────────────────

/**
 * Runs `git status --porcelain` and acts according to the dirtyRepo policy.
 * Returns `{ cancel: true }` to abort the action, or `undefined` to proceed.
 */
async function checkDirtyRepo(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	settings: SessionGuardSettings,
	action: string,
): Promise<{ cancel: boolean } | undefined> {
	const policy = settings.dirtyRepo ?? "off";
	if (policy === "off") return undefined;

	const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);

	// Not a git repo — let it pass
	if (code !== 0) return undefined;

	const hasChanges = stdout.trim().length > 0;
	if (!hasChanges) return undefined;

	const changedFiles = stdout.trim().split("\n").filter(Boolean).length;
	const noun = changedFiles === 1 ? "file" : "files";

	if (policy === "block") {
		const msg = `You have ${changedFiles} uncommitted ${noun}. Commit or stash before ${action}.`;
		if (ctx.hasUI) ctx.ui.notify(`🚫 ${msg}`, "warning");
		return { cancel: true };
	}

	// policy === "warn" — non-interactive falls back to block
	if (!ctx.hasUI) return { cancel: true };

	const actionLabel = action.charAt(0).toUpperCase() + action.slice(1);
	const choice = await ctx.ui.select(
		`You have ${changedFiles} uncommitted ${noun}.\n${actionLabel} anyway?`,
		["Yes, proceed anyway", "No, let me commit first"],
	);

	if (choice !== "Yes, proceed anyway") {
		ctx.ui.notify("Commit your changes first", "warning");
		return { cancel: true };
	}

	return undefined;
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let settings: SessionGuardSettings = {};

	const reload = (cwd: string) => {
		settings = loadSettings(cwd);
	};

	pi.on("session_start", async (_event, ctx) => reload(ctx.cwd));
	pi.on("session_tree",  async (_event, ctx) => reload(ctx.cwd));

	// ── /new and /resume ──────────────────────────────────────────────────────

	pi.on("session_before_switch", async (event, ctx) => {
		const action = event.reason === "new" ? "new session" : "switch session";

		// Dirty-repo check runs first, regardless of confirm flags
		const dirty = await checkDirtyRepo(pi, ctx, settings, action);
		if (dirty?.cancel) return { cancel: true };

		if (!ctx.hasUI) return undefined;

		if (event.reason === "new" && settings.confirmNewSession) {
			const ok = await ctx.ui.confirm(
				"Clear session?",
				"This will delete all messages in the current session.",
			);
			if (!ok) {
				ctx.ui.notify("Clear cancelled", "info");
				return { cancel: true };
			}
		}

		if (event.reason === "resume" && settings.confirmSwitchSession) {
			const entries = ctx.sessionManager.getEntries();
			const hasUnsavedWork = entries.some(
				(e): e is SessionMessageEntry => e.type === "message" && e.message.role === "user",
			);
			if (hasUnsavedWork) {
				const ok = await ctx.ui.confirm(
					"Switch session?",
					"You have messages in the current session. Switch anyway?",
				);
				if (!ok) {
					ctx.ui.notify("Switch cancelled", "info");
					return { cancel: true };
				}
			}
		}

		return undefined;
	});

	// ── /fork and /clone ─────────────────────────────────────────────────────

	pi.on("session_before_fork", async (event, ctx) => {
		const isClone = event.position === "at";
		const action = isClone ? "clone" : "fork";
		const dirty = await checkDirtyRepo(pi, ctx, settings, action);
		if (dirty?.cancel) return { cancel: true };

		if (!ctx.hasUI || !settings.confirmFork) return undefined;

		const confirmLabel = isClone ? "Yes, create clone" : "Yes, create fork";
		const cancelLabel = isClone ? "Clone cancelled" : "Fork cancelled";
		const promptTitle = isClone ? "Clone session?" : "Fork session?";
		const choice = await ctx.ui.select(promptTitle, [confirmLabel, "No, stay in current session"]);

		if (choice !== confirmLabel) {
			ctx.ui.notify(cancelLabel, "info");
			return { cancel: true };
		}

		return undefined;
	});
}
