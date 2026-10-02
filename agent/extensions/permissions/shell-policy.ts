import { ruleMatch } from "./matching";
import { baseRestrictionMode, type PermissionMode, type Rule } from "./shared";
import { arityPrefix, type ParsedBash, type ParsedCommand } from "./shell-parse";

export function sandboxFallbackModeForPolicy(mode: PermissionMode): "normal" | "ask-all-bash" | "block-all-bash" {
	const base = baseRestrictionMode(mode);
	if (base === "plan") return "block-all-bash";
	if (base === "workspace-write") return "ask-all-bash";
	return "normal";
}

// ── Dangerous command detection (parsed, name-map based) ──────────────────────
// The dangerous-command list lives here as a name map (plus git subcommands)
// and is checked against the *resolved* command node from the tree-sitter AST,
// never against the raw whole-command string. Execution wrappers (`command rm`, ...)
// are stripped by unwrapCommand first, so `command rm -rf /` resolves to `rm` and
// is still flagged, while `command -v rm` (a lookup) resolves to nothing.

const DANGEROUS_COMMAND_NAMES: Record<string, string> = {
	rm: "Deletes files",
	mv: "Moves or renames",
	sudo: "Elevated privileges",
	chmod: "Changes permissions or ownership",
	chown: "Changes permissions or ownership",
	kill: "Terminates processes",
};

/** Git subcommands that touch remotes or rewrite the working tree/history. */
const DANGEROUS_GIT_SUBCOMMANDS: Record<string, string> = {
	push: "Pushes to a remote",
	clean: "Deletes untracked files",
	rebase: "Rewrites commit history",
};

function isDangerousGitSubcommand(tokens: string[]): string | undefined {
	if ((tokens[0] ?? "").toLowerCase() !== "git") return undefined;
	const subcommand = (tokens[1] ?? "").toLowerCase();
	if (DANGEROUS_GIT_SUBCOMMANDS[subcommand]) return DANGEROUS_GIT_SUBCOMMANDS[subcommand];
	// Only `git reset --hard` is flagged: plain `git reset` (mixed) and `--soft`
	// keep the working tree, matching the old whole-command regex.
	if (subcommand === "reset" && tokens[2] === "--hard") return "Discards uncommitted changes";
	return undefined;
}

function isDangerousCurl(source: string, name: string): boolean {
	if (name !== "curl") return false;
	return /\bcurl\b.+(-X\s*(POST|PUT|DELETE|PATCH)|--request\s+(POST|PUT|DELETE|PATCH))/i.test(source);
}

/**
 * Reason the resolved command is dangerous, or undefined. `cmd` must already be the
 * effective (wrapper-stripped) command — callers go through dangerReasonForParsedCommand.
 */
function detectDangerousParsedCommand(cmd: ParsedCommand): string | undefined {
	const direct = cmd.name.toLowerCase();
	if (DANGEROUS_COMMAND_NAMES[direct]) return DANGEROUS_COMMAND_NAMES[direct];
	if (isDangerousCurl(cmd.source, direct)) return "HTTP write operation";
	return isDangerousGitSubcommand(cmd.tokens);
}

/**
 * Fail-closed token scan for wrapper forms whose inner command can't be resolved to a
 * clean name (the wrapper ran nothing, or a combined flag was left as the name). Each
 * remaining token is checked for an embedded dangerous command, including opaque string
 * tokens that may hold a full command line (`env -S "rm -rf /"`). Only reached for
 * degenerate wrapper forms, so normal arguments (e.g. `echo "rm -rf /"`) never hit this.
 */
