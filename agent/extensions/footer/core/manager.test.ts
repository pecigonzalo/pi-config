import { describe, expect, it } from "bun:test";
import { __test__ } from "./manager";

const showAllStatuses = {
  keep: [],
  hide: [],
};

describe("footer extension statuses", () => {
  it("formats statuses sorted by key", () => {
    const statuses = new Map([
      ["tasks", "tasks: running"],
      ["code-hints", "hints: 2 touched"],
    ]);

    expect(__test__.formatExtensionStatuses(statuses, showAllStatuses)).toBe(
      "hints: 2 touched tasks: running",
    );
  });

  it("sanitizes multi-line status text", () => {
    expect(__test__.sanitizeStatusText("LSP:\n  idle\tready")).toBe("LSP: idle ready");
  });

  it("omits empty statuses", () => {
    expect(
      __test__.formatExtensionStatuses(new Map([["empty", "  "]]), showAllStatuses),
    ).toBeNull();
  });

  it("hides exact status keys", () => {
    const statuses = new Map([
      ["langfuse", "Langfuse ready"],
      ["permissions", "Waiting for approval"],
    ]);

    expect(
      __test__.formatExtensionStatuses(statuses, { keep: [], hide: ["langfuse"] }),
    ).toBe("Waiting for approval");
  });

  it("hides wildcard status key matches", () => {
    const statuses = new Map([
      ["tasks.rpc.run-1.status.lsp-manager", "[Task reviewer step 1] LSP: idle"],
      ["lsp-manager", "LSP: idle"],
    ]);

    expect(
      __test__.formatExtensionStatuses(statuses, { keep: [], hide: ["tasks.rpc.*"] }),
    ).toBe("LSP: idle");
  });

  it("uses keep patterns when present", () => {
    const statuses = new Map([
      ["langfuse", "Langfuse ready"],
      ["permissions", "Waiting for approval"],
      ["tasks.rpc.run-1.status.permissions", "[Task reviewer step 1] Waiting"],
    ]);

    expect(
      __test__.formatExtensionStatuses(statuses, {
        keep: ["permissions", "tasks.rpc.*.status.permissions"],
        hide: [],
      }),
    ).toBe("Waiting for approval [Task reviewer step 1] Waiting");
  });

  it("lets hide patterns win over keep patterns", () => {
    expect(
      __test__.shouldRenderStatus("langfuse", {
        keep: ["*"],
        hide: ["langfuse"],
      }),
    ).toBe(false);
  });
});
