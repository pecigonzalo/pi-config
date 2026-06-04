import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const LABEL_WIDTH = "Session:".length;
const UNTITLED_SESSION = "(untitled)";

function formatReminderLine(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)} ${value}`;
}

function formatStyledReminderLine(
  ctx: ExtensionContext,
  label: string,
  value: string,
): string {
  const styledLabel = ctx.ui.theme.fg(
    "muted",
    ctx.ui.theme.bold(label.padEnd(LABEL_WIDTH)),
  );
  const styledValue = ctx.ui.theme.bold(value);

  return `${styledLabel} ${styledValue}`;
}

function getSessionTitle(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionName()?.trim() || UNTITLED_SESSION;
}

function formatSessionReminder(ctx: ExtensionContext, sessionId: string, sessionTitle: string): string {
  const command = `pi --session-id ${sessionId}`;

  if (!ctx.hasUI || !process.stderr.isTTY) {
    return [
      formatReminderLine("Session:", sessionId),
      formatReminderLine("Title:", sessionTitle),
      formatReminderLine("Resume:", command),
    ].join("\n");
  }

  return [
    formatStyledReminderLine(ctx, "Session:", sessionId),
    formatStyledReminderLine(ctx, "Title:", sessionTitle),
    formatStyledReminderLine(ctx, "Resume:", command),
  ].join("\n");
}

function writeTerminalMessage(message: string): void {
  process.stderr.write(`${message}\n`);
}

function shouldWriteSessionReminder(reason: string): boolean {
  return reason === "quit";
}

export const __test__ = {
  formatSessionReminder,
  getSessionTitle,
  shouldWriteSessionReminder,
};

export default function sessionReminder(pi: ExtensionAPI) {
  pi.on("session_shutdown", async (event, ctx) => {
    if (!shouldWriteSessionReminder(event.reason)) {
      return;
    }

    const sessionId = ctx.sessionManager.getSessionId();
    const sessionTitle = getSessionTitle(ctx);
    const message = formatSessionReminder(ctx, sessionId, sessionTitle);

    writeTerminalMessage(message);
  });
}
