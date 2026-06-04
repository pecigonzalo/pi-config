export function shouldProbeSandboxAfterIdle(lastCommandAt: number, now: number, idleProbeIntervalMs: number): boolean {
	return now - lastCommandAt >= idleProbeIntervalMs;
}

export class SandboxHealthMonitor {
	private lastCommandAt: number;

	constructor(private readonly idleProbeIntervalMs: number, initialCommandAt = Date.now()) {
		this.lastCommandAt = initialCommandAt;
	}

	reset(now = Date.now()): void {
		this.lastCommandAt = now;
	}

	getLastCommandAt(): number {
		return this.lastCommandAt;
	}

	idleMs(now = Date.now()): number {
		return now - this.lastCommandAt;
	}

	shouldProbe(now = Date.now()): boolean {
		return shouldProbeSandboxAfterIdle(this.lastCommandAt, now, this.idleProbeIntervalMs);
	}

	recordCommandFinished(now = Date.now()): void {
		this.lastCommandAt = now;
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("aborted");
}

export async function runSandboxedCommandAfterHealthCheck<T>(options: {
	healthMonitor: SandboxHealthMonitor;
	ensureHealthy: (signal?: AbortSignal) => Promise<void>;
	execute: () => Promise<T>;
	now?: () => number;
	signal?: AbortSignal;
}): Promise<T> {
	throwIfAborted(options.signal);
	await options.ensureHealthy(options.signal);
	throwIfAborted(options.signal);
	try {
		return await options.execute();
	} finally {
		options.healthMonitor.recordCommandFinished(options.now?.() ?? Date.now());
	}
}
