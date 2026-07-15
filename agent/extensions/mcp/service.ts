import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	createCallResult,
	createRuntime,
	loadServerDefinitions,
	type Runtime,
	type ServerDefinition,
	type ServerToolInfo,
} from "mcporter";
import { applyMcpEnvironment, applyMcpServerEnvironment } from "./env";

const DEFAULT_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 5_000;
const MAX_STATUS_OUTPUT_CHARS = 8_000;

export interface McpServiceOptions {
	cwd: string;
	configPath?: string;
	sessionId?: string;
}

export interface McpServerSummary {
	name: string;
	description?: string;
	transport: "http" | "stdio";
	url?: string;
	command?: string;
	lifecycle?: "keep-alive" | "ephemeral";
	sources: Array<{
		kind: "local" | "import";
		path: string;
		importKind?: string;
	}>;
}

export interface McpCallInput {
	server: string;
	tool: string;
	args?: Record<string, unknown>;
	timeoutMs?: number;
	disableOAuth?: boolean;
}

export interface McpListToolsInput {
	server: string;
	includeSchema?: boolean;
	disableOAuth?: boolean;
}

export interface McpListResourcesInput {
	server: string;
	disableOAuth?: boolean;
}

export interface McpReadResourceInput {
	server: string;
	uri: string;
	disableOAuth?: boolean;
}

export interface McpNormalizedCallResult {
	raw: unknown;
	text: string | null;
	markdown: string | null;
	json: unknown;
	images: unknown[] | null;
	content: unknown[] | null;
	structuredContent: unknown;
}

export interface McpStatus {
	ok: boolean;
	configPath: string;
	serverCount: number;
	servers: McpServerSummary[];
	daemon: {
		checked: boolean;
		exitCode: number | null;
		output: string;
		error?: string;
	};
}

function clampTimeoutMs(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
	return Math.max(1_000, Math.min(300_000, value));
}

function expandHome(value: string): string {
	if (value === "~") return process.env.HOME || value;
	if (value.startsWith("~/")) return path.join(process.env.HOME || "", value.slice(2));
	return value;
}

function resolveConfigPath(configPath: string | undefined): string {
	const configured =
		configPath ?? process.env.PI_MCP_CONFIG ?? process.env.MCPORTER_CONFIG ?? path.join(getAgentDir(), "mcp.json");
	return path.resolve(expandHome(configured));
}

function summarizeServer(definition: ServerDefinition): McpServerSummary {
	const lifecycle = definition.lifecycle?.mode;
	const sources = (definition.sources ?? (definition.source ? [definition.source] : [])).map((source) => ({
		kind: source.kind,
		path: source.path,
		importKind: source.importKind,
	}));
	if (definition.command.kind === "http") {
		return {
			name: definition.name,
			description: definition.description,
			transport: "http",
			url: definition.command.url.toString(),
			lifecycle,
			sources,
		};
	}

	return {
		name: definition.name,
		description: definition.description,
		transport: "stdio",
		command: [definition.command.command, ...definition.command.args].join(" "),
		lifecycle,
		sources,
	};
}

function safeCallResult<T>(fn: () => T): T | null {
	try {
		return fn();
	} catch {
		return null;
	}
}

function normalizeCallResult(raw: unknown): McpNormalizedCallResult {
	const result = createCallResult(raw);
	return {
		raw,
		text: safeCallResult(() => result.text()),
		markdown: safeCallResult(() => result.markdown()),
		json: safeCallResult(() => result.json()),
		images: safeCallResult(() => result.images()),
		content: safeCallResult(() => result.content()),
		structuredContent: safeCallResult(() => result.structuredContent()),
	};
}

async function getMcporterCommand(): Promise<{ command: string; argsPrefix: string[] }> {
	const extensionDir = path.dirname(fileURLToPath(import.meta.url));
	const localBin = path.join(
		extensionDir,
		"node_modules",
		".bin",
		process.platform === "win32" ? "mcporter.cmd" : "mcporter",
	);
	try {
		await fs.access(localBin);
		return { command: localBin, argsPrefix: [] };
	} catch {
		return { command: "bunx", argsPrefix: ["mcporter"] };
	}
}