function detectDangerousEmbedded(tokens: string[]): string | undefined {
	for (const raw of tokens) {
		const token = raw.trim().toLowerCase();
		if (!token) continue;
		if (DANGEROUS_COMMAND_NAMES[token]) return DANGEROUS_COMMAND_NAMES[token];
		const words = token.split(/\s+/);
		if (words.length > 1) {
			const first = words[0] ?? "";
			if (DANGEROUS_COMMAND_NAMES[first]) return DANGEROUS_COMMAND_NAMES[first];
			const git = isDangerousGitSubcommand(words);
			if (git) return git;
		}
	}
	// Wrapper arguments that spilled into separate tokens (e.g. `env -S "git push ..."`
	// after quote-stripping in the text form) can hide a git subcommand across token
	// boundaries; check every git-sized window after the wrapper's own name.
	for (let i = 1; i < tokens.length; i++) {
		const git = isDangerousGitSubcommand(tokens.slice(i, i + 3));
		if (git) return git;
	}
	return undefined;
}

/**
 * Reason a parsed command is dangerous, or undefined. Applies wrapper normalization
 * first, so the inner command is what gets judged: `command rm -rf /` resolves to
 * `rm`, while `command -v rm` (a read-only lookup) resolves to nothing and is handled
 * by the safe-segment list. When the wrapper's target can't be tokenized
 * (`env -S "rm -rf /"`) or a combined flag is left as the inner name
 * (`time -pvr rm -rf /`), the raw tokens are scanned for embedded dangerous commands.
 */
export function dangerReasonForParsedCommand(cmd: ParsedCommand): string | undefined {
	const effective = unwrapCommand(cmd);
	if (effective === undefined) return detectDangerousEmbedded(cmd.tokens) ?? detectDangerousParsedCommand(cmd);
	if (effective !== cmd && effective.name.startsWith("-")) {
		return detectDangerousEmbedded(cmd.tokens) ?? detectDangerousParsedCommand(effective);
	}
	return detectDangerousParsedCommand(effective);
}

/**
 * Reason a command *text* is dangerous, or undefined. Converts the string to a rough
 * token form (quotes stripped, words split) and reuses the parsed-name logic. Best-effort
 * backstop for callers without a tree-sitter parse — the permissions flow always uses
 * dangerReasonForParsedCommand on real parse output. Conservative on purpose: the auto
 * classifier must never auto-allow something this flags.
 */
