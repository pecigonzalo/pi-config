/**
 * Tree-sitter based bash command parser for the permissions system.
 *
 * Uses tree-sitter-bash to produce a proper AST, which lets us:
 * - Cleanly separate commands from redirections (2>&1 is invisible)
 * - Extract individual commands from compounds (&&, ||, |)
 * - Identify command names and arguments without fragile regex
 * - Detect complex constructs (loops, subshells, etc.) from node types
 * - Compute approval prefixes via an arity table (like OpenCode)
 */

import * as path from "node:path";

// ─── Lazy parser initialization ───────────────────────────────────────────────

let parserPromise: Promise<any> | undefined;
let parserInstance: any | undefined;

async function getParser() {
	if (parserInstance) return parserInstance;
	if (parserPromise) return parserPromise;

	parserPromise = (async () => {
		const TreeSitter = require("web-tree-sitter");
		await TreeSitter.Parser.init();
		const parser = new TreeSitter.Parser();
		const wasmPath = path.join(__dirname, "node_modules/tree-sitter-bash/tree-sitter-bash.wasm");
		const lang = await TreeSitter.Language.load(wasmPath);
		parser.setLanguage(lang);
		parserInstance = parser;
		return parser;
	})();

	return parserPromise;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedCommand {
	/** Original source text including redirections (from redirected_statement if present) */
	source: string;
	/** Command text without redirections */
	command: string;
	/** The command name (first non-assignment word) */
	name: string;
	/** All tokens: command name + arguments (no flags stripped) */
	tokens: string[];
	/** Approval prefix tokens based on arity table */
	prefixTokens: string[];
	/** Approval "always" pattern: prefix + " *" */
	alwaysPattern: string;
}

export interface ParsedBash {
	/** Individual commands extracted from the AST */
	commands: ParsedCommand[];
	/** Whether the command has complex syntax (loops, subshells, process substitution, etc.) */
	isComplex: boolean;
	/** Top-level AST node type (for diagnostics) */
	topLevelType: string;
}

// ─── Arity table ──────────────────────────────────────────────────────────────
// Maps command prefix → number of tokens that form the "command identity".
// Longest matching prefix wins. Used to compute approval patterns.
// Adapted from OpenCode's BashArity with additions for our toolchain.

const ARITY: Record<string, number> = {
	// Basic Unix
	cat: 1, cd: 1, chmod: 1, chown: 1, cp: 1, echo: 1, env: 1, export: 1,
	grep: 1, head: 1, kill: 1, killall: 1, ln: 1, ls: 1, mkdir: 1, mv: 1,
	ps: 1, pwd: 1, rm: 1, rmdir: 1, sleep: 1, sort: 1, source: 1, tail: 1,
	tee: 1, touch: 1, uniq: 1, unset: 1, wc: 1, which: 1,
	// Build tools
	make: 2, task: 2, just: 2,
	// Node ecosystem
	bun: 2, "bun run": 3, "bun x": 3,
	npm: 2, "npm run": 3, "npm exec": 3, "npm init": 3,
	npx: 2, yarn: 2, "yarn run": 3, "yarn dlx": 3,
	pnpm: 2, "pnpm run": 3, "pnpm exec": 3, "pnpm dlx": 3,
	node: 2,
	// Go
	go: 2,
	// Rust
	cargo: 2, "cargo add": 3, "cargo run": 3,
	rustup: 2,
	// Python
	python: 2, python3: 2, pip: 2, pip3: 2,
	uv: 2, poetry: 2, pytest: 2,
	// Git
	git: 2, "git config": 3, "git remote": 3, "git stash": 3,
	// Docker
	docker: 2, "docker compose": 3, "docker container": 3,
	"docker image": 3, "docker volume": 3, "docker network": 3,
	podman: 2, "podman container": 3,
	// Cloud / infra
	terraform: 2, "terraform workspace": 3,
	tofu: 2, "tofu workspace": 3,
	aws: 3, gcloud: 3, az: 3,
	kubectl: 2, "kubectl rollout": 3,
	helm: 2, pulumi: 2,
	// Other
	brew: 2, gh: 3, sst: 2, turbo: 2, nx: 2, vercel: 2,
	rg: 1, find: 1, diff: 1, file: 1, stat: 1, du: 1, df: 1,
};

/**
 * Compute the approval prefix tokens from a list of command tokens.
 * Uses longest-matching-prefix from the arity table.
 * Falls back to just the command name (arity 1).
 */
export function arityPrefix(tokens: string[]): string[] {
	for (let len = tokens.length; len > 0; len--) {
		const prefix = tokens.slice(0, len).join(" ");
		const arity = ARITY[prefix];
		if (arity !== undefined) return tokens.slice(0, arity);
	}
	if (tokens.length === 0) return [];
	return tokens.slice(0, 1);
}

// ─── AST extraction ───────────────────────────────────────────────────────────

// Node types that indicate complex/dangerous constructs beyond simple commands
const COMPLEX_NODE_TYPES = new Set([
	"for_statement", "while_statement", "if_statement", "case_statement",
	"subshell", "command_substitution", "process_substitution",
	"function_definition", "c_style_for_statement",
]);

function isComplexNode(node: any): boolean {
	if (COMPLEX_NODE_TYPES.has(node.type)) return true;
	for (let i = 0; i < node.childCount; i++) {
		if (isComplexNode(node.child(i))) return true;
	}
	return false;
}

/** Get the source text of a command, including the redirected_statement wrapper if present */
function commandSource(node: any): string {
	return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim();
}

/** Extract tokens from a command node (command_name + word children, skipping redirections) */
function extractTokens(node: any): string[] {
	const tokens: string[] = [];
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (!child) continue;
		// Skip variable assignments (FOO=bar), redirections, and operators
		if (child.type === "variable_assignment") continue;
		if (child.type === "file_redirect" || child.type === "heredoc_redirect") continue;
		if (child.type === "command_name") {
			tokens.push(unquote(child.text));
			continue;
		}
		// Include word, string, raw_string, number, concatenation, simple_expansion, expansion
		if (["word", "string", "raw_string", "number", "concatenation",
			"simple_expansion", "expansion"].includes(child.type)) {
			tokens.push(unquote(child.text));
		}
	}
	return tokens;
}

