import type { DefinitionPattern } from "../types";

export function swiftPatterns(): DefinitionPattern[] {
	return [
		{
			kind: "class",
			re: /^(public\s+|private\s+|internal\s+|open\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
			nameGroup: 2,
		},
		{ kind: "struct", re: /^(public\s+|private\s+|internal\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/, nameGroup: 2 },
		{
			kind: "protocol",
			re: /^(public\s+|private\s+|internal\s+)?protocol\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
			nameGroup: 2,
		},
		{
			kind: "function",
			re: /^(public\s+|private\s+|internal\s+|static\s+|class\s+)*func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
			nameGroup: 2,
		},
	];
}
