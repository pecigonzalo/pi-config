import type { DefinitionPattern } from "../types";

export function rustPatterns(): DefinitionPattern[] {
	return [
		{ kind: "function", re: /^(pub\s+)?(async\s+)?(unsafe\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/, nameGroup: 4 },
		{ kind: "struct", re: /^(pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/, nameGroup: 2 },
		{ kind: "enum", re: /^(pub\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/, nameGroup: 2 },
		{ kind: "trait", re: /^(pub\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)\b/, nameGroup: 2 },
		{ kind: "impl", re: /^impl(?:<[^>]+>)?\s+([A-Za-z_][A-Za-z0-9_:<>]*)\b/ },
	];
}
