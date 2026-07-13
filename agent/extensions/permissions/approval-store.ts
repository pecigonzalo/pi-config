import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ApprovalFile } from "./shared";

export interface ApprovalStoreOperations {
	mkdirSync: typeof fs.mkdirSync;
	openSync: typeof fs.openSync;
	writeFileSync: typeof fs.writeFileSync;
	fsyncSync: typeof fs.fsyncSync;
	closeSync: typeof fs.closeSync;
	chmodSync: typeof fs.chmodSync;
	renameSync: typeof fs.renameSync;
	unlinkSync: typeof fs.unlinkSync;
}

const defaultOperations: ApprovalStoreOperations = {
	mkdirSync: fs.mkdirSync,
	openSync: fs.openSync,
	writeFileSync: fs.writeFileSync,
	fsyncSync: fs.fsyncSync,
	closeSync: fs.closeSync,
	chmodSync: fs.chmodSync,
	renameSync: fs.renameSync,
	unlinkSync: fs.unlinkSync,
};

/** Atomically replaces an approval file using a unique temporary sibling. */
export function writeApprovalFileAtomic(
	filePath: string,
	data: ApprovalFile,
	operations: ApprovalStoreOperations = defaultOperations,
): void {
	operations.mkdirSync(path.dirname(filePath), { recursive: true });
	const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = operations.openSync(temporaryPath, "wx", 0o600);
		operations.writeFileSync(fd, JSON.stringify(data, null, 2) + "\n", "utf8");
		operations.fsyncSync(fd);
		operations.closeSync(fd);
		fd = undefined;
		try {
			operations.chmodSync(temporaryPath, 0o600);
		} catch (error) {
			if (process.platform !== "win32") throw error;
		}
		operations.renameSync(temporaryPath, filePath);
	} catch (error) {
		if (fd !== undefined) {
			try { operations.closeSync(fd); } catch { /* preserve the original failure */ }
		}
		try { operations.unlinkSync(temporaryPath); } catch { /* absent or best-effort cleanup */ }
		throw error;
	}
}
