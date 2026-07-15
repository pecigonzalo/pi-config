/**
 * Permission previews stay usable by showing at most this many lines and
 * Unicode characters, including the explicit omission notice.
 */
export const PERMISSION_PREVIEW_MAX_LINES = 12;
export const PERMISSION_PREVIEW_MAX_CHARS = 1_200;

export interface PreviewLimits {
	maxLines?: number;
	maxChars?: number;
	/** Retain both the beginning and end when shortening. */
	preserveEnd?: boolean;
}

// Leaves room for both omission counters at JavaScript's maximum safe size.
const MIN_NOTICE_CHARS = 80;

/** Format untrusted text as plain, bounded text without silently hiding omissions. */
export function formatPermissionPreview(value: string, limits: PreviewLimits = {}): string {
	const maxLines = limits.maxLines ?? PERMISSION_PREVIEW_MAX_LINES;
	const maxChars = limits.maxChars ?? PERMISSION_PREVIEW_MAX_CHARS;
	const minimumLines = limits.preserveEnd ? 3 : 2;
	if (!Number.isInteger(maxLines) || maxLines < minimumLines) {
		throw new RangeError(`Preview maxLines must be an integer of at least ${minimumLines}`);
	}
	if (!Number.isInteger(maxChars) || maxChars < MIN_NOTICE_CHARS) {
		throw new RangeError(`Preview maxChars must be an integer of at least ${MIN_NOTICE_CHARS}`);
	}

	const sourceChars = Array.from(value);
	const sourceLines = value.split("\n");
	if (sourceLines.length <= maxLines && sourceChars.length <= maxChars) return value;

	if (limits.preserveEnd) {
		const contentLineLimit = maxLines - 1;
		const headLineLimit = Math.ceil(contentLineLimit / 2);
		const tailLineLimit = Math.floor(contentLineLimit / 2);
		const headAvailable = Array.from(sourceLines.slice(0, headLineLimit).join("\n"));
		const tailAvailable = Array.from(sourceLines.slice(-tailLineLimit).join("\n"));
		let contentBudget = Math.min(sourceChars.length, maxChars - 2);

		for (;;) {
			// Prefer retaining a complete final line when possible. For a single long
			// line, divide capacity evenly so both command ends remain recognizable.
			let tailCount =
				sourceLines.length > 1
					? Math.min(tailAvailable.length, Math.max(0, contentBudget - 1))
					: Math.min(tailAvailable.length, Math.floor(contentBudget / 2));
			let headCount = Math.min(headAvailable.length, sourceChars.length - tailCount, contentBudget - tailCount);
			// Give unused capacity on either side to the other, while preventing overlap.
			tailCount = Math.min(tailAvailable.length, sourceChars.length - headCount, contentBudget - headCount);
			const head = headAvailable.slice(0, headCount).join("");
			const tail = tailAvailable.slice(tailAvailable.length - tailCount).join("");
			const retainedLines = (head ? head.split("\n").length : 0) + (tail ? tail.split("\n").length : 0);
			const omittedLines = Math.max(0, sourceLines.length - retainedLines);
			const omittedChars = sourceChars.length - headCount - tailCount;
			const omissions = [
				omittedLines > 0 ? `${omittedLines} line${omittedLines === 1 ? "" : "s"}` : undefined,
				omittedChars > 0 ? `${omittedChars} character${omittedChars === 1 ? "" : "s"}` : undefined,
			]
				.filter((item): item is string => item !== undefined)
				.join(" and ");
			const notice = `[Preview shortened: omitted ${omissions}]`;
			const separators = (head ? 1 : 0) + (tail ? 1 : 0);
			const nextBudget = Math.min(contentBudget, maxChars - Array.from(notice).length - separators);
			if (nextBudget === contentBudget) return [head, notice, tail].filter(Boolean).join("\n");
			contentBudget = Math.max(0, nextBudget);
		}
	}

	const lineLimited = sourceLines.slice(0, maxLines - 1).join("\n");
	const availableChars = Array.from(lineLimited);
	let retainedCount = availableChars.length;

	// The notice length depends on the omitted character count. Iterate until the
	// retained prefix and its notice fit together.
	for (;;) {
		const prefix = availableChars.slice(0, retainedCount).join("");
		const retainedLines = prefix === "" ? 0 : prefix.split("\n").length;
		const omittedLines = Math.max(0, sourceLines.length - retainedLines);
		const omittedChars = sourceChars.length - retainedCount;
		const omissions = [
			omittedLines > 0 ? `${omittedLines} line${omittedLines === 1 ? "" : "s"}` : undefined,
			omittedChars > 0 ? `${omittedChars} character${omittedChars === 1 ? "" : "s"}` : undefined,
		]
			.filter((item): item is string => item !== undefined)
			.join(" and ");
		const notice = `[Preview shortened: omitted ${omissions}]`;
		const separatorLength = retainedCount > 0 ? 1 : 0;
		const nextRetainedCount = Math.min(
			retainedCount,
			Math.max(0, maxChars - Array.from(notice).length - separatorLength),
		);
		if (nextRetainedCount === retainedCount) return prefix ? `${prefix}\n${notice}` : notice;
		retainedCount = nextRetainedCount;
	}
}