export function dangerReasonForCommandText(command: string): string | undefined {
	const text = command.trim();
	if (!text) return undefined;
	const words = text
		.replace(/["']/g, "")
		.split(/\s+/)
		.filter((word) => word.length > 0);
	if (words.length === 0) return undefined;
	const synthetic: ParsedCommand = {
		source: command,
		command: text,
		name: words[0] ?? "",
		tokens: words,
		prefixTokens: [],
		alwaysPattern: "",
		redirectionTexts: [],
	};
	return dangerReasonForParsedCommand(synthetic);
}

// ── Execution wrappers ────────────────────────────────────────────────────────
// Builtins/keywords that merely run the rest of the command line: `command foo`,
// `env FOO=x foo`, `xargs foo`, ... . The wrapper itself is inert, so it is
// stripped before evaluation and the inner command is judged normally — `command ls`
// is evaluated as `ls`, `command rm -rf /` stays flagged as a delete.
// `command -v/-V` never runs anything and is handled by isSafeShellSegment.
// Wrappers whose target can't be tokenized (`env -S "rm -rf /"`) are covered by
// dangerReasonForParsedCommand's embedded token scan so a hidden `rm` can't sneak
// past an allow rule.

const EXECUTION_WRAPPERS = new Set(["command", "builtin", "exec", "env", "nohup", "xargs", "time"]);

/** Own options for each wrapper; anything else after the wrapper is the inner command. */
const WRAPPER_FLAGS: Record<string, ReadonlySet<string>> = {
	command: new Set(["-p", "--"]), // -v/-V handled by the lookup check below
	builtin: new Set(), // takes no options of its own
	exec: new Set(["-a", "-c", "-l", "--"]),
	env: new Set([
		"-i",
		"-0",
		"-u",
		"-C",
		"-S",
		"--ignore-environment",
		"--null",
		"--unset",
		"--chdir",
		"--split-string",
		"--",
	]),
	nohup: new Set(["-h", "--help", "--version"]),
	time: new Set(["-p", "-v", "-a", "-o", "--output", "--append", "--verbose", "--quiet", "--format", "--"]),
	xargs: new Set([
		"-0",
		"-r",
		"-x",
		"-t",
		"-p",
		"-E",
		"-I",
		"-L",
		"-n",
		"-P",
		"-s",
		"-d",
		"-a",
		"--",
		"--null",
		"--no-run-if-empty",
		"--show-limits",
		"--verbose",
		"--interactive",
		"--max-lines",
		"--max-args",
		"--max-procs",
		"--replace",
		"--delimiter",
		"--arg-file",
	]),
};

/** Wrapper options that consume the following token as their argument. */
const WRAPPER_FLAG_ARGS: Record<string, ReadonlySet<string>> = {
	exec: new Set(["-a"]),
	env: new Set(["-u", "-C", "--unset", "--chdir"]),
	time: new Set(["-o", "--output", "--format"]),
	xargs: new Set([
		"-E",
		"-I",
		"-L",
		"-n",
		"-P",
		"-s",
		"-d",
		"-a",
		"--max-lines",
		"--max-args",
		"--max-procs",
		"--replace",
		"--delimiter",
		"--arg-file",
	]),
};

/**
 * The command that a segment actually runs: the segment itself, or the inner
 * command behind a wrapper (wrapper and its own options stripped). Returns
 * undefined when the wrapper runs nothing (`command` alone) or its target can't
 * be tokenized safely (`env -S "..."`).
 */
function unwrapCommand(cmd: ParsedCommand): ParsedCommand | undefined {
	const name = cmd.name.toLowerCase();
	if (!EXECUTION_WRAPPERS.has(name)) return cmd;
	const tokens = cmd.tokens;

	if (name === "command") {
		// `command -v/-V ...` only looks a command up; nothing is executed.
		for (let i = 1; i < tokens.length; i++) {
			const token = tokens[i];
			if (token === undefined || !/^-[pPvV]+$/.test(token)) break;
			if (/[vV]/.test(token)) return undefined;
		}
	}

	const inner: string[] = [];
	const ownFlags = WRAPPER_FLAGS[name] ?? new Set<string>();
	const argFlags = WRAPPER_FLAG_ARGS[name];
	let skipNext = false;
	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === undefined) break;
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue; // env assignment
		if (name === "env" && (token === "-S" || token === "--split-string")) return undefined; // command-string arg, can't tokenize
		if (ownFlags.has(token)) {
			if (argFlags?.has(token)) skipNext = true;
			continue;
		}
		inner.push(token);
	}
	if (inner.length === 0) return undefined;

	const prefixTokens = arityPrefix(inner);
	return {
		source: cmd.source,
		command: inner.join(" "),
		name: inner[0] ?? "",
		tokens: inner,
		prefixTokens,
		alwaysPattern: prefixTokens.join(" ") + " *",
		redirectionTexts: cmd.redirectionTexts,
	};
}

// ── Statically safe bash segments ────────────────────────────────────────────
// Commands whose effect is provably side-effect-free (or trivially bounded) and
// reversible. When a parsed segment classifies as safe it is skipped in permission
// consideration, so a compound like `sleep 1 && npm test` only ever prompts about
// the part that actually matters (here: `npm test`). The unsafe part is never the
// safe segment itself; it is the accompanying command, which is still checked
// segment-by-segment, or an abuse vector we deliberately exclude below:
//   - redirections (except /dev/null and fd dup/close) can write files: `sleep 1 > x`
//   - unbounded sleep durations can tie up the sandbox: `sleep 999999`
//   - expansions/substitutions make the value unknowable → not safe
//   - bare `set` dumps the environment; wrappers with a target (`command foo`) are
//     not safe here — unwrapCommand evaluates the inner command instead

