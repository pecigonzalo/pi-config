import { describe, expect, it } from "bun:test";
import { formatPermissionPreview } from "./preview";

describe("formatPermissionPreview", () => {
	it("returns exact fits and empty input unchanged", () => {
		const exact = `${"1".repeat(40)}\n${"2".repeat(39)}`;
		expect(Array.from(exact)).toHaveLength(80);
		expect(formatPermissionPreview(exact, { maxLines: 2, maxChars: 80 })).toBe(exact);
		expect(formatPermissionPreview("", { maxLines: 2, maxChars: 80 })).toBe("");
	});

	it("reports character truncation within the character cap", () => {
		const preview = formatPermissionPreview("a".repeat(120), { maxLines: 3, maxChars: 80 });
		expect(preview).toBe(`${"a".repeat(37)}\n[Preview shortened: omitted 83 characters]`);
		expect(Array.from(preview)).toHaveLength(80);
	});

	it("reports line truncation within the line cap", () => {
		const preview = formatPermissionPreview("one\ntwo\nthree\nfour", { maxLines: 3, maxChars: 100 });
		expect(preview).toBe("one\ntwo\n[Preview shortened: omitted 2 lines and 11 characters]");
		expect(preview.split("\n")).toHaveLength(3);
	});

	it("honors combined line and character limits", () => {
		const preview = formatPermissionPreview("abcdefghij\nklmnopqrst\nuvwxyz\nlast", { maxLines: 3, maxChars: 90 });
		expect(preview.split("\n").length).toBeLessThanOrEqual(3);
		expect(Array.from(preview).length).toBeLessThanOrEqual(90);
		expect(preview).toContain("Preview shortened: omitted");
		expect(preview).toContain("lines");
		expect(preview).toContain("characters");
	});

	it("preserves fitting multiline Unicode and never splits a Unicode character", () => {
		expect(formatPermissionPreview("αβ\n😀終", { maxLines: 2, maxChars: 80 })).toBe("αβ\n😀終");
		const preview = formatPermissionPreview("😀".repeat(100), { maxLines: 2, maxChars: 80 });
		expect(preview).not.toContain("�");
		expect(Array.from(preview).length).toBeLessThanOrEqual(80);
	});

	it("preserves the dangerous suffix of a long single-line preview", () => {
		const suffix = " && rm -rf /danger";
		const preview = formatPermissionPreview(`echo ${"😀".repeat(100)}${suffix}`, {
			maxLines: 3,
			maxChars: 100,
			preserveEnd: true,
		});
		expect(preview).toStartWith("echo ");
		expect(preview).toEndWith(suffix);
		expect(preview).toContain("[Preview shortened: omitted");
		expect(preview.split("\n")).toHaveLength(3);
		expect(Array.from(preview).length).toBeLessThanOrEqual(100);
		expect(preview).not.toContain("�");
	});

	it("preserves a dangerous final line under combined line and character caps", () => {
		const finalLine = "rm -rf /dangerous-final-line";
		const value = [`echo ${"x".repeat(100)}`, "middle-one", "middle-two", finalLine].join("\n");
		const preview = formatPermissionPreview(value, { maxLines: 4, maxChars: 100, preserveEnd: true });
		expect(preview).toStartWith("echo ");
		expect(preview).toEndWith(finalLine);
		expect(preview).toContain("lines and");
		expect(preview.split("\n").length).toBeLessThanOrEqual(4);
		expect(Array.from(preview).length).toBeLessThanOrEqual(100);
	});

	it.each([
		{ maxLines: 1, maxChars: 100 },
		{ maxLines: 2.5, maxChars: 100 },
		{ maxLines: 2, maxChars: 10 },
		{ maxLines: 2, maxChars: Number.NaN },
		{ maxLines: 2, maxChars: 100, preserveEnd: true },
	])("rejects invalid limits: %o", (limits) => {
		expect(() => formatPermissionPreview("text", limits)).toThrow(RangeError);
	});
});
