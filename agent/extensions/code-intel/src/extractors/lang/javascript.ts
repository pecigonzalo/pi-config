import type { DefinitionPattern } from "../types";

export function javascriptPatterns(): DefinitionPattern[] {
	return [
		{
			kind: "class",
			re: /^(export\s+)?(default\s+)?(abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/,
			nameGroup: 4,
		},
		{ kind: "interface", re: /^(export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/, nameGroup: 2 },
		{ kind: "type", re: /^(export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/, nameGroup: 2 },
		{ kind: "enum", re: /^(export\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/, nameGroup: 2 },
		{
			kind: "function",
			re: /^(export\s+)?(default\s+)?(async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/,
			nameGroup: 4,
		},
		{
			kind: "function",
			re: /^(export\s+)?(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(async\s*)?(\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/,
			nameGroup: 3,
		},
		{
			kind: "function",
			re: /^(export\s+)?(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(async\s*)?function\b/,
			nameGroup: 3,
		},
		{
			kind: "method",
			re: /^(public\s+|private\s+|protected\s+|static\s+|async\s+|override\s+|readonly\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*[:{]/,
			nameGroup: 2,
		},
	];
}