const SAFE_SLEEP_MAX_SECONDS = 600; // generous for build waits; blocks `sleep 999999`
const SLEEP_DURATION_RE = /^([0-9]+(?:\.[0-9]+)?)([smhd])?$/i;

/** fd dup/close redirects: `2>&1`, `>&1`, `2>&-`, `<&2` */
const FD_REDIRECT_RE = /^(?:\d+)?[<>]&(?:\d+|-)$/;
/** redirects to /dev/null only (any fd, append, read, or both-output form) */
const DEV_NULL_REDIRECT_RE = /^(?:\d+)?(?:[<>]>?|&>|>&)\s*\/dev\/null$/;

function isSafeFileRedirect(text: string): boolean {
	const trimmed = text.trim();
	return FD_REDIRECT_RE.test(trimmed) || DEV_NULL_REDIRECT_RE.test(trimmed);
}

function isSafeSleep(tokens: string[]): boolean {
	if (tokens.length !== 2) return false; // exactly one duration argument
	const match = SLEEP_DURATION_RE.exec(tokens[1] ?? "");
	if (!match) return false;
	const value = Number.parseFloat(match[1] ?? "");
	const unit = (match[2] ?? "s").toLowerCase();
	const seconds = unit === "m" ? value * 60 : unit === "h" ? value * 3600 : unit === "d" ? value * 86400 : value;
	return Number.isFinite(seconds) && seconds >= 0 && seconds <= SAFE_SLEEP_MAX_SECONDS;
}

function isSafeSet(tokens: string[]): boolean {
	// `set` only mutates options and positional parameters of the current shell; effects never
	// outlive the single bash invocation, and `set` itself cannot execute code or touch files.
	// Bare `set` dumps the environment, so require at least one argument. Command substitutions
	// in the arguments (`set $(rm -rf /)`) surface as their own parsed segments and are still
	// checked independently.
	return tokens.length >= 2;
}

function isSafeCommandLookup(tokens: string[]): boolean {
	// `command -v name` / `command -p -v name` / `command -V name` only look up a
	// command; bare `command name` executes name and must never be auto-approved.
	let sawLookupFlag = false;
	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === undefined || !/^-[pPvV]+$/.test(token)) break;
		if (/[vV]/.test(token)) sawLookupFlag = true;
	}
	return sawLookupFlag;
}

/**
 * True when the parsed segment is statically provable to be side-effect-free or
 * trivially bounded and reversible: safe even without any matching allow rule.
 */
export function isSafeShellSegment(cmd: ParsedCommand): boolean {
	if (cmd.redirectionTexts.some((text) => !isSafeFileRedirect(text))) return false;
	const name = cmd.name.toLowerCase();
	switch (name) {
		case "sleep":
			return isSafeSleep(cmd.tokens);
		case "set":
			return isSafeSet(cmd.tokens);
		case "command":
			return isSafeCommandLookup(cmd.tokens);
		case "true":
		case "false":
		case ":":
			return true; // explicit no-ops; any arguments are ignored
		default:
			return false;
	}
}

// ── Tree-sitter-based policy functions ────────────────────────────────────────
// These operate on a pre-parsed AST (ParsedBash) from shell-parse.ts.

/**
 * Check if a single parsed command is allowed by rules (not dangerous, rule matches "allow",
 * or statically safe and not overridden by an explicitly matching rule).
 * Execution wrappers (`command`, `env`, `xargs`, ...) are stripped first so the inner
 * command is what gets evaluated: `command ls` is judged as `ls`, and `command rm -rf /`
 * stays judged as a delete.
 */
