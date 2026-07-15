import { IDENT_RE, KEYWORDS, MAX_SIGNATURE_LINES } from "../constants";
import type { Definition, SourceFile } from "../types";
import { extractGoInterfaceMembers, goPatterns } from "./lang/go";
import { cFamilyPatterns } from "./lang/c-family";
import { javascriptPatterns } from "./lang/javascript";
import { jvmPatterns } from "./lang/jvm";
import { phpPatterns } from "./lang/php";
import { pythonPatterns } from "./lang/python";
import { rubyPatterns } from "./lang/ruby";
import { rustPatterns } from "./lang/rust";
import { swiftPatterns } from "./lang/swift";
import type { DefinitionPattern } from "./types";

interface MatchedDefinition {
	name: string;
	kind: string;
	declaration?: boolean;
	container?: string;
	column?: number;
}

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
		if (line === undefined) continue;
		const match = matchDefinition(file.language, line);
		if (!match) continue;
		definitions.push({
			name: match.name,
			kind: match.kind,
			file: file.relPath,
			line: index,
			column: match.column ?? Math.max(0, line.indexOf(match.name)),
			text: line.trimEnd(),
			signatureLines: captureSignature(lines, index, file.language),
			score: 0,
			backend: "syntax-pattern",
			declaration: match.declaration,
			container: match.container,
		});
	}

	if (file.language === "go") {
		const interfaceMembers = extractGoInterfaceMembers(lines).map((member) => ({
			name: member.name,
			kind: "interface_method",
			file: file.relPath,
			line: member.line,
			column: member.column,
			text: member.text,
			signatureLines: [member.text],
			score: 0,
			backend: "syntax-pattern" as const,
			declaration: true,
			container: member.container,
		}));
		return mergeDefinitions(definitions, interfaceMembers);
	}

	return definitions;
}

export function matchDefinition(language: string, line: string): MatchedDefinition | undefined {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) return;
	if (language === "terraform") return matchTerraformDefinition(line);

	const patterns = PATTERN_REGISTRY[language]?.() ?? javascriptPatterns();
	for (const pattern of patterns) {
		const match = trimmed.match(pattern.re);
		if (!match) continue;
		const name = match[pattern.nameGroup ?? 1];
		if (!name || KEYWORDS.has(name.toLowerCase())) continue;
		return { name, kind: pattern.kind };
	}
}

function matchTerraformDefinition(line: string): MatchedDefinition | undefined {
	const trimmed = line.trim();
	const resourceMatch = trimmed.match(/^(resource|data)\s+"([^"]+)"\s+"([^"]+)"/);
	if (resourceMatch) {
		const kind = resourceMatch[1];
		const type = resourceMatch[2];
		const name = resourceMatch[3];
		if (!kind || !type || !name) return;
		return {
			name: `${type}.${name}`,
			kind,
			column: Math.max(0, line.indexOf(type)),
		};
	}

	const namedBlockMatch = trimmed.match(/^(module|variable|output|provider)\s+"([^"]+)"/);
	if (namedBlockMatch) {
		const kind = namedBlockMatch[1];
		const name = namedBlockMatch[2];
		if (!kind || !name || KEYWORDS.has(name.toLowerCase())) return;
		return { name, kind, column: Math.max(0, line.indexOf(name)) };
	}

	const singletonBlockMatch = trimmed.match(/^(terraform|locals)\s*\{/);
	const name = singletonBlockMatch?.[1];
	if (!name) return;
	return { name, kind: "block", column: Math.max(0, line.indexOf(name)) };
}

export function captureSignature(lines: string[], start: number, language: string): string[] {
	const out: string[] = [];
	let parenDepth = 0;
	let bracketDepth = 0;
	for (let i = start; i < Math.min(lines.length, start + MAX_SIGNATURE_LINES); i++) {
		const sourceLine = lines[i];
		if (sourceLine === undefined) continue;
		const line = sourceLine.trimEnd();
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

export function extractImportLines(lines: string[], language?: string): Array<{ line: number; text: string }> {
	const imports: Array<{ line: number; text: string }> = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) continue;
		const trimmed = line.trim();

		if (language === "go" && /^import\s*\($/.test(trimmed)) {
			for (let j = i + 1; j < lines.length; j++) {
				const innerLine = lines[j];
				if (innerLine === undefined) continue;
				const inner = innerLine.trim();
				if (inner === ")") {
					i = j;
					break;
				}
				if (!inner || inner.startsWith("//")) continue;
				imports.push({ line: j, text: innerLine.trimEnd() });
			}
			continue;
		}

		if (
			/^(import|export\s+.*from|from\s+\S+\s+import|package\s+|use\s+|mod\s+|require\(|#include\s+)/.test(trimmed)
		) {
			if (language === "go" && trimmed.startsWith("package ")) continue;
			imports.push({ line: i, text: line.trimEnd() });
		}
	}
	return imports;
}

export function getDefinitionEnd(definition: Definition, lines: string[], language: string): number {
	if (definition.declaration) return definition.line;
	return findDefinitionEnd(lines, definition.line, language);
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
		if (line === undefined) continue;
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
		if (line === undefined) continue;
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
		.map((definition) => ({ definition, endLine: getDefinitionEnd(definition, lines, language) }))
		.filter((item) => item.definition.line <= zeroLine && item.endLine >= zeroLine)
		.sort((a, b) => b.definition.line - a.definition.line)[0];
}
