import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ValidatedSessionReference {
	path: string;
	id: string;
}

interface SessionHeader {
	id: string;
	parentSession?: string;
}

let testSessionRoot: string | undefined;

function readHeader(filePath: string): SessionHeader {
	const firstLine = fs
		.readFileSync(filePath, "utf8")
		.split(/\r?\n/)
		.find((line) => line.trim());
	if (!firstLine) throw new Error(`Session file ${filePath} has no JSONL header.`);
	let value: unknown;
	try {
		value = JSON.parse(firstLine);
	} catch {
		throw new Error(`Session file ${filePath} has malformed JSONL header.`);
	}
	if (!value || typeof value !== "object") throw new Error(`Session file ${filePath} has an invalid header.`);
	const header = value as { type?: unknown; id?: unknown; parentSession?: unknown };
	if (header.type !== "session" || typeof header.id !== "string" || !header.id.trim()) {
		throw new Error(`Session file ${filePath} has an invalid session header type or id.`);
	}
	if (header.parentSession !== undefined && typeof header.parentSession !== "string") {
		throw new Error(`Session file ${filePath} has a malformed parentSession header.`);
	}
	return { id: header.id, parentSession: header.parentSession?.trim() || undefined };
}

function canonicalRoot(): string {
	const root = testSessionRoot ?? path.join(getAgentDir(), "sessions");
	const canonical = fs.realpathSync(root);
	if (!fs.statSync(canonical).isDirectory()) throw new Error(`Session root is not a directory: ${root}`);
	return canonical;
}

/** Override the session root for isolated validation tests. */
export function setTaskSessionRootForTests(root: string | undefined): void {
	testSessionRoot = root === undefined ? undefined : fs.realpathSync(root);
}

function validatePath(candidate: string, root: string): string {
	const canonical = fs.realpathSync(candidate);
	const relative = path.relative(root, canonical);
	if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Session reference is outside the Pi session root: ${candidate}`);
	}
	if (!fs.statSync(canonical).isFile()) throw new Error(`Session reference is not a regular file: ${candidate}`);
	if (!canonical.endsWith(".jsonl")) throw new Error(`Session reference is not a JSONL file: ${candidate}`);
	return canonical;
}

function resolveReference(reference: string, baseFile: string): string {
	return path.resolve(path.isAbsolute(reference) ? reference : path.dirname(baseFile), reference);
}

function validate(
	candidate: string,
	expectedId: string | undefined,
	root: string,
	visited: Set<string>,
): ValidatedSessionReference {
	const canonical = validatePath(candidate, root);
	if (visited.has(canonical)) throw new Error(`Session parent reference cycle detected at ${canonical}.`);
	const header = readHeader(canonical);
	if (expectedId !== undefined && header.id !== expectedId) {
		throw new Error(`Session header id mismatch for ${canonical}: expected ${expectedId}, found ${header.id}.`);
	}
	if (header.parentSession) {
		const nextVisited = new Set(visited);
		nextVisited.add(canonical);
		const parent = validate(resolveReference(header.parentSession, canonical), undefined, root, nextVisited);
		if (parent.path === canonical) throw new Error(`Session ${canonical} references itself as its parent.`);
	}
	return { path: canonical, id: header.id };
}

/** Validate an untrusted session metadata reference before it is read or opened. */
export function validateTaskSessionReference(
	candidate: string,
	expectedId?: string,
): { reference?: ValidatedSessionReference; error?: string } {
	try {
		return { reference: validate(candidate, expectedId, canonicalRoot(), new Set()) };
	} catch (error: unknown) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
