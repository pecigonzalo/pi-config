/**
 * nvim diff review extension
 *
 * Hooks edit/write tool calls and presents each proposal as a two-way diff
 * review through the extension UI protocol. Pairs with alex35mil/pi.nvim,
 * which decodes the select title JSON and renders the diff; on accept the
 * editor client writes the file (proposed or user-modified version) and the
 * tool call is blocked so pi's dispatcher does not double-apply.
 *
 * Active only in RPC mode (`pi --mode rpc`), so terminal pi keeps running
 * edits without review. Flip the mode guard to review in all modes if
 * desired.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ReviewNote = {
	path: string;
	side: "old" | "new" | "current";
	lineStart: number;
	lineEnd: number;
	lines: string[];
	note: string;
};

function formatNotes(notes?: ReviewNote[]): string {
	if (!notes?.length) return "";
	return (
		"\n\nReview notes:\n" +
		notes
			.map((n) => {
				const range = n.lineStart === n.lineEnd ? `${n.lineStart}` : `${n.lineStart}-${n.lineEnd}`;
				return `- ${n.side}:${range} ${JSON.stringify(n.lines)}\n  ${n.note}`;
			})
			.join("\n")
	);
}

export default function (pi: ExtensionAPI): void {
	// Tool calls the user approved: their blocked results come back as
	// isError=true; flip them back to success so the agent does not treat
	// accepted edits as failures.
	const approvedToolCalls = new Set<string>();

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") {
			return undefined; // other tools run without review
		}

		// Only review edits when an editor client (pi.nvim) is attached.
		// Terminal pi, print, and json modes keep current behavior.
		if (ctx.mode !== "rpc") {
			return undefined;
		}

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `[rejected] No UI available to review ${event.toolName}`,
			};
		}

		const input = event.input as { path?: string } | undefined;
		const path = input?.path;
		if (!path) return undefined;

		// Payload pi.nvim recognizes as a diff review request.
		const title = JSON.stringify({
			prompt: `${event.toolName}: ${path}`,
			toolName: event.toolName,
			toolInput: event.input,
		});
		const choice = await ctx.ui.select(title, ["Accept", "Reject"]);

		// pi TUI path: plain "Accept", let the tool run normally.
		if (choice === "Accept") {
			return undefined;
		}

		// pi.nvim path: structured JSON response.
		if (choice?.startsWith("{")) {
			const parsed = JSON.parse(choice) as {
				result: string;
				content?: string;
				notes?: ReviewNote[];
			};

			if (parsed.result === "Accepted") {
				// pi.nvim already wrote the file; block the tool so pi's
				// dispatcher does not double-write.
				approvedToolCalls.add(event.toolCallId);
				return {
					block: true,
					reason:
						`[accepted] User approved the edit. Changes applied to ${path} as proposed.` +
						formatNotes(parsed.notes),
				};
			}

			if (parsed.result === "AcceptModified") {
				// pi.nvim wrote a user-modified version of the file.
				approvedToolCalls.add(event.toolCallId);
				return {
					block: true,
					reason:
						`[accepted] User approved with modifications. ${path} was updated with user's version, which differs from what you proposed.` +
						formatNotes(parsed.notes) +
						`\n\nCurrent content of ${path}:\n` +
						"```\n" +
						(parsed.content ?? "") +
						"\n```",
				};
			}

			if (parsed.result === "Rejected") {
				// Rejected with review notes: keep the file unchanged, but let
				// the turn continue so the agent can address the feedback.
				return {
					block: true,
					reason: `[rejected] User rejected the edit to ${path}. File unchanged.` + formatNotes(parsed.notes),
				};
			}
		}

		// Rejected without review notes, cancelled, or unknown response: stop the turn.
		ctx.abort();
		return {
			block: true,
			reason: `[rejected] User rejected the edit to ${path}. File unchanged.`,
		};
	});

	// Blocked tool results come back as isError=true. Flip that back for
	// approved calls so the agent doesn't treat accepted edits as failures.
	pi.on("message_end", async (event) => {
		const msg = event.message as { role?: string; toolCallId?: string; isError?: boolean } | undefined;
		if (!msg || msg.role !== "toolResult") return;
		if (typeof msg.toolCallId !== "string") return;
		if (approvedToolCalls.delete(msg.toolCallId)) {
			msg.isError = false;
		}
	});
}