/** Strip surrounding quotes from a token */
function unquote(text: string): string {
	if (text.length < 2) return text;
	const first = text[0];
	const last = text[text.length - 1];
	if ((first === '"' || first === "'") && first === last) return text.slice(1, -1);
	return text;
}

/** Recursively collect all `command` nodes from an AST */
function collectCommands(node: any): any[] {
	const result: any[] = [];
	if (node.type === "command") {
		result.push(node);
		return result; // don't descend into command children
	}
	for (let i = 0; i < node.childCount; i++) {
		const child = node.child(i);
		if (child) result.push(...collectCommands(child));
	}
	return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a bash command string using tree-sitter and extract structured info.
 * Returns individual commands with their approval patterns.
 */
export async function parseBashCommand(command: string): Promise<ParsedBash> {
	const parser = await getParser();
	const tree = parser.parse(command);
	const root = tree.rootNode;

	const isComplex = isComplexNode(root);
	const topLevelType = root.childCount === 1 ? root.child(0).type : "program";

	const commandNodes = collectCommands(root);
	const commands: ParsedCommand[] = [];

	for (const node of commandNodes) {
		const tokens = extractTokens(node);
		if (tokens.length === 0) continue;

		const name = tokens[0];
		const source = commandSource(node);
		const commandText = node.text.trim();
		const prefixTokens = arityPrefix(tokens);
		const alwaysPattern = prefixTokens.join(" ") + " *";

		commands.push({
			source,
			command: commandText,
			name,
			tokens,
			prefixTokens,
			alwaysPattern,
		});
	}

	return { commands, isComplex, topLevelType };
}

/**
 * Check if tree-sitter is available (wasm files present and loadable).
 * Caches the result after first call.
 */
let availabilityChecked = false;
let isAvailable = false;

export async function isTreeSitterAvailable(): Promise<boolean> {
	if (availabilityChecked) return isAvailable;
	try {
		await getParser();
		isAvailable = true;
	} catch {
		isAvailable = false;
	}
	availabilityChecked = true;
	return isAvailable;
}
