import { describe, expect, it } from "bun:test";
import { __test__ } from "./manager";

describe("footer extension statuses", () => {
  it("formats statuses sorted by key", () => {
    const statuses = new Map([
      ["tasks", "tasks: running"],
      ["code-hints", "hints: 2 touched"],
    ]);

    expect(__test__.formatExtensionStatuses(statuses)).toBe("hints: 2 touched tasks: running");
  });

  it("sanitizes multi-line status text", () => {
    expect(__test__.sanitizeStatusText("LSP:\n  idle\tready")).toBe("LSP: idle ready");
  });

  it("omits empty statuses", () => {
    expect(__test__.formatExtensionStatuses(new Map([["empty", "  "]]))).toBeNull();
  });
});
