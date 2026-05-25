import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { __test__ } from "./index";

type ExecResult = { code: number; stdout?: string; stderr?: string };

describe("session-guard safety hardening", () => {
  it("falls back invalid enum settings to safe values with warnings", () => {
    const { settings, warnings } = __test__.sanitizeSettings({
      dirtyRepo: "nope",
      restoreCodeOnFork: "sure",
      restoreCodeOnTree: 123,
    });

    expect(settings.dirtyRepo).toBe("off");
    expect(settings.restoreCodeOnFork).toBe("ask");
    expect(settings.restoreCodeOnTree).toBe("ask");
    expect(warnings).toEqual([
      'Invalid sessionGuard.dirtyRepo value ("nope"); using "off".',
      'Invalid sessionGuard.restoreCodeOnFork value ("sure"); using "ask".',
      "Invalid sessionGuard.restoreCodeOnTree value (123); using \"ask\".",
    ]);
  });

  it("validates checkpoint refs before any destructive git mutation", async () => {
    const calls: string[] = [];
    const pi = {
      exec: async (_command: string, args: string[]): Promise<ExecResult> => {
        const joined = args.join(" ");
        calls.push(joined);

        if (joined === "rev-parse --show-toplevel") {
          return { code: 0, stdout: "/repo\n" };
        }
        if (joined === "rev-parse --verify --quiet missing-ref^{tree}") {
          return { code: 1, stdout: "", stderr: "" };
        }

        throw new Error(`Unexpected command: ${joined}`);
      },
    };

    const result = await __test__.restoreCheckpoint(pi as never, "/cwd", {
      entryIds: ["entry-1"],
      ref: "missing-ref",
      kind: "commit" as const,
      capture: "pre-turn" as const,
      completeness: "full" as const,
      createdAt: Date.now(),
    });

    expect(result.error).toContain("missing or invalid");
    expect(calls).toEqual([
      "rev-parse --show-toplevel",
      "rev-parse --verify --quiet missing-ref^{tree}",
    ]);
  });

  it("creates a safety stash before reset/clean", async () => {
    const calls: string[] = [];
    const pi = {
      exec: async (_command: string, args: string[]): Promise<ExecResult> => {
        const joined = args.join(" ");
        calls.push(joined);

        if (joined === "rev-parse --show-toplevel") {
          return { code: 0, stdout: "/repo\n" };
        }
        if (joined === "rev-parse --verify --quiet abc123^{tree}") {
          return { code: 0, stdout: "treehash\n" };
        }
        if (joined === "status --porcelain --untracked-files=all") {
          return { code: 0, stdout: " M tracked.ts\n?? local.txt\n" };
        }
        if (args[0] === "stash" && args[1] === "push") {
          return { code: 0, stdout: "Saved working directory and index state\n" };
        }
        if (joined === "rev-parse --verify --quiet stash@{0}") {
          return { code: 0, stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n" };
        }
        if (joined === "reset --hard HEAD") {
          return { code: 0, stdout: "HEAD is now at abc123\n" };
        }
        if (joined === "clean -fd") {
          return { code: 0, stdout: "Removing local.txt\n" };
        }
        if (args[0] === "restore") {
          return { code: 0, stdout: "" };
        }

        throw new Error(`Unexpected command: ${joined}`);
      },
    };

    const result = await __test__.restoreCheckpoint(pi as never, "/cwd", {
      entryIds: ["entry-1"],
      ref: "abc123",
      kind: "commit" as const,
      capture: "post-turn" as const,
      completeness: "full" as const,
      createdAt: Date.now(),
    });

    expect(result.error).toBeUndefined();
    expect(result.safetySnapshotCreated).toBe(true);
    expect(result.safetySnapshotRef).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");

    const stashIndex = calls.findIndex((value) =>
      value.startsWith("stash push --include-untracked --message"),
    );
    const resetIndex = calls.indexOf("reset --hard HEAD");
    const cleanIndex = calls.indexOf("clean -fd");
    expect(stashIndex).toBeGreaterThan(-1);
    expect(resetIndex).toBeGreaterThan(stashIndex);
    expect(cleanIndex).toBeGreaterThan(resetIndex);
  });

  it("fails safe for auto-restore in no-UI mode when working tree is dirty", async () => {
    const calls: string[] = [];
    const pi = {
      exec: async (_command: string, args: string[]): Promise<ExecResult> => {
        const joined = args.join(" ");
        calls.push(joined);

        if (joined === "rev-parse --show-toplevel") {
          return { code: 0, stdout: "/repo\n" };
        }
        if (joined === "status --porcelain --untracked-files=all") {
          return { code: 0, stdout: " M local.ts\n" };
        }

        throw new Error(`Unexpected command: ${joined}`);
      },
    };

    const checkpoint = {
      entryIds: ["entry-1"],
      ref: "abc123",
      kind: "commit" as const,
      capture: "pre-turn" as const,
      completeness: "full" as const,
      createdAt: Date.now(),
    };

    const warnMessages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const result = await __test__.maybeRestoreCodeState(
        pi as never,
        { cwd: "/cwd", hasUI: false } as never,
        new Map([["entry-1", checkpoint]]),
        [{ id: "entry-1", type: "message" }] as SessionEntry[],
        "entry-1",
        "auto",
        "Fork session",
      );

      expect(result).toEqual({ cancel: true });
      expect(calls).toEqual([
        "rev-parse --show-toplevel",
        "status --porcelain --untracked-files=all",
      ]);
      expect(warnMessages.length).toBe(1);
    } finally {
      console.warn = originalWarn;
    }
  });
});
