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

export async function runSandboxedCommandAfterHealthCheck<T>(options: {
	healthMonitor: SandboxHealthMonitor;
	ensureHealthy: () => Promise<void>;
	execute: () => Promise<T>;
	now?: () => number;
}): Promise<T> {
	await options.ensureHealthy();
	try {
		return await options.execute();
	} finally {
		options.healthMonitor.recordCommandFinished(options.now?.() ?? Date.now());
	}
}
