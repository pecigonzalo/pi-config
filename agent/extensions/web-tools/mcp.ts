import { createTimedSignal } from "./shared";

export interface McpToolCallOptions {
	url: string;
	toolName: string;
	args: Record<string, unknown>;
	timeoutSeconds: number;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	headers?: Record<string, string>;
}

interface McpPayload {
	result?: {
		content?: Array<{
			type?: string;
			text?: string;
		}>;
	};
	error?: {
		message?: string;
	};
}

function parsePayloadText(payload: string): string | undefined {
	const trimmed = payload.trim();
	if (!trimmed.startsWith("{")) return undefined;

	let parsed: McpPayload;
	try {
		parsed = JSON.parse(trimmed) as McpPayload;
	} catch {
		return undefined;
	}

	if (parsed.error?.message) {
		throw new Error(parsed.error.message);
	}

	const texts = (parsed.result?.content ?? [])
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text!.trim())
		.filter(Boolean);

	if (texts.length === 0) return undefined;
	return texts.join("\n\n");
}

export function extractMcpTextResponse(body: string): string | undefined {
	const direct = parsePayloadText(body);
	if (direct) return direct;

	const chunks: string[] = [];
	for (const line of body.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const text = parsePayloadText(line.slice(6));
		if (text) chunks.push(text);
	}

	if (chunks.length === 0) return undefined;
	return chunks.join("\n\n");
}

export async function callMcpTool(
	options: McpToolCallOptions,
): Promise<{ response: Response; text: string }> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timedSignal = createTimedSignal(options.signal, options.timeoutSeconds);

	try {
		let response: Response;
		try {
			response = await fetchImpl(options.url, {
				method: "POST",
				signal: timedSignal.signal,
				headers: {
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
					...(options.headers ?? {}),
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: {
						name: options.toolName,
						arguments: options.args,
					},
				}),
			});
		} catch (error) {
			if (timedSignal.didTimeout()) {
				throw new Error(`MCP request timed out after ${options.timeoutSeconds}s`);
			}
			throw error;
		}

		const body = await response.text();
		const text = extractMcpTextResponse(body);
		if (!response.ok) {
			throw new Error(`MCP endpoint returned HTTP ${response.status}${text ? `: ${text}` : ""}`);
		}
		if (!text) {
			throw new Error("MCP response did not contain any text output");
		}

		return { response, text };
	} finally {
		timedSignal.cleanup();
	}
}
