import type { DefinitionPattern } from "../types";

export function pythonPatterns(): DefinitionPattern[] {
	return [
		{ kind: "class", re: /^class\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
		{ kind: "function", re: /^(async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, nameGroup: 2 },
	];
}
