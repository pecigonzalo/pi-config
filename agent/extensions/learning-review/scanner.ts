const PROMPT_INJECTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, reason: "prompt injection" },
	{ pattern: /you\s+are\s+now\s+/i, reason: "role hijack" },
	{ pattern: /system\s+prompt\s+override/i, reason: "system prompt override" },
	{ pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, reason: "instruction bypass" },
];

const SECRET_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\bsk-ant-api\S{10,}\b/, reason: "Anthropic API key" },
	{ pattern: /\bsk-or-v1-\S{10,}\b/, reason: "OpenRouter API key" },
	{ pattern: /\bsk-\S{20,}\b/, reason: "OpenAI-style API key" },
	{ pattern: /\bAKIA[0-9A-Z]{16}\b/, reason: "AWS access key" },
	{ pattern: /\bghp_\S{10,}\b/, reason: "GitHub token" },
	{ pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\sKEY-----/, reason: "private key" },
	{ pattern: /\b(password|secret|token)\s*[=:]\s*\S{8,}\b/i, reason: "inline credential" },
];

const INVISIBLE_CHARS = new Set(["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e"]);

export function scanLearningText(text: string): string | undefined {
	for (const char of text) {
		if (INVISIBLE_CHARS.has(char)) return `contains invisible unicode character U+${char.charCodeAt(0).toString(16).toUpperCase()}`;
	}

	for (const { pattern, reason } of PROMPT_INJECTION_PATTERNS) {
		if (pattern.test(text)) return `looks like ${reason}`;
	}

	for (const { pattern, reason } of SECRET_PATTERNS) {
		if (pattern.test(text)) return `looks like ${reason}`;
	}

	return undefined;
}
