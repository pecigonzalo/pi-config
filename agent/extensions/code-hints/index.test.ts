import { describe, expect, it } from "bun:test";
import { __test__ } from "./index";
import { LSP_MANAGER_SERVICE_KEY } from "../lsp-manager/service";
import type { LspFileDiagnostics, LspManagerService } from "../lsp-manager/service";

describe("code-hints formatting", () => {
  it("formats a compact report for LSP errors", () => {
    const results: LspFileDiagnostics[] = [
      {
        file: "/repo/src/index.ts",
        status: "ok",
        diagnostics: [
          {
            file: "/repo/src/index.ts",
            line: 10,
            column: 5,
            severity: "error",
            message: "Cannot find name 'foo'.\nMore details",
            source: "ts",
            code: "2304",
          },
          {
            file: "/repo/src/index.ts",
            line: 11,
            column: 1,
            severity: "warning",
            message: "Unused variable.",
          },
        ],
      },
    ];

    const report = __test__.formatReport("/repo", results);

    expect(report?.details).toEqual({
      files: ["src/index.ts"],
      hintCount: 1,
      timedOut: [],
    });
    expect(report?.content).toContain("Code hints found 1 new LSP error after this edit loop.");
    expect(report?.content).toContain("src/index.ts:10:5 error [ts] 2304: Cannot find name 'foo'.");
    expect(report?.content).not.toContain("Unused variable");
  });

  it("suppresses diagnostic timeouts by default", () => {
    const report = __test__.formatReport("/repo", [
      {
        file: "/repo/src/index.ts",
        status: "timeout",
        diagnostics: [],
        error: "LSP did not respond",
      },
    ]);

    expect(report).toBeUndefined();
  });

  it("reports only diagnostics that are new relative to baseline", () => {
    const before: LspFileDiagnostics[] = [
      {
        file: "/repo/src/index.ts",
        status: "ok",
        diagnostics: [
          {
            file: "/repo/src/index.ts",
            line: 1,
            column: 1,
            severity: "error",
            message: "Existing error.",
          },
        ],
      },
    ];
    const after: LspFileDiagnostics[] = [
      {
        file: "/repo/src/index.ts",
        status: "ok",
        diagnostics: [
          {
            file: "/repo/src/index.ts",
            line: 1,
            column: 1,
            severity: "error",
            message: "Existing error.",
          },
          {
            file: "/repo/src/index.ts",
            line: 2,
            column: 1,
            severity: "error",
            message: "New error.",
          },
        ],
      },
    ];

    const report = __test__.formatReport("/repo", after, __test__.collectErrorFingerprints(before), { requireBaseline: true });

    expect(report?.details.hintCount).toBe(1);
    expect(report?.content).toContain("New error.");
    expect(report?.content).not.toContain("Existing error.");
  });

  it("suppresses diagnostics that were already reported", () => {
    const results: LspFileDiagnostics[] = [
      {
        file: "/repo/src/index.ts",
        status: "ok",
        diagnostics: [
          {
            file: "/repo/src/index.ts",
            line: 10,
            column: 5,
            severity: "error",
            message: "Cannot find name 'foo'.",
          },
        ],
      },
    ];
    const first = __test__.formatReport("/repo", results);

    expect(first).toBeDefined();
    expect(
      __test__.formatReport("/repo", results, new Map(), {
        excludeFingerprints: new Set(first!.fingerprints),
      }),
    ).toBeUndefined();
  });

  it("returns undefined for clean diagnostics", () => {
    expect(
      __test__.formatReport("/repo", [
        {
          file: "/repo/src/index.ts",
          status: "ok",
          diagnostics: [],
        },
      ]),
    ).toBeUndefined();
  });
});

