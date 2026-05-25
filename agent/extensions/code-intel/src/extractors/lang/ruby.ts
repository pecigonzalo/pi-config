import type { DefinitionPattern } from "../types";

export function rubyPatterns(): DefinitionPattern[] {
	return [
		{ kind: "class", re: /^class\s+([A-Za-z_][A-Za-z0-9_:]*)\b/ },
		{ kind: "module", re: /^module\s+([A-Za-z_][A-Za-z0-9_:]*)\b/ },
		{ kind: "method", re: /^def\s+([A-Za-z_][A-Za-z0-9_!?=]*)\b/ },
	];
}
