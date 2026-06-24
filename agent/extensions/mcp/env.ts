import * as path from "node:path";

export function getMcpDaemonDir(cwd: string): string {
	return path.join(path.resolve(cwd), ".pi", "mcporter-daemon");
}

export function applyMcpEnvironment(cwd: string): void {
	process.env.MCPORTER_DAEMON_DIR = getMcpDaemonDir(cwd);
}
