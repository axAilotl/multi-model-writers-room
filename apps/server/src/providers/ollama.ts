import type {
  ModelCapabilities,
  NormalizedChatRequest,
  NormalizedGenerationEvent
} from "@writers-room/contracts";
import type { ModelDescriptor, ModelProvider } from "./model-provider.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";

interface OllamaShowResponse {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
}

function nativeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function nativeContextLength(payload: OllamaShowResponse): number | undefined {
  const values = Object.entries(payload.model_info ?? {})
    .filter(([key]) => key.endsWith(".context_length"))
    .map(([, value]) => typeof value === "number" ? value : Number(value))
    .filter(value => Number.isFinite(value) && value > 0);
  return values.length === 0 ? undefined : Math.max(...values);
}

class OllamaProvider implements ModelProvider {
  readonly id = "ollama";
  private readonly compatible: OpenAiCompatibleProvider;
  private readonly fetcher: typeof fetch;
  private readonly nativeBaseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly overrides: Record<string, ModelCapabilities>;
  private readonly nativeMetadata = new Map<string, Promise<OllamaShowResponse | undefined>>();

  constructor(input?: {
    baseUrl?: string;
    apiKey?: string;
    capabilityOverrides?: Record<string, ModelCapabilities>;
    fetcher?: typeof fetch;
  }) {
    const baseUrl = input?.baseUrl ?? "http://127.0.0.1:11434/v1";
    this.fetcher = input?.fetcher ?? fetch;
    this.nativeBaseUrl = nativeBaseUrl(baseUrl);
    this.apiKey = input?.apiKey;
    this.overrides = input?.capabilityOverrides ?? {};
    this.compatible = new OpenAiCompatibleProvider({
      id: this.id,
      baseUrl,
      ...(input?.apiKey === undefined ? {} : { apiKey: input.apiKey }),
      capabilityOverrides: this.overrides,
      ...(input?.fetcher === undefined ? {} : { fetcher: input.fetcher })
    });
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const models = await this.compatible.listModels();
    return Promise.all(models.map(async model => {
      if (this.overrides[model.id]) return model;
      const metadata = await this.show(model.id);
      if (!metadata) return model;
      const contextLength = nativeContextLength(metadata);
      const nativeCapabilities = new Set(metadata.capabilities ?? []);
      return {
        ...model,
        capabilities: {
          ...model.capabilities,
          ...(contextLength === undefined ? {} : { contextLength }),
          imageInput: model.capabilities.imageInput || nativeCapabilities.has("vision"),
          toolCalling: model.capabilities.toolCalling || nativeCapabilities.has("tools"),
          reasoningInputControl: model.capabilities.reasoningInputControl ||
            nativeCapabilities.has("thinking"),
          reasoningOutput: model.capabilities.reasoningOutput ||
            nativeCapabilities.has("thinking")
        }
      };
    }));
  }

  async getCapabilities(modelId: string): Promise<ModelCapabilities | undefined> {
    return (await this.listModels()).find(model => model.id === modelId)?.capabilities;
  }

  streamChat(
    request: NormalizedChatRequest
  ): AsyncIterable<NormalizedGenerationEvent> {
    return this.compatible.streamChat(request);
  }

  private show(modelId: string): Promise<OllamaShowResponse | undefined> {
    const existing = this.nativeMetadata.get(modelId);
    if (existing) return existing;
    const request = this.fetcher(`${this.nativeBaseUrl}/api/show`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(this.apiKey === undefined
          ? {}
          : { authorization: `Bearer ${this.apiKey}` })
      },
      body: JSON.stringify({ model: modelId }),
      signal: AbortSignal.timeout(5_000)
    }).then(async response => {
      if (!response.ok) return undefined;
      return await response.json() as OllamaShowResponse;
    }).catch(() => undefined);
    this.nativeMetadata.set(modelId, request);
    void request.then(result => {
      if (result === undefined && this.nativeMetadata.get(modelId) === request) {
        this.nativeMetadata.delete(modelId);
      }
    });
    return request;
  }
}

export function createOllamaProvider(input?: {
  baseUrl?: string;
  apiKey?: string;
  capabilityOverrides?: Record<string, ModelCapabilities>;
  fetcher?: typeof fetch;
}): ModelProvider {
  return new OllamaProvider(input);
}
