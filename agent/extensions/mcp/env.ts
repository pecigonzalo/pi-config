import * as fs from "node:fs";
import * as path from "node:path";

function sanitizePathSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "session";
}

export function getMcpDaemonDir(cwd: string, sessionId: string | undefined): string {
	const sessionSegment = sanitizePathSegment(sessionId ?? "session");
	return path.join(path.resolve(cwd), ".pi", "mcporter-daemon", sessionSegment);
}

export function getMcpServerDir(cwd: string, sessionId: string | undefined, serverName: string): string {
	return path.join(getMcpDaemonDir(cwd, sessionId), sanitizePathSegment(serverName));
}

export function applyMcpEnvironment(cwd: string, sessionId?: string): void {
	const daemonDir = getMcpDaemonDir(cwd, sessionId);
	fs.mkdirSync(daemonDir, { recursive: true });
	process.env.MCPORTER_DAEMON_DIR = daemonDir;
}
