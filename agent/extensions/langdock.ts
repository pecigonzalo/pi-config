import {
	createProvider,
	type Api,
	type Model,
	type ProviderStreams,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type LangdockApi = "anthropic-messages" | "openai-responses";
type LangdockRegion = "global" | "eu" | "us";
type LangdockAnthropicRegion = Exclude<LangdockRegion, "global">;

const REGIONS: readonly LangdockRegion[] = ["global", "eu", "us"];
const ANTHROPIC_REGIONS: readonly LangdockAnthropicRegion[] = ["eu", "us"];
const LANGDOCK_API_BASE_URL = "https://api.langdock.com";
const DEFAULT_REGION: LangdockRegion = "eu";
const OPENAI_BASE_URL = `${LANGDOCK_API_BASE_URL}/openai/${DEFAULT_REGION}/v1`;
const API_KEY_ENVIRONMENT_VARIABLE = "LANGDOCK_API_KEY";

interface LangdockEndpoint {
	api: LangdockApi;
	region: LangdockRegion;
	modelsUrl: string;
	baseUrl: string;
}

const REGIONAL_MODEL_ID_PATTERN = /^(global|eu|us):(.*)$/;

function getUpstreamModel<TApi extends Api>(model: Model<TApi>): Model<TApi> {
	const upstreamId = REGIONAL_MODEL_ID_PATTERN.exec(model.id)?.[2];
	return upstreamId === undefined ? model : { ...model, id: upstreamId };
}

function withUpstreamModelIds(streams: ProviderStreams): ProviderStreams {
	const fetchDeferred = streams.fetchDeferred;
	const cancelDeferred = streams.cancelDeferred;
	return {
		stream: (model, context, options) => streams.stream(getUpstreamModel(model), context, options),
		streamSimple: (model, context, options) => streams.streamSimple(getUpstreamModel(model), context, options),
		...(fetchDeferred
			? {
					fetchDeferred: (model, handle, options) => fetchDeferred(getUpstreamModel(model), handle, options),
				}
			: {}),
		...(cancelDeferred
			? {
					cancelDeferred: (model, handle, options) =>
						cancelDeferred(getUpstreamModel(model), handle, options),
				}
			: {}),
	};
}

function getEndpoint(api: LangdockApi, region: LangdockRegion): LangdockEndpoint {
	const apiPath = api === "anthropic-messages" ? "anthropic" : "openai";
	const baseUrl = `${LANGDOCK_API_BASE_URL}/${apiPath}/${region}/v1`;
	return {
		api,
		region,
		modelsUrl: `${baseUrl}/models`,
		baseUrl,
	};
}

interface LangdockModel {
	id: string;
	name?: string;
	context_window?: number;
	context_length?: number;
	max_tokens?: number;
	max_output_tokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function property<T extends "string" | "number">(
	value: Record<string, unknown>,
	name: string,
	type: T,
): (T extends "string" ? string : number) | undefined {
	const candidate = value[name];
	return typeof candidate === type && (type !== "number" || Number.isFinite(candidate))
		? (candidate as T extends "string" ? string : number)
		: undefined;
}

function parseModelList(payload: unknown, endpoint: string): LangdockModel[] {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error(`Langdock returned an invalid model list from ${endpoint}.`);
	}

	return payload.data.map((model) => {
		if (!isRecord(model) || typeof model.id !== "string" || !model.id) {
			throw new Error(`Langdock returned an invalid model entry from ${endpoint}.`);
		}
		return {
			id: model.id,
			name: property(model, "name", "string"),
			context_window: property(model, "context_window", "number"),
			context_length: property(model, "context_length", "number"),
			max_tokens: property(model, "max_tokens", "number"),
			max_output_tokens: property(model, "max_output_tokens", "number"),
		};
	});
}

async function fetchModels(endpoint: string, apiKey: string, signal?: AbortSignal): Promise<LangdockModel[]> {
	const response = await fetch(endpoint, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal,
	});
	if (!response.ok) {
		throw new Error(`Langdock model discovery failed for ${endpoint}: ${response.status} ${response.statusText}`);
	}
	return parseModelList(await response.json(), endpoint);
}

function createModels(
	models: LangdockModel[],
	api: LangdockApi,
	region: LangdockRegion,
	baseUrl: string,
): Model<LangdockApi>[] {
	return models.map((model) => ({
		id: `${region}:${model.id}`,
		name: `${model.name ?? model.id} (${region})`,
		api,
		baseUrl,
		provider: "langdock",
		reasoning: /^(claude|gpt-5|o[1-9])/i.test(model.id),
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.context_window ?? model.context_length ?? 128000,
		maxTokens: model.max_tokens ?? model.max_output_tokens ?? 4096,
	}));
}

async function fetchModelsFromLangdock(context: RefreshModelsContext) {
	if (!context.allowNetwork) return [];
	const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	if (!apiKey) {
		return [];
	}

	try {
		const endpoints = [
			...ANTHROPIC_REGIONS.map((region) => getEndpoint("anthropic-messages", region)),
			...REGIONS.map((region) => getEndpoint("openai-responses", region)),
		];
		const results = await Promise.all(
			endpoints.map(async (endpoint) => ({
				endpoint,
				models: await fetchModels(endpoint.modelsUrl, apiKey, context.signal),
			})),
		);
		return results.flatMap(({ endpoint, models }) =>
			createModels(models, endpoint.api, endpoint.region, endpoint.baseUrl),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Langdock model discovery failed: ${message}`);
		throw error;
	}
}

// Register a new provider for LangDock
export default function (pi: ExtensionAPI) {
	const provider = createProvider({
		id: "langdock",
		name: "Langdock",
		baseUrl: OPENAI_BASE_URL,
		auth: {
			apiKey: {
				name: "Workspace API Key",
				async login(interaction) {
					return {
						type: "api_key",
						key: await interaction.prompt({
							type: "secret",
							message: "Enter your Langdock API key (you can find it in your workspace settings)",
						}),
					};
				},
				async resolve({ ctx, credential }) {
					const apiKey = credential?.key ?? (await ctx.env(API_KEY_ENVIRONMENT_VARIABLE));
					return apiKey
						? {
								auth: { apiKey },
								source: credential?.key ? "stored API key" : API_KEY_ENVIRONMENT_VARIABLE,
							}
						: undefined;
				},
			},
		},
		models: [],
		api: {
			"openai-responses": withUpstreamModelIds(openAIResponsesApi()),
			"anthropic-messages": withUpstreamModelIds(anthropicMessagesApi()),
		},
		fetchModels: fetchModelsFromLangdock,
	});
	pi.registerProvider(provider);
}