describe("code-hints commands", () => {
  it("formats runtime status", () => {
    const status = __test__.formatStatus(
      { enabled: true, includeTimeouts: false, mode: "nudge" },
      { lspAvailable: true, touchedFiles: 2 },
    );

    expect(status).toContain("enabled: yes");
    expect(status).toContain("mode: nudge");
    expect(status).toContain("LSP service: connected");
    expect(status).toContain("timeout details: hidden");
    expect(status).toContain("touched files in current loop: 2");
  });

  it("toggles enabled state and resets on disable", () => {
    const options = __test__.defaultOptions();
    let resetCount = 0;
    const status = () => __test__.formatStatus(options, { lspAvailable: false, touchedFiles: 0 });

    const off = __test__.applyCommand("off", options, () => resetCount++, status);
    expect(off.changed).toBe(true);
    expect(options.enabled).toBe(false);
    expect(resetCount).toBe(1);
    expect(off.status).toContain("enabled: no");

    const on = __test__.applyCommand("on", options, () => resetCount++, status);
    expect(on.changed).toBe(true);
    expect(options.enabled).toBe(true);
    expect(resetCount).toBe(1);
  });

  it("toggles timeout debug output", () => {
    const options = __test__.defaultOptions();
    const status = () => __test__.formatStatus(options, { lspAvailable: false, touchedFiles: 0 });

    __test__.applyCommand("debug on", options, () => undefined, status);
    expect(options.includeTimeouts).toBe(true);
    __test__.applyCommand("debug off", options, () => undefined, status);
    expect(options.includeTimeouts).toBe(false);
  });

  it("sets remediation mode with mode command and shorthand", () => {
    const options = __test__.defaultOptions();
    const status = () => __test__.formatStatus(options, { lspAvailable: false, touchedFiles: 0 });

    const report = __test__.applyCommand("mode report", options, () => undefined, status);
    expect(report.changed).toBe(true);
    expect(options.mode).toBe("report");
    expect(report.status).toContain("mode: report");

    const auto = __test__.applyCommand("auto", options, () => undefined, status);
    expect(auto.changed).toBe(true);
    expect(options.mode).toBe("auto");
  });
});

describe("code-hints turn flushing", () => {
  it("flushes dirty files at the first turn boundary", () => {
    expect(
      __test__.shouldFlushAtTurn({
        touchedFiles: 1,
        flushInFlight: false,
        firstDirtyAt: 1_000,
      }, 2_000),
    ).toBe(true);
  });

  it("rate-limits later turn-boundary flushes", () => {
    expect(
      __test__.shouldFlushAtTurn({
        touchedFiles: 1,
        flushInFlight: false,
        firstDirtyAt: 11_000,
        lastFlushAt: 10_000,
      }, 15_000),
    ).toBe(false);
    expect(
      __test__.shouldFlushAtTurn({
        touchedFiles: 1,
        flushInFlight: false,
        firstDirtyAt: 11_000,
        lastFlushAt: 10_000,
      }, 20_000),
    ).toBe(true);
  });

  it("flushes old dirty state even inside the rate limit", () => {
    expect(
      __test__.shouldFlushAtTurn({
        touchedFiles: 1,
        flushInFlight: false,
        firstDirtyAt: 1_000,
        lastFlushAt: 25_000,
      }, 31_000),
    ).toBe(true);
  });

  it("does not start another flush while one is running", () => {
    expect(
      __test__.shouldFlushAtTurn({
        touchedFiles: 1,
        flushInFlight: true,
        firstDirtyAt: 1_000,
      }, 31_000),
    ).toBe(false);
  });
});

describe("code-hints remediation prompts", () => {
  it("formats next-turn nudges and focused fix prompts", () => {
    const report = __test__.formatReport("/repo", [
      {
        file: "/repo/src/index.ts",
        status: "ok",
        diagnostics: [
          {
            file: "/repo/src/index.ts",
            line: 10,
            column: 5,
            severity: "error",
            message: "Cannot find name 'foo'.",
          },
        ],
      },
    ]);

    expect(report).toBeDefined();
    expect(__test__.formatNudgePrompt(report!)).toContain("Before continuing, address these if they are relevant");
    expect(__test__.formatFixPrompt(report!)).toContain("Run a focused follow-up fix");
  });

  it("keeps only actionable code-hints messages in model context", () => {
    expect(
      __test__.shouldKeepInModelContext({
        role: "custom",
        customType: "code-hints",
        details: { audience: "report" },
      }),
    ).toBe(false);
    expect(
      __test__.shouldKeepInModelContext({
        role: "custom",
        customType: "code-hints",
        details: { audience: "nudge" },
      }),
    ).toBe(true);
    expect(__test__.shouldKeepInModelContext({ role: "user" })).toBe(true);
  });
});

describe("code-hints service discovery", () => {
  it("finds an lsp-manager service from the event registry", () => {
    const service = {
      diagnostics: async () => [],
      status: () => [],
    } as unknown as LspManagerService;
    const pi = {
      events: {
        [LSP_MANAGER_SERVICE_KEY]: service,
      },
    } as never;

    expect(__test__.getLspService(pi)).toBe(service);
  });

  it("detects aborted or error agent endings", () => {
    expect(
      __test__.shouldSkipAgentEnd({
        messages: [{ role: "assistant", stopReason: "aborted" }],
      }),
    ).toBe(true);
    expect(
      __test__.shouldSkipAgentEnd({
        messages: [{ role: "assistant", stopReason: "stop" }],
      }),
    ).toBe(false);
  });
});
