import { IDENT_RE, KEYWORDS, MAX_SIGNATURE_LINES } from "../constants";
import type { Definition, SourceFile } from "../types";
import type { DefinitionPattern } from "./types";
import { cFamilyPatterns } from "./lang/c-family";
import { goPatterns } from "./lang/go";
import { javascriptPatterns } from "./lang/javascript";
import { jvmPatterns } from "./lang/jvm";
import { phpPatterns } from "./lang/php";
import { pythonPatterns } from "./lang/python";
import { rubyPatterns } from "./lang/ruby";
import { rustPatterns } from "./lang/rust";
import { swiftPatterns } from "./lang/swift";

const PATTERN_REGISTRY: Record<string, () => DefinitionPattern[]> = {
	typescript: javascriptPatterns,
	tsx: javascriptPatterns,
	javascript: javascriptPatterns,
	jsx: javascriptPatterns,
	go: goPatterns,
	python: pythonPatterns,
	rust: rustPatterns,
	java: jvmPatterns,
	kotlin: jvmPatterns,
	csharp: jvmPatterns,
	php: phpPatterns,
	ruby: rubyPatterns,
	c: cFamilyPatterns,
	cpp: cFamilyPatterns,
	swift: swiftPatterns,
};

export function extractDefinitions(file: SourceFile, text: string): Definition[] {
	const lines = text.split(/\r?\n/);
	const definitions: Definition[] = [];

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const match = matchDefinition(file.language, line);
		if (!match) continue;
		definitions.push({
			name: match.name,
			kind: match.kind,
			file: file.relPath,
			line: index,
			column: line.indexOf(match.name),
			text: line.trimEnd(),
			signatureLines: captureSignature(lines, index, file.language),
			score: 0,
			backend: "syntax-pattern",
		});
	}

	return definitions;
}

export function matchDefinition(language: string, line: string): { name: string; kind: string } | undefined {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) return;

	const patterns = PATTERN_REGISTRY[language]?.() ?? javascriptPatterns();
	for (const pattern of patterns) {
		const match = trimmed.match(pattern.re);
		if (!match) continue;
		const name = match[pattern.nameGroup ?? 1];
		if (!name || KEYWORDS.has(name.toLowerCase())) continue;
		return { name, kind: pattern.kind };
	}
}

export function captureSignature(lines: string[], start: number, language: string): string[] {
	const out: string[] = [];
	let parenDepth = 0;
	let bracketDepth = 0;
	for (let i = start; i < Math.min(lines.length, start + MAX_SIGNATURE_LINES); i++) {
		const line = lines[i].trimEnd();
		out.push(line);
		for (const char of line) {
			if (char === "(") parenDepth++;
			else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
			else if (char === "[") bracketDepth++;
			else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
		}
		const trimmed = line.trim();
		if (i === start && language === "python" && trimmed.endsWith(":")) break;
		if (i > start && parenDepth === 0 && bracketDepth === 0) break;
		if (parenDepth === 0 && bracketDepth === 0 && /[{;:]\s*$/.test(trimmed)) break;
		if (parenDepth === 0 && bracketDepth === 0 && /=>\s*[{(]?\s*$/.test(trimmed)) break;
	}
	return out;
}

export function extractImportLines(lines: string[]): Array<{ line: number; text: string }> {
	const imports: Array<{ line: number; text: string }> = [];
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (/^(import|export\s+.*from|from\s+\S+\s+import|package\s+|use\s+|mod\s+|require\(|#include\s+)/.test(trimmed)) {
			imports.push({ line: i, text: lines[i].trimEnd() });
		}
	}
	return imports;
}

export function findDefinitionEnd(lines: string[], start: number, language: string): number {
	if (["python", "ruby"].includes(language)) return findIndentBlockEnd(lines, start);
	return findBraceBlockEnd(lines, start);
}

function findIndentBlockEnd(lines: string[], start: number): number {
	const startIndent = leadingWhitespace(lines[start] ?? "");
	let end = start;
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) {
			end = i;
			continue;
		}
		const indent = leadingWhitespace(line);
		if (indent <= startIndent) break;
		end = i;
	}
	return end;
}

function findBraceBlockEnd(lines: string[], start: number): number {
	let depth = 0;
	let sawOpen = false;
	let end = start;
	for (let i = start; i < Math.min(lines.length, start + 500); i++) {
		const line = lines[i];
		for (const char of line) {
			if (char === "{") {
				depth++;
				sawOpen = true;
			} else if (char === "}") {
				depth--;
			}
		}
		end = i;
		if (sawOpen && depth <= 0) break;
		if (!sawOpen && i > start && !line.trim()) break;
	}
	return end;
}

function leadingWhitespace(line: string): number {
	return line.length - line.trimStart().length;
}

export function extractReferences(text: string): Map<string, number> {
	const references = new Map<string, number>();
	const stripped = text.replace(/\/\/.*|#.*|\/\*[\s\S]*?\*\//g, " ");
	for (const match of stripped.matchAll(IDENT_RE)) {
		const ident = match[0];
		if (KEYWORDS.has(ident.toLowerCase())) continue;
		if (/^\d/.test(ident)) continue;
		references.set(ident, (references.get(ident) ?? 0) + 1);
	}
	return references;
}

export function mergeDefinitions(primary: Definition[], secondary: Definition[]): Definition[] {
	const merged = [...primary];
	const seen = new Set(primary.map(definitionIdentity));
	for (const definition of secondary) {
		const key = definitionIdentity(definition);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(definition);
	}
	return merged.sort((a, b) => a.line - b.line || a.column - b.column || a.name.localeCompare(b.name));
}

function definitionIdentity(definition: Definition): string {
	return `${definition.file}\0${definition.line}\0${definition.kind}\0${definition.name}`;
}

export function findEnclosingDefinition(
	definitions: Definition[],
	lines: string[],
	zeroLine: number,
	language: string,
): { definition: Definition; endLine: number } | undefined {
	return definitions
		.map((definition) => ({ definition, endLine: findDefinitionEnd(lines, definition.line, language) }))
		.filter((item) => item.definition.line <= zeroLine && item.endLine >= zeroLine)
		.sort((a, b) => b.definition.line - a.definition.line)[0];
}
