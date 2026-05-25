import type { DefinitionPattern } from "../types";

export function goPatterns(): DefinitionPattern[] {
	return [
		{ kind: "method", re: /^func\s*\([^)]*\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
		{ kind: "function", re: /^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
		{ kind: "type", re: /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface|\w+)/ },
	];
}
