import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

function formatSessionReminder(ctx: ExtensionContext, sessionId: string): string {
  const command = `pi --session ${sessionId}`;

  if (!ctx.hasUI || !process.stderr.isTTY) {
    return `Session: ${sessionId}\nResume:  ${command}`;
  }

  const { theme } = ctx.ui;
  const sessionLabel = theme.fg("muted", theme.bold("Session:"));
  const resumeLabel = theme.fg("muted", theme.bold("Resume:"));
  const sessionValue = theme.bold(sessionId);
  const resumeValue = theme.bold(command);

  return `${sessionLabel} ${sessionValue}\n${resumeLabel}  ${resumeValue}`;
}

function writeTerminalMessage(message: string): void {
  process.stderr.write(`${message}\n`);
}

export default function sessionReminder(pi: ExtensionAPI) {
  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "reload") {
      return;
    }

    const sessionId = ctx.sessionManager.getSessionId();
    const message = formatSessionReminder(ctx, sessionId);

    writeTerminalMessage(message);
  });
}
