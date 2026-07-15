import { describe, expect, it } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { MessageConnection } from "vscode-languageserver-protocol/node.js";
import { __test__ as serviceTest, DefaultLspManagerService } from "./service";

type LifecycleClient = Parameters<typeof serviceTest.registerClientLifecycle>[0];

class FakeProcess extends EventEmitter {
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly signals: Array<NodeJS.Signals | number> = [];

	constructor(private readonly exitSignals = new Set<NodeJS.Signals>()) {
		super();
	}

	kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
		this.signals.push(signal);
		if (typeof signal === "string" && this.exitSignals.has(signal)) {
			queueMicrotask(() => this.finishWithSignal(signal));
		}
		return true;
	}

	finishWithSignal(signal: NodeJS.Signals): void {
		this.signalCode = signal;
		this.emit("exit", null, signal);
		this.emit("close", null, signal);
	}

	finishWithExitCode(exitCode: number): void {
		this.exitCode = exitCode;
		this.emit("exit", exitCode, null);
		this.emit("close", exitCode, null);
	}
}

interface FakeConnection {
	readonly connection: MessageConnection;
	readonly notifications: string[];
	readonly shutdownRequests: { count: number };
	readonly endCalls: { count: number };
	close(): void;
}

function createFakeConnection(): FakeConnection {
	let closeListener: (() => void) | undefined;
	const notifications: string[] = [];
	const shutdownRequests = { count: 0 };
	const endCalls = { count: 0 };
	const connection = {
		onClose(listener: () => void) {
			closeListener = listener;
			return { dispose: () => undefined };
		},
		sendRequest(method: unknown) {
			if (method === "shutdown") shutdownRequests.count += 1;
			return Promise.resolve(null);
		},
		sendNotification(method: unknown) {
			notifications.push(String(method));
			return Promise.resolve();
		},
		end() {
			endCalls.count += 1;
			closeListener?.();
		},
	} as unknown as MessageConnection;
	return {
		connection,
		notifications,
		shutdownRequests,
		endCalls,
		close: () => closeListener?.(),
	};
}

function createClient(process: FakeProcess, connection: FakeConnection): LifecycleClient {
	return {
		id: "typescript",
		root: "/repo",
		command: "typescript-language-server",
		process: process as unknown as ChildProcessWithoutNullStreams,
		connection: connection.connection,
		diagnostics: new Map(),
		listeners: new Map(),
		openFiles: new Map(),
		closed: false,
	};
}

function registerLifecycle(client: LifecycleClient) {
	const clients = new Map([[`${client.id}:${client.root}`, client]]);
	const pendingClients = new Set([client]);
	const ownedClients = new Set([client]);
	serviceTest.registerClientLifecycle(client, clients, pendingClients, ownedClients);
	return { clients, pendingClients, ownedClients };
}

function nextTurn(): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
}

describe("lsp-manager process lifecycle", () => {
	it("escalates termination once and removes exit wait resources", async () => {
		const process = new FakeProcess(new Set(["SIGKILL"]));
		const child = process as unknown as ChildProcessWithoutNullStreams;

		const firstTermination = serviceTest.terminateProcess(child, 5);
		const repeatedTermination = serviceTest.terminateProcess(child, 5);

		expect(repeatedTermination).toBe(firstTermination);
		await firstTermination;
		expect(process.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(process.signalCode).toBe("SIGKILL");
		expect(process.listenerCount("exit")).toBe(0);
	});

	it("keeps ownership after connection closure until process exit", async () => {
		const process = new FakeProcess();
		const connection = createFakeConnection();
		const client = createClient(process, connection);
		const lifecycle = registerLifecycle(client);
		const waiterResults: boolean[] = [];
		client.listeners.set("/repo/index.ts", new Set([(received) => waiterResults.push(received)]));
		client.diagnostics.set("/repo/index.ts", []);
		client.openFiles.set("/repo/index.ts", { version: 1, lastUsedAt: 0 });

		connection.close();
		await Promise.resolve();

		expect(client.closed).toBe(true);
		expect(waiterResults).toEqual([false]);
		expect(lifecycle.clients.size).toBe(0);
		expect(lifecycle.pendingClients.size).toBe(0);
		expect(client.diagnostics.size).toBe(0);
		expect(client.openFiles.size).toBe(0);
		expect(lifecycle.ownedClients.has(client)).toBe(true);
		expect(process.signals).toEqual(["SIGTERM"]);

		process.finishWithSignal("SIGTERM");
		expect(lifecycle.ownedClients.has(client)).toBe(false);
	});

	it("cleans stale client state after an unexpected process exit", () => {
		const process = new FakeProcess();
		const connection = createFakeConnection();
		const client = createClient(process, connection);
		const lifecycle = registerLifecycle(client);
		const waiterResults: boolean[] = [];
		client.listeners.set("/repo/index.ts", new Set([(received) => waiterResults.push(received)]));

		process.finishWithExitCode(1);

		expect(client.closed).toBe(true);
		expect(waiterResults).toEqual([false]);
		expect(lifecycle.clients.size).toBe(0);
		expect(lifecycle.pendingClients.size).toBe(0);
		expect(lifecycle.ownedClients.size).toBe(0);
		expect(process.signals).toEqual([]);
	});

	it("awaits an initializing client process during shutdown", async () => {
		const process = new FakeProcess();
		const connection = createFakeConnection();
		const client = createClient(process, connection);
		const service = new DefaultLspManagerService("/repo");
		const internals = service as unknown as {
			clients: Map<string, LifecycleClient>;
			pendingClients: Set<LifecycleClient>;
			ownedClients: Set<LifecycleClient>;
		};
		internals.pendingClients.add(client);
		internals.ownedClients.add(client);
		serviceTest.registerClientLifecycle(
			client,
			internals.clients,
			internals.pendingClients,
			internals.ownedClients,
		);

		let shutdownFinished = false;
		const shutdown = service.shutdown().then(() => {
			shutdownFinished = true;
		});
		await nextTurn();

		expect(process.signals).toEqual(["SIGTERM"]);
		expect(shutdownFinished).toBe(false);
		expect(internals.ownedClients.has(client)).toBe(true);

		process.finishWithSignal("SIGTERM");
		await shutdown;
		expect(shutdownFinished).toBe(true);
		expect(internals.ownedClients.size).toBe(0);
	});

	it("returns one shutdown operation for repeated calls", async () => {
		const process = new FakeProcess(new Set(["SIGTERM"]));
		const connection = createFakeConnection();
		const client = createClient(process, connection);
		const service = new DefaultLspManagerService("/repo");
		const internals = service as unknown as {
			clients: Map<string, LifecycleClient>;
			pendingClients: Set<LifecycleClient>;
			ownedClients: Set<LifecycleClient>;
		};
		internals.clients.set(`${client.id}:${client.root}`, client);
		internals.ownedClients.add(client);
		serviceTest.registerClientLifecycle(
			client,
			internals.clients,
			internals.pendingClients,
			internals.ownedClients,
		);

		const firstShutdown = service.shutdown();
		const repeatedShutdown = service.shutdown();

		expect(repeatedShutdown).toBe(firstShutdown);
		await firstShutdown;
		expect(connection.shutdownRequests.count).toBe(1);
		expect(connection.notifications).toEqual(["exit"]);
		expect(connection.endCalls.count).toBe(1);
		expect(process.signals).toEqual(["SIGTERM"]);
	});
});
