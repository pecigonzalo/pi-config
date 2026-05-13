import { describe, expect, it } from "bun:test";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { __test__ } from "./session-reminder";

interface TestTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

function createContext(options?: { hasUI?: boolean; sessionTitle?: string }): ExtensionContext {
  const theme: TestTheme = {
    fg: (color, text) => `<${color}>${text}</${color}>`,
    bold: (text) => `*${text}*`,
  };

  return {
    hasUI: options?.hasUI ?? false,
    ui: { theme },
    sessionManager: {
      getSessionName: () => options?.sessionTitle,
    },
  } as unknown as ExtensionContext;
}

function withStderrIsTTY(isTTY: boolean, callback: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    value: isTTY,
  });

  try {
    callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(process.stderr, "isTTY", descriptor);
      return;
    }

    delete (process.stderr as NodeJS.WriteStream & { isTTY?: boolean }).isTTY;
  }
}

describe("session reminder", () => {
  it("returns the session name as the title when present", () => {
    const ctx = createContext({ sessionTitle: "Ship the exit reminder" });

    expect(__test__.getSessionTitle(ctx)).toBe("Ship the exit reminder");
  });

  it("falls back to an untitled placeholder when the title is missing", () => {
    const ctx = createContext();

    expect(__test__.getSessionTitle(ctx)).toBe("(untitled)");
  });

  it("prints the session title in plain terminal output", () => {
    const ctx = createContext({ sessionTitle: "Ship the exit reminder" });

    withStderrIsTTY(false, () => {
      expect(__test__.formatSessionReminder(ctx, "abc123", "Ship the exit reminder")).toBe(
        [
          "Session: abc123",
          "Title:   Ship the exit reminder",
          "Resume:  pi --session abc123",
        ].join("\n"),
      );
    });
  });

  it("prints the session title in styled terminal output", () => {
    const ctx = createContext({ hasUI: true, sessionTitle: "Ship the exit reminder" });

    withStderrIsTTY(true, () => {
      expect(__test__.formatSessionReminder(ctx, "abc123", "Ship the exit reminder")).toBe(
        [
          "<muted>*Session:*</muted> *abc123*",
          "<muted>*Title:  *</muted> *Ship the exit reminder*",
          "<muted>*Resume: *</muted> *pi --session abc123*",
        ].join("\n"),
      );
    });
  });
});
