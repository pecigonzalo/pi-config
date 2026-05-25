import type { DefinitionPattern } from "../types";

export function cFamilyPatterns(): DefinitionPattern[] {
	return [
		{ kind: "type", re: /^(typedef\s+)?(struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\b/, nameGroup: 3 },
		{ kind: "function", re: /^[A-Za-z_][A-Za-z0-9_*\s]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?$/ },
	];
}
