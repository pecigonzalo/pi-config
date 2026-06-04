import { describe, expect, it } from "bun:test";
import { __test__ } from "./index";

describe("debug prompt arguments", () => {
  it("shows namespaced help by default", () => {
    expect(__test__.parsePromptArgs("")).toEqual({
      mode: "current",
      raw: false,
      includeTools: true,
      help: true,
    });
  });

  it("accepts debug prompt last raw syntax", () => {
    expect(__test__.parsePromptArgs("prompt last raw")).toEqual({
      mode: "last",
      raw: true,
      includeTools: true,
      help: false,
    });
  });

  it("accepts prompt options without the prompt subcommand", () => {
    expect(__test__.parsePromptArgs("last raw")).toEqual({
      mode: "last",
      raw: true,
      includeTools: true,
      help: false,
    });
  });

  it("can hide tool schemas", () => {
    expect(__test__.parsePromptArgs("current no-tools")).toEqual({
      mode: "current",
      raw: false,
      includeTools: false,
      help: false,
    });
  });

  it("shows help for unknown arguments", () => {
    expect(__test__.parsePromptArgs("prompt future").help).toBe(true);
  });
});

describe("debug prompt tool formatting", () => {
  it("formats tool schemas with source metadata", () => {
    const lines = __test__.buildToolLines([
      {
        name: "read",
        description: "Read file contents",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        promptGuidelines: ["Use read when inspecting a known file path."],
        sourceInfo: {
          path: "<builtin:read>",
          source: "builtin",
          scope: "temporary",
          origin: "top-level",
        },
      },
    ]);

    expect(lines.join("\n")).toContain("Tool definitions (1 tools)");
    expect(lines.join("\n")).toContain("name: read");
    expect(lines.join("\n")).toContain("source: built-in");
    expect(lines.join("\n")).toContain("promptGuidelines:");
    expect(lines.join("\n")).toContain("- Use read when inspecting a known file path.");
    expect(lines.join("\n")).toContain('"path"');
  });
});

describe("debug prompt document formatting", () => {
  it("returns the unmodified prompt in raw prompt-only mode", () => {
    const prompt = "system prompt\nwith tools";

    const result = __test__.formatPromptDocument(
      {
        label: "current",
        prompt,
        capturedAt: 0,
        source: "test",
      },
      { mode: "current", raw: true, includeTools: false, help: false },
      [],
    );

    expect(result.body).toBe(prompt);
  });

  it("adds metadata and tool definitions in formatted mode", () => {
    const result = __test__.formatPromptDocument(
      {
        label: "last",
        prompt: "system prompt",
        capturedAt: 0,
        source: "test source",
      },
      { mode: "last", raw: false, includeTools: true, help: false },
      [],
    );

    expect(result.body).toContain("Pi system prompt (last)");
    expect(result.body).toContain("Captured: 1970-01-01T00:00:00.000Z");
    expect(result.body).toContain("Source: test source");
    expect(result.body).toContain("Length: 13 characters, 1 lines");
    expect(result.body).toContain("Tool definitions");
  });

  it("classifies common line styles", () => {
    expect(__test__.lineStyle("Pi system prompt (current)")).toBe("heading");
    expect(__test__.lineStyle("Tool definitions (2 tools)")).toBe("tools");
    expect(__test__.lineStyle("- Read files")).toBe("bullet");
    expect(__test__.lineStyle("  parameters:")).toBe("toolLine");
  });
});