export function isParsedCommandAllowed(cmd: ParsedCommand, rules: Rule[]): boolean {
	const effective = unwrapCommand(cmd);
	// Rules match the original source (keeps redirect-target patterns working) plus the
	// effective command text, so a `ls *` allow/block rule also governs `command ls`.
	const targets = effective && effective !== cmd ? [cmd.source, effective.command] : [cmd.source];
	// A block rule (explicit or catch-all) always wins: `block all bash` must stay
	// block-all-bash, not "block-all-bash except sleep".
	if (matchBashRule(rules, targets, false)?.action === "block") return false;

	if (effective === undefined) {
		// Wrapper that runs nothing: `command -v name` is a read-only lookup and is safe;
		// everything else (bare `command`, `env -S "rm -rf /"`) is judged on its own, with
		// the embedded token scan guarding string-embedded commands.
		if (isSafeShellSegment(cmd)) return true;
		if (dangerReasonForParsedCommand(cmd)) return false;
		return isParsedCommandAllowedCore(cmd, rules, targets);
	}
	// Wrapped (or not a wrapper at all): judge the resolved inner command. A combined
	// wrapper flag left as the inner name is covered by the embedded token scan inside
	// dangerReasonForParsedCommand, so `time -pvr rm -rf /` still fails closed.
	if (dangerReasonForParsedCommand(cmd)) return false;
	return isParsedCommandAllowedCore(effective, rules, targets);
}

function isParsedCommandAllowedCore(cmd: ParsedCommand, rules: Rule[], targets: string[]): boolean {
	// Rules that explicitly name this command still win over the static safe-segment list,
	// so a user can opt back into prompting/blocking for e.g. `sleep` with their own rule.
	const explicitRule = matchBashRule(rules, targets, true);
	if (explicitRule) return explicitRule.action === "allow";
	if (isSafeShellSegment(cmd)) return true;
	return matchBashRule(rules, targets, false)?.action === "allow";
}

/**
 * First matching bash rule over the candidate targets (source + effective command text).
 * Catch-all rules (no match pattern) are returned only when explicitOnly is false; block
 * and allow callers use that, the explicit-rule override uses explicitOnly.
 */
function matchBashRule(rules: Rule[], targets: string[], explicitOnly: boolean): Rule | undefined {
	for (const rule of rules) {
		if (rule.tool !== "*" && rule.tool !== "bash") continue;
		if (rule.match === undefined) {
			if (explicitOnly) continue;
			return rule;
		}
		if (targets.some((target) => ruleMatch(rule, "bash", target))) return rule;
	}
	return undefined;
}

/**
 * Check if a parsed command is covered by existing approvals.
 */
export function isParsedCommandApproved(cmd: ParsedCommand, isApproved: (candidate: string) => boolean): boolean {
	return isApproved(cmd.source) || isApproved(cmd.command) || isApproved(cmd.alwaysPattern);
}

/**
 * Find the first unapproved command in a parsed bash AST.
 * Returns the ParsedCommand that needs approval, or undefined if all are approved.
 */
export function getFirstUnapprovedParsedCommand(
	parsed: ParsedBash,
	rules: Rule[],
	isApproved?: (candidate: string) => boolean,
): ParsedCommand | undefined {
	for (const cmd of parsed.commands) {
		if (isParsedCommandAllowed(cmd, rules)) continue;
		if (isApproved && isParsedCommandApproved(cmd, isApproved)) continue;
		return cmd;
	}
	return undefined;
}

/**
 * Check if all commands in a parsed bash AST are allowed (by rules or approvals).
 */
export function isAllParsedCommandsAllowed(
	parsed: ParsedBash,
	rules: Rule[],
	isApproved?: (candidate: string) => boolean,
): boolean {
	if (parsed.commands.length === 0) return false;
	return getFirstUnapprovedParsedCommand(parsed, rules, isApproved) === undefined;
}

export function canAutoApproveParsedBash(
	parsed: ParsedBash,
	rules: Rule[],
	isApproved?: (candidate: string) => boolean,
): boolean {
	if (parsed.isComplex) return false;
	return isAllParsedCommandsAllowed(parsed, rules, isApproved);
}