async function runMcporterCli(
	args: string[],
	options: { cwd: string; timeoutMs?: number },
): Promise<{ exitCode: number | null; output: string; error?: string }> {
	const invocation = await getMcporterCommand();
	const timeoutMs = clampTimeoutMs(options.timeoutMs ?? STATUS_TIMEOUT_MS);
	return await new Promise((resolve) => {
		const child = spawn(invocation.command, [...invocation.argsPrefix, ...args], {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		let output = "";
		let settled = false;
		const append = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.length > MAX_STATUS_OUTPUT_CHARS) output = output.slice(0, MAX_STATUS_OUTPUT_CHARS);
		};
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGTERM");
			resolve({ exitCode: null, output, error: `timeout after ${timeoutMs}ms` });
		}, timeoutMs);
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ exitCode: null, output, error: error instanceof Error ? error.message : String(error) });
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ exitCode: code, output: output.trim() });
		});
	});
}

export class McpService {
	private runtime: Runtime | undefined;
	readonly configPath: string;

	constructor(readonly options: McpServiceOptions) {
		this.configPath = resolveConfigPath(options.configPath);
		applyMcpEnvironment(options.cwd, options.sessionId);
	}

	private async getRuntime(): Promise<Runtime> {
		applyMcpEnvironment(this.options.cwd, this.options.sessionId);
		if (!this.runtime) {
			this.runtime = await createRuntime({
				rootDir: this.options.cwd,
				configPath: this.configPath,
			});
		}
		return this.runtime;
	}

	private async prepareServerEnvironment(serverName: string): Promise<void> {
		applyMcpServerEnvironment(this.options.cwd, this.options.sessionId, serverName);
		const definitions = await loadServerDefinitions({ rootDir: this.options.cwd, configPath: this.configPath });
		const definition = definitions.find((candidate) => candidate.name === serverName);
		if (definition?.command.kind === "stdio") {
			await fs.mkdir(definition.command.cwd, { recursive: true });
		}
	}

	async close(): Promise<void> {
		const runtime = this.runtime;
		this.runtime = undefined;
		await runtime?.close();
	}

	async servers(): Promise<McpServerSummary[]> {
		applyMcpEnvironment(this.options.cwd, this.options.sessionId);
		const definitions = await loadServerDefinitions({ rootDir: this.options.cwd, configPath: this.configPath });
		return definitions.map(summarizeServer);
	}

	async listTools(input: McpListToolsInput): Promise<ServerToolInfo[]> {
		await this.prepareServerEnvironment(input.server);
		const runtime = await this.getRuntime();
		return await runtime.listTools(input.server, {
			includeSchema: input.includeSchema ?? false,
			disableOAuth: input.disableOAuth ?? true,
		});
	}

	async call(input: McpCallInput): Promise<McpNormalizedCallResult> {
		await this.prepareServerEnvironment(input.server);
		const runtime = await this.getRuntime();
		const raw = await runtime.callTool(input.server, input.tool, {
			args: input.args ?? {},
			timeoutMs: clampTimeoutMs(input.timeoutMs),
			disableOAuth: input.disableOAuth ?? true,
		});
		return normalizeCallResult(raw);
	}

	async listResources(input: McpListResourcesInput): Promise<unknown> {
		await this.prepareServerEnvironment(input.server);
		const runtime = await this.getRuntime();
		return await runtime.listResources(input.server, { disableOAuth: input.disableOAuth ?? true });
	}

	async readResource(input: McpReadResourceInput): Promise<unknown> {
		await this.prepareServerEnvironment(input.server);
		const runtime = await this.getRuntime();
		return await runtime.readResource(input.server, input.uri, { disableOAuth: input.disableOAuth ?? true });
	}

	async status(): Promise<McpStatus> {
		applyMcpEnvironment(this.options.cwd, this.options.sessionId);
		const servers = await this.servers();
		const daemon = await runMcporterCli(["daemon", "status"], {
			cwd: this.options.cwd,
			timeoutMs: STATUS_TIMEOUT_MS,
		});
		return {
			ok: !daemon.error,
			configPath: this.configPath,
			serverCount: servers.length,
			servers,
			daemon: {
				checked: true,
				exitCode: daemon.exitCode,
				output: daemon.output,
				error: daemon.error,
			},
		};
	}
}

export function createMcpService(options: McpServiceOptions): McpService {
	return new McpService(options);
}
