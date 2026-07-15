import type { DefinitionPattern } from "../types";

export function jvmPatterns(): DefinitionPattern[] {
	return [
		{
			kind: "class",
			re: /^(public\s+|private\s+|protected\s+|abstract\s+|final\s+|sealed\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
			nameGroup: 2,
		},
		{
			kind: "interface",
			re: /^(public\s+|private\s+|protected\s+)*interface\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
			nameGroup: 2,
		},
		{ kind: "enum", re: /^(public\s+|private\s+|protected\s+)*enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/, nameGroup: 2 },
		{
			kind: "method",
			re: /^(public\s+|private\s+|protected\s+|static\s+|final\s+|override\s+|suspend\s+)*[A-Za-z_][A-Za-z0-9_<>,.?\[\]\s]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*[{;]/,
			nameGroup: 2,
		},
		{
			kind: "function",
			re: /^(public\s+|private\s+|protected\s+|internal\s+)?fun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
			nameGroup: 2,
		},
	];
}
