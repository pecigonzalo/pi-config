/**
 * Session Guard Extension
 *
 * Protects against accidental session loss, enforces git hygiene before
 * context switches, and optionally restores tracked code state for /fork,
 * /clone, and /tree navigation.
 *
 * Config example in permissions.jsonc:
 *
 *   "sessionGuard": {
 *     "confirmNewSession": true,
 *     "confirmSwitchSession": true,
 *     "confirmFork": false,
 *     "dirtyRepo": "warn",
 *     "restoreCodeOnFork": "ask",
 *     "restoreCodeOnTree": "ask"
 *   }
 *
 * Fields:
 *   confirmNewSession    — prompt before /new clears the current session
 *                          default: false
 *   confirmSwitchSession — prompt before /resume when there are unsaved messages
 *                          default: false
 *   confirmFork          — prompt before /fork or /clone creates a branch
 *                          default: false
 *   dirtyRepo            — what to do when uncommitted git changes exist
 *                          "off"   — no check (default)
 *                          "warn"  — prompt; the user can proceed anyway
 *                          "block" — always cancel (works without a UI, safe for scripts)
 *   restoreCodeOnFork    — restore saved tracked-file state before /fork or /clone
 *                          "off" (default) | "ask" | "auto"
 *   restoreCodeOnTree    — restore saved tracked-file state before /tree navigation
 *                          "off" (default) | "ask" | "auto"
 *
 * Checkpoints are captured at turn boundaries:
 * - pre-turn: nearest user entry (state before the assistant responds)
 * - post-turn: assistant/tool-result entries for the completed turn
 *
 * Checkpoints use git commit-ish refs. Clean states fall back to HEAD snapshots;
 * dirty states use `git stash create`, which is best-effort for tracked files.
 * Untracked files are not guaranteed to be recreated when restoring older states.
 *
 * Config is read from ~/.pi/agent/permissions.jsonc (global) and
 * .pi/permissions.jsonc (project-local); project-local wins on conflict.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

type DirtyRepoPolicy = "off" | "warn" | "block";
type RestoreMode = "off" | "ask" | "auto";
type CheckpointKind = "commit" | "stash";
type CheckpointCapture = "pre-turn" | "post-turn";
type CheckpointCompleteness = "full" | "tracked-only";

interface SessionGuardSettings {
  confirmNewSession?: boolean;
  confirmSwitchSession?: boolean;
  confirmFork?: boolean;
  dirtyRepo?: DirtyRepoPolicy;
  restoreCodeOnFork?: RestoreMode;
  restoreCodeOnTree?: RestoreMode;
}

interface StoredCheckpoint {
  entryIds: string[];
  ref: string;
  kind: CheckpointKind;
  capture: CheckpointCapture;
  completeness: CheckpointCompleteness;
  createdAt: number;
}

interface ResolvedCheckpoint {
  checkpoint: StoredCheckpoint;
  exact: boolean;
  matchedEntryId: string;
}

interface LoadedSettings {
  settings: SessionGuardSettings;
  warnings: string[];
}

interface RestoreCheckpointResult {
  error?: string;
  safetySnapshotCreated: boolean;
  safetySnapshotRef?: string;
}

interface SafetySnapshotResult {
  created: boolean;
  ref?: string;
  error?: string;
}

const CHECKPOINT_ENTRY_TYPE = "session-guard-checkpoint";
const CHECKPOINT_MESSAGE_PREFIX = "pi-session-guard";

function parseJsonc(text: string): unknown {
  let noComments = "";
  let inString = false;
  let stringQuote = "";
  let escaping = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      noComments += ch;
      if (escaping) {
        escaping = false;
      } else if (ch === "\\") {
        escaping = true;
      } else if (ch === stringQuote) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      noComments += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      if (i < text.length) noComments += "\n";
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length - 1 && !(text[i] === "*" && text[i + 1] === "/"))
        i++;
      i++;
      continue;
    }

    noComments += ch;
  }

  let cleaned = "";
  inString = false;
  stringQuote = "";
  escaping = false;

  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];

    if (inString) {
      cleaned += ch;
      if (escaping) {
        escaping = false;
      } else if (ch === "\\") {
        escaping = true;
      } else if (ch === stringQuote) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      cleaned += ch;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments[j])) j++;
      if (
        j < noComments.length &&
        (noComments[j] === "}" || noComments[j] === "]")
      ) {
        continue;
      }
    }

    cleaned += ch;
  }

  return JSON.parse(cleaned);
}

function readJsonFile(filePath: string): unknown | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return parseJsonc(raw);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function formatInvalidSettingWarning(
  key: string,
  actual: unknown,
  fallback: string,
): string {
  return `Invalid sessionGuard.${key} value (${JSON.stringify(actual)}); using "${fallback}".`;
}

function parseBooleanSetting(
  key: string,
  value: unknown,
  warnings: string[],
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  warnings.push(
    formatInvalidSettingWarning(
      key,
      value,
      "false",
    ),
  );
  return false;
}

function parseDirtyRepoPolicySetting(
  value: unknown,
  warnings: string[],
): DirtyRepoPolicy | undefined {
  if (value === undefined) return undefined;
  if (value === "off" || value === "warn" || value === "block") {
    return value;
  }
  warnings.push(formatInvalidSettingWarning("dirtyRepo", value, "off"));
  return "off";
}

function parseRestoreModeSetting(
  key: "restoreCodeOnFork" | "restoreCodeOnTree",
  value: unknown,
  warnings: string[],
): RestoreMode | undefined {
  if (value === undefined) return undefined;
  if (value === "off" || value === "ask" || value === "auto") {
    return value;
  }
  warnings.push(formatInvalidSettingWarning(key, value, "ask"));
  return "ask";
}

function sanitizeSettings(raw: unknown): LoadedSettings {
  if (!isRecord(raw)) return { settings: {}, warnings: [] };

  const warnings: string[] = [];
  const settings: SessionGuardSettings = {
    confirmNewSession: parseBooleanSetting(
      "confirmNewSession",
      raw.confirmNewSession,
      warnings,
    ),
    confirmSwitchSession: parseBooleanSetting(
      "confirmSwitchSession",
      raw.confirmSwitchSession,
      warnings,
    ),
    confirmFork: parseBooleanSetting("confirmFork", raw.confirmFork, warnings),
    dirtyRepo: parseDirtyRepoPolicySetting(raw.dirtyRepo, warnings),
    restoreCodeOnFork: parseRestoreModeSetting(
      "restoreCodeOnFork",
      raw.restoreCodeOnFork,
      warnings,
    ),
    restoreCodeOnTree: parseRestoreModeSetting(
      "restoreCodeOnTree",
      raw.restoreCodeOnTree,
      warnings,
    ),
  };

  return { settings, warnings };
}

function readSessionGuardSettings(filePath: string): unknown {
  const parsed = readJsonFile(filePath) as
    | { default?: { sessionGuard?: unknown } }
    | undefined;
  return parsed?.default?.sessionGuard;
}

function loadSettings(cwd: string): LoadedSettings {
  const globalPath = path.join(getAgentDir(), "permissions.jsonc");
  const projectPath = path.join(cwd, ".pi", "permissions.jsonc");

  const globalRaw = readSessionGuardSettings(globalPath);
  const projectRaw = readSessionGuardSettings(projectPath);

  const merged = {
    ...(isRecord(globalRaw) ? globalRaw : {}),
    ...(isRecord(projectRaw) ? projectRaw : {}),
  };

  return sanitizeSettings(merged);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function shouldCaptureCheckpoints(settings: SessionGuardSettings): boolean {
  return (
    (settings.restoreCodeOnFork ?? "off") !== "off" ||
    (settings.restoreCodeOnTree ?? "off") !== "off"
  );
}

function isNoSessionInvocation(): boolean {
  return process.argv.includes("--no-session");
}

function shouldCaptureCheckpointsForContext(
  settings: SessionGuardSettings,
  ctx: ExtensionContext,
): boolean {
  if (!shouldCaptureCheckpoints(settings)) return false;
  // Checkpoints are stored as custom session entries. In --no-session runs there
  // is no durable session to restore from, so capturing only risks stale writes
  // during teardown/reload.
  if (isNoSessionInvocation()) return false;
  return ctx.sessionManager.getSessionFile() !== undefined;
}

function isStaleSessionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /ctx is stale|session replacement or reload|captured pi or command ctx/.test(
      error.message,
    )
  );
}

function parseStoredCheckpoint(data: unknown): StoredCheckpoint | undefined {
  if (!data || typeof data !== "object") return undefined;

  const record = data as Record<string, unknown>;
  const entryIds = Array.isArray(record.entryIds)
    ? record.entryIds.filter(isNonEmptyString)
    : [];
  const ref = record.ref;
  const kind = record.kind;
  const capture = record.capture;
  const completeness = record.completeness;
  const createdAt = record.createdAt;

  if (entryIds.length === 0) return undefined;
  if (!isNonEmptyString(ref)) return undefined;
  if (kind !== "commit" && kind !== "stash") return undefined;
  if (capture !== "pre-turn" && capture !== "post-turn") return undefined;
  if (completeness !== "full" && completeness !== "tracked-only")
    return undefined;
  if (typeof createdAt !== "number") return undefined;

  return { entryIds, ref, kind, capture, completeness, createdAt };
}

function reconstructCheckpoints(
  entries: SessionEntry[],
): Map<string, StoredCheckpoint> {
  const checkpoints = new Map<string, StoredCheckpoint>();

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CHECKPOINT_ENTRY_TYPE)
      continue;
    const checkpoint = parseStoredCheckpoint(entry.data);
    if (!checkpoint) continue;
    for (const entryId of checkpoint.entryIds) {
      checkpoints.set(entryId, checkpoint);
    }
  }

  return checkpoints;
}

function buildEntryIndex(entries: SessionEntry[]): Map<string, SessionEntry> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

function collectPreTurnEntryIds(
  entries: SessionEntry[],
  leafId: string | undefined,
): string[] {
  if (!leafId) return [];

  const entriesById = buildEntryIndex(entries);
  let current = entriesById.get(leafId);

  while (current) {
    if (current.type === "message" && current.message.role === "user") {
      return [current.id];
    }
    current = current.parentId ? entriesById.get(current.parentId) : undefined;
  }

  return [];
}

function collectPostTurnEntryIds(
  entries: SessionEntry[],
  leafId: string | undefined,
): string[] {
  if (!leafId) return [];

  const entriesById = buildEntryIndex(entries);
  const collected = new Set<string>();
  let current = entriesById.get(leafId);

  while (current) {
    if (current.type === "message") {
      if (current.message.role === "user") break;
      collected.add(current.id);
    }
    current = current.parentId ? entriesById.get(current.parentId) : undefined;
  }

  return [...collected];
}

async function resolveGitRepoRoot(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string | undefined> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd,
  });
  const root = result.stdout.trim();
  if (result.code !== 0 || root.length === 0) return undefined;
  return root;
}

async function resolveHeadRef(
  pi: ExtensionAPI,
  repoRoot: string,
): Promise<string | undefined> {
  const result = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  const ref = result.stdout.trim();
  if (result.code !== 0 || ref.length === 0) return undefined;
  return ref;
}

function formatCommandFailure(
  command: string,
  stdout: string,
  stderr: string,
  code: number | null | undefined,
): string {
  const details =
    stderr.trim() || stdout.trim() || `exit code ${code ?? "unknown"}`;
  return `${command} failed: ${details}`;
}

async function createCheckpoint(
  pi: ExtensionAPI,
  cwd: string,
  capture: CheckpointCapture,
  targetEntryIds: string[],
): Promise<StoredCheckpoint | undefined> {
  const repoRoot = await resolveGitRepoRoot(pi, cwd);
  if (!repoRoot) return undefined;

  const status = await pi.exec(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: repoRoot },
  );
  if (status.code !== 0) return undefined;

  const statusLines = status.stdout.trim().split("\n").filter(Boolean);
  const hasUntracked = statusLines.some((line) => line.startsWith("??"));
  const hasChanges = statusLines.length > 0;
  const completeness: CheckpointCompleteness = hasUntracked
    ? "tracked-only"
    : "full";

  if (!hasChanges) {
    const headRef = await resolveHeadRef(pi, repoRoot);
    if (!headRef) return undefined;
    return {
      entryIds: [...targetEntryIds],
      ref: headRef,
      kind: "commit",
      capture,
      completeness: "full",
      createdAt: Date.now(),
    };
  }

  const stash = await pi.exec(
    "git",
    [
      "stash",
      "create",
      `${CHECKPOINT_MESSAGE_PREFIX} ${capture} ${targetEntryIds[0] ?? "entry"}`,
    ],
    { cwd: repoRoot },
  );
  const stashRef = stash.stdout.trim();
  if (stash.code === 0 && stashRef.length > 0) {
    return {
      entryIds: [...targetEntryIds],
      ref: stashRef,
      kind: "stash",
      capture,
      completeness,
      createdAt: Date.now(),
    };
  }

  const headRef = await resolveHeadRef(pi, repoRoot);
  if (!headRef) return undefined;

  return {
    entryIds: [...targetEntryIds],
    ref: headRef,
    kind: "commit",
    capture,
    completeness: "tracked-only",
    createdAt: Date.now(),
  };
}

async function captureCheckpoint(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  checkpoints: Map<string, StoredCheckpoint>,
  targetEntryIds: string[],
  capture: CheckpointCapture,
): Promise<void> {
  const uniqueTargetIds = [...new Set(targetEntryIds.filter(isNonEmptyString))];
  if (uniqueTargetIds.length === 0) return;
  if (uniqueTargetIds.every((entryId) => checkpoints.has(entryId))) return;

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return;
  const cwd = ctx.cwd;

  const checkpoint = await createCheckpoint(
    pi,
    cwd,
    capture,
    uniqueTargetIds,
  );
  if (!checkpoint) return;

  try {
    // A reload/session replacement can happen while createCheckpoint awaits git.
    // In that case this checkpoint belongs to the old runtime and must be
    // discarded rather than appended through stale session-bound APIs.
    if (ctx.sessionManager.getSessionFile() !== sessionFile) return;
    pi.appendEntry(CHECKPOINT_ENTRY_TYPE, checkpoint);
  } catch (error) {
    if (isStaleSessionError(error)) return;
    throw error;
  }

  for (const entryId of checkpoint.entryIds) {
    checkpoints.set(entryId, checkpoint);
  }
}

async function checkDirtyRepo(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  settings: SessionGuardSettings,
  action: string,
): Promise<{ cancel: boolean } | undefined> {
  const policy = settings.dirtyRepo ?? "off";
  if (policy === "off") return undefined;

  const { stdout, code } = await pi.exec("git", ["status", "--porcelain"], {
    cwd: ctx.cwd,
  });
  if (code !== 0) return undefined;

  const hasChanges = stdout.trim().length > 0;
  if (!hasChanges) return undefined;

  const changedFiles = stdout.trim().split("\n").filter(Boolean).length;
  const noun = changedFiles === 1 ? "file" : "files";

  if (policy === "block") {
    const msg = `You have ${changedFiles} uncommitted ${noun}. Commit or stash before ${action}.`;
    if (ctx.hasUI) ctx.ui.notify(`🚫 ${msg}`, "warning");
    return { cancel: true };
  }

  if (!ctx.hasUI) return { cancel: true };

  const actionLabel = action.charAt(0).toUpperCase() + action.slice(1);
  const choice = await ctx.ui.select(
    `You have ${changedFiles} uncommitted ${noun}.\n${actionLabel} anyway?`,
    ["Yes, proceed anyway", "No, let me commit first"],
  );

  if (choice !== "Yes, proceed anyway") {
    ctx.ui.notify("Commit your changes first", "warning");
    return { cancel: true };
  }

  return undefined;
}

function resolveCheckpointForEntry(
  entries: SessionEntry[],
  checkpoints: Map<string, StoredCheckpoint>,
  targetEntryId: string,
): ResolvedCheckpoint | undefined {
  const entriesById = buildEntryIndex(entries);
  let current = entriesById.get(targetEntryId);

  while (current) {
    const checkpoint = checkpoints.get(current.id);
    if (checkpoint) {
      return {
        checkpoint,
        exact: current.id === targetEntryId,
        matchedEntryId: current.id,
      };
    }
    current = current.parentId ? entriesById.get(current.parentId) : undefined;
  }

  return undefined;
}

function describeCheckpointSource(resolution: ResolvedCheckpoint): string {
  if (resolution.exact) return "the selected entry";
  return `nearest saved ancestor (${resolution.matchedEntryId.slice(0, 8)})`;
}

function buildRestorePrompt(
  actionLabel: string,
  resolution: ResolvedCheckpoint,
): string {
  const trackedOnlyNote =
    resolution.checkpoint.completeness === "tracked-only"
      ? "\nNote: only tracked-file state was saved; untracked files may not be recreated."
      : "";
  return `${actionLabel}: restore code state from ${describeCheckpointSource(resolution)}?${trackedOnlyNote}`;
}

function formatSafetySnapshotHint(snapshot: SafetySnapshotResult): string {
  if (!snapshot.created) return "";
  if (snapshot.ref) {
    return ` Local changes were saved to safety stash ${snapshot.ref}.`;
  }
  return " Local changes were saved to a safety stash.";
}

function appendSafetySnapshotHint(
  message: string,
  snapshot: SafetySnapshotResult,
): string {
  return `${message}${formatSafetySnapshotHint(snapshot)}`;
}

async function validateCheckpointRef(
  pi: ExtensionAPI,
  repoRoot: string,
  checkpoint: StoredCheckpoint,
): Promise<string | undefined> {
  const verifyTarget =
    checkpoint.kind === "commit"
      ? `${checkpoint.ref}^{tree}`
      : `${checkpoint.ref}^{commit}`;
  const verify = await pi.exec(
    "git",
    ["rev-parse", "--verify", "--quiet", verifyTarget],
    {
      cwd: repoRoot,
    },
  );

  if (verify.code !== 0 || verify.stdout.trim().length === 0) {
    return `Checkpoint ref ${JSON.stringify(checkpoint.ref)} is missing or invalid.`;
  }

  if (checkpoint.kind === "stash") {
    const parents = await pi.exec(
      "git",
      ["rev-list", "--parents", "-n", "1", checkpoint.ref],
      { cwd: repoRoot },
    );
    const parentCount = parents.stdout.trim().split(/\s+/).filter(Boolean).length;
    if (parents.code !== 0 || parentCount < 3) {
      return `Checkpoint stash ref ${JSON.stringify(checkpoint.ref)} is invalid.`;
    }
  }

  return undefined;
}

async function createSafetySnapshot(
  pi: ExtensionAPI,
  repoRoot: string,
): Promise<SafetySnapshotResult> {
  const status = await pi.exec(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: repoRoot },
  );

  if (status.code !== 0) {
    return {
      created: false,
      error: formatCommandFailure(
        "git status --porcelain --untracked-files=all",
        status.stdout,
        status.stderr,
        status.code,
      ),
    };
  }

  const hasChanges = status.stdout.trim().length > 0;
  if (!hasChanges) return { created: false };

  const stash = await pi.exec(
    "git",
    [
      "stash",
      "push",
      "--include-untracked",
      "--message",
      `${CHECKPOINT_MESSAGE_PREFIX} safety-restore ${new Date().toISOString()}`,
    ],
    { cwd: repoRoot },
  );

  if (stash.code !== 0) {
    return {
      created: false,
      error: formatCommandFailure(
        "git stash push --include-untracked",
        stash.stdout,
        stash.stderr,
        stash.code,
      ),
    };
  }

  const summary = `${stash.stdout}\n${stash.stderr}`;
  if (/No local changes to save/i.test(summary)) {
    return { created: false };
  }

  const refResult = await pi.exec(
    "git",
    ["rev-parse", "--verify", "--quiet", "stash@{0}"],
    {
      cwd: repoRoot,
    },
  );

  const ref = refResult.code === 0 ? refResult.stdout.trim() : undefined;
  return {
    created: true,
    ...(ref ? { ref } : {}),
  };
}

async function confirmDirtyRestoreAllowed(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  actionLabel: string,
): Promise<{ cancel: boolean } | undefined> {
  const repoRoot = await resolveGitRepoRoot(pi, ctx.cwd);
  if (!repoRoot) return undefined;

  const status = await pi.exec(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: repoRoot },
  );
  if (status.code !== 0) {
    if (ctx.hasUI) {
      ctx.ui.notify("Code restore cancelled: unable to inspect git status.", "error");
    } else {
      console.warn(
        "[session-guard] Refusing destructive code restore because git status could not be inspected.",
      );
    }
    return { cancel: true };
  }

  const changedFiles = status.stdout.trim().split("\n").filter(Boolean).length;
  if (changedFiles === 0) return undefined;

  const noun = changedFiles === 1 ? "file" : "files";
  if (!ctx.hasUI) {
    console.warn(
      `[session-guard] Refusing ${actionLabel.toLowerCase()} code restore in no-UI mode because ${changedFiles} uncommitted ${noun} would require destructive reset/clean.`,
    );
    return { cancel: true };
  }

  const choice = await ctx.ui.select(
    `${actionLabel}: ${changedFiles} uncommitted ${noun} detected.\nRestore will run git reset --hard and git clean -fd after creating a safety stash. Continue?`,
    ["Yes, stash and restore code", "No, keep current code"],
  );

  if (choice !== "Yes, stash and restore code") {
    ctx.ui.notify("Code restore cancelled; local changes kept.", "info");
    return { cancel: true };
  }

  return undefined;
}

async function restoreCheckpoint(
  pi: ExtensionAPI,
  cwd: string,
  checkpoint: StoredCheckpoint,
): Promise<RestoreCheckpointResult> {
  const repoRoot = await resolveGitRepoRoot(pi, cwd);
  if (!repoRoot) {
    return {
      error: "Not inside a git repository.",
      safetySnapshotCreated: false,
    };
  }

  const validationError = await validateCheckpointRef(pi, repoRoot, checkpoint);
  if (validationError) {
    return { error: validationError, safetySnapshotCreated: false };
  }

  const safetySnapshot = await createSafetySnapshot(pi, repoRoot);
  if (safetySnapshot.error) {
    return { error: safetySnapshot.error, safetySnapshotCreated: false };
  }

  const reset = await pi.exec("git", ["reset", "--hard", "HEAD"], {
    cwd: repoRoot,
  });
  if (reset.code !== 0) {
    return {
      error: appendSafetySnapshotHint(
        formatCommandFailure(
          "git reset --hard HEAD",
          reset.stdout,
          reset.stderr,
          reset.code,
        ),
        safetySnapshot,
      ),
      safetySnapshotCreated: safetySnapshot.created,
      safetySnapshotRef: safetySnapshot.ref,
    };
  }

  const clean = await pi.exec("git", ["clean", "-fd"], { cwd: repoRoot });
  if (clean.code !== 0) {
    return {
      error: appendSafetySnapshotHint(
        formatCommandFailure(
          "git clean -fd",
          clean.stdout,
          clean.stderr,
          clean.code,
        ),
        safetySnapshot,
      ),
      safetySnapshotCreated: safetySnapshot.created,
      safetySnapshotRef: safetySnapshot.ref,
    };
  }

  if (checkpoint.kind === "commit") {
    const restore = await pi.exec(
      "git",
      [
        "restore",
        `--source=${checkpoint.ref}`,
        "--staged",
        "--worktree",
        "--",
        ".",
      ],
      {
        cwd: repoRoot,
      },
    );
    if (restore.code !== 0) {
      return {
        error: appendSafetySnapshotHint(
          formatCommandFailure(
            `git restore --source=${checkpoint.ref}`,
            restore.stdout,
            restore.stderr,
            restore.code,
          ),
          safetySnapshot,
        ),
        safetySnapshotCreated: safetySnapshot.created,
        safetySnapshotRef: safetySnapshot.ref,
      };
    }
    return {
      safetySnapshotCreated: safetySnapshot.created,
      safetySnapshotRef: safetySnapshot.ref,
    };
  }

  const apply = await pi.exec(
    "git",
    ["stash", "apply", "--index", checkpoint.ref],
    { cwd: repoRoot },
  );
  if (apply.code !== 0) {
    return {
      error: appendSafetySnapshotHint(
        formatCommandFailure(
          `git stash apply --index ${checkpoint.ref}`,
          apply.stdout,
          apply.stderr,
          apply.code,
        ),
        safetySnapshot,
      ),
      safetySnapshotCreated: safetySnapshot.created,
      safetySnapshotRef: safetySnapshot.ref,
    };
  }

  return {
    safetySnapshotCreated: safetySnapshot.created,
    safetySnapshotRef: safetySnapshot.ref,
  };
}

async function maybeRestoreCodeState(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  checkpoints: Map<string, StoredCheckpoint>,
  entries: SessionEntry[],
  targetEntryId: string,
  mode: RestoreMode,
  actionLabel: string,
): Promise<{ cancel: boolean } | undefined> {
  if (mode === "off") return undefined;

  const resolution = resolveCheckpointForEntry(
    entries,
    checkpoints,
    targetEntryId,
  );
  if (!resolution) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        `No git checkpoint available for ${actionLabel.toLowerCase()}; leaving files unchanged.`,
        "warning",
      );
    }
    return undefined;
  }

  if (mode === "ask") {
    if (!ctx.hasUI) return undefined;
    const choice = await ctx.ui.select(
      buildRestorePrompt(actionLabel, resolution),
      ["No, keep current code", "Yes, restore code"],
    );
    if (choice !== "Yes, restore code") return undefined;
  }

  const dirtyConfirmation = await confirmDirtyRestoreAllowed(
    pi,
    ctx,
    actionLabel,
  );
  if (dirtyConfirmation?.cancel) return { cancel: true };

  const restoreResult = await restoreCheckpoint(pi, ctx.cwd, resolution.checkpoint);
  if (restoreResult.error) {
    if (ctx.hasUI)
      ctx.ui.notify(`Code restore failed: ${restoreResult.error}`, "error");
    return { cancel: true };
  }

  if (ctx.hasUI) {
    const message =
      resolution.checkpoint.completeness === "tracked-only"
        ? `Code restored from ${describeCheckpointSource(resolution)} (tracked files only).`
        : `Code restored from ${describeCheckpointSource(resolution)}.`;
    ctx.ui.notify(
      message,
      resolution.checkpoint.completeness === "tracked-only"
        ? "warning"
        : "info",
    );

    if (restoreResult.safetySnapshotCreated) {
      const safetyMessage = restoreResult.safetySnapshotRef
        ? `Safety stash created before restore: ${restoreResult.safetySnapshotRef}`
        : "Safety stash created before restore.";
      ctx.ui.notify(safetyMessage, "warning");
    }
  }

  return undefined;
}

export const __test__ = {
  sanitizeSettings,
  confirmDirtyRestoreAllowed,
  restoreCheckpoint,
  maybeRestoreCodeState,
};

export default function (pi: ExtensionAPI) {
  let settings: SessionGuardSettings = {};
  let checkpoints = new Map<string, StoredCheckpoint>();
  const warnedSettings = new Set<string>();

  const emitSettingsWarning = (ctx: ExtensionContext, warning: string) => {
    if (warnedSettings.has(warning)) return;
    warnedSettings.add(warning);
    if (ctx.hasUI) {
      ctx.ui.notify(`Session guard config: ${warning}`, "warning");
      return;
    }
    console.warn(`[session-guard] ${warning}`);
  };

  const reload = (ctx: ExtensionContext) => {
    const loaded = loadSettings(ctx.cwd);
    settings = loaded.settings;
    for (const warning of loaded.warnings) emitSettingsWarning(ctx, warning);
    checkpoints = reconstructCheckpoints(ctx.sessionManager.getEntries());
  };

  pi.on("session_start", async (_event, ctx) => reload(ctx));
  pi.on("session_tree", async (_event, ctx) => reload(ctx));

  pi.on("turn_start", async (_event, ctx) => {
    if (!shouldCaptureCheckpointsForContext(settings, ctx)) return;
    const leafId = ctx.sessionManager.getLeafEntry()?.id;
    const targetEntryIds = collectPreTurnEntryIds(
      ctx.sessionManager.getEntries(),
      leafId,
    );
    await captureCheckpoint(pi, ctx, checkpoints, targetEntryIds, "pre-turn");
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!shouldCaptureCheckpointsForContext(settings, ctx)) return;
    const leafId = ctx.sessionManager.getLeafEntry()?.id;
    const targetEntryIds = collectPostTurnEntryIds(
      ctx.sessionManager.getEntries(),
      leafId,
    );
    await captureCheckpoint(pi, ctx, checkpoints, targetEntryIds, "post-turn");
  });

  pi.on("session_before_switch", async (event, ctx) => {
    const action = event.reason === "new" ? "new session" : "switch session";
    const dirty = await checkDirtyRepo(pi, ctx, settings, action);
    if (dirty?.cancel) return { cancel: true };

    if (!ctx.hasUI) return undefined;

    if (event.reason === "new" && settings.confirmNewSession) {
      const ok = await ctx.ui.confirm(
        "Clear session?",
        "This will delete all messages in the current session.",
      );
      if (!ok) {
        ctx.ui.notify("Clear cancelled", "info");
        return { cancel: true };
      }
    }

    if (event.reason === "resume" && settings.confirmSwitchSession) {
      const entries = ctx.sessionManager.getEntries();
      const hasUnsavedWork = entries.some(
        (entry): entry is SessionMessageEntry =>
          entry.type === "message" && entry.message.role === "user",
      );
      if (hasUnsavedWork) {
        const ok = await ctx.ui.confirm(
          "Switch session?",
          "You have messages in the current session. Switch anyway?",
        );
        if (!ok) {
          ctx.ui.notify("Switch cancelled", "info");
          return { cancel: true };
        }
      }
    }

    return undefined;
  });

  pi.on("session_before_fork", async (event, ctx) => {
    const isClone = event.position === "at";
    const action = isClone ? "clone" : "fork";
    const dirty = await checkDirtyRepo(pi, ctx, settings, action);
    if (dirty?.cancel) return { cancel: true };

    if (ctx.hasUI && settings.confirmFork) {
      const confirmLabel = isClone ? "Yes, create clone" : "Yes, create fork";
      const cancelLabel = isClone ? "Clone cancelled" : "Fork cancelled";
      const promptTitle = isClone ? "Clone session?" : "Fork session?";
      const choice = await ctx.ui.select(promptTitle, [
        confirmLabel,
        "No, stay in current session",
      ]);

      if (choice !== confirmLabel) {
        ctx.ui.notify(cancelLabel, "info");
        return { cancel: true };
      }
    }

    const restoreMode = settings.restoreCodeOnFork ?? "off";
    const restore = await maybeRestoreCodeState(
      pi,
      ctx,
      checkpoints,
      ctx.sessionManager.getEntries(),
      event.entryId,
      restoreMode,
      isClone ? "Clone session" : "Fork session",
    );
    if (restore?.cancel) return { cancel: true };

    return undefined;
  });

  pi.on("session_before_tree", async (event, ctx) => {
    const dirty = await checkDirtyRepo(pi, ctx, settings, "tree navigation");
    if (dirty?.cancel) return { cancel: true };

    const restoreMode = settings.restoreCodeOnTree ?? "off";
    const restore = await maybeRestoreCodeState(
      pi,
      ctx,
      checkpoints,
      ctx.sessionManager.getEntries(),
      event.preparation.targetId,
      restoreMode,
      "Tree navigation",
    );
    if (restore?.cancel) return { cancel: true };

    return undefined;
  });
}
