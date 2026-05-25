import type { DefinitionPattern } from "../types";

export interface GoInterfaceMemberMatch {
	name: string;
	line: number;
	column: number;
	container: string;
	text: string;
}

export function goPatterns(): DefinitionPattern[] {
	return [
		{ kind: "method", re: /^func\s*\([^)]*\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
		{ kind: "function", re: /^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
		{ kind: "type", re: /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface|\w+)/ },
	];
}

export function extractGoInterfaceMembers(lines: string[]): GoInterfaceMemberMatch[] {
	const out: GoInterfaceMemberMatch[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const start = line.trim().match(/^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+interface\s*\{/);
		if (!start) continue;
		const container = start[1];

		let depth = braceDelta(line);
		for (let j = i + 1; j < lines.length; j++) {
			const current = lines[j];
			const trimmed = current.trim();
			depth += braceDelta(current);

			if (
				trimmed &&
				!trimmed.startsWith("//") &&
				!trimmed.startsWith("/*") &&
				!trimmed.startsWith("*") &&
				trimmed !== "}" &&
				depth >= 1
			) {
				const member = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
				if (member) {
					const name = member[1];
					out.push({
						name,
						line: j,
						column: current.indexOf(name),
						container,
						text: current.trimEnd(),
					});
				}
			}

			if (depth <= 0) {
				i = j;
				break;
			}
		}
	}
	return out;
}

function braceDelta(line: string): number {
	let delta = 0;
	for (const char of line) {
		if (char === "{") delta++;
		if (char === "}") delta--;
	}
	return delta;
}
