import type { DefinitionPattern } from "../types";

export function phpPatterns(): DefinitionPattern[] {
	return [
		{ kind: "class", re: /^(abstract\s+|final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\b/, nameGroup: 2 },
		{ kind: "interface", re: /^interface\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
		{
			kind: "function",
			re: /^(public\s+|private\s+|protected\s+|static\s+)*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
			nameGroup: 2,
		},
	];
}
