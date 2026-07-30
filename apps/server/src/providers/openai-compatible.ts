import type {
  ModelCapabilities,
  NormalizedChatRequest,
  NormalizedGenerationEvent
} from "@writers-room/contracts";
import type { ModelDescriptor, ModelProvider } from "./model-provider.js";

interface ProviderOptions {
  id: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetcher?: typeof fetch;
  capabilityOverrides?: Record<string, ModelCapabilities>;
}

interface StreamDelta {
  model?: string;
  provider?: string;
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
      reasoning_details?: Array<{
        type?: string;
        text?: string;
        summary?: string;
      }>;
      tool_calls?: Array<{
        id?: string;
        index?: number;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

function capabilitiesFromParameters(
  contextLength: number,
  parameters: readonly string[]
): ModelCapabilities {
  const supported = new Set(parameters);
  return {
    contextLength,
    textInput: true,
    imageInput: supported.has("images"),
    pdfInput: supported.has("file"),
    toolCalling: supported.has("tools"),
    structuredOutput: supported.has("structured_outputs") || supported.has("response_format"),
    reasoningInputControl: supported.has("reasoning"),
    reasoningOutput: supported.has("reasoning") || supported.has("include_reasoning"),
    promptCaching: supported.has("prompt_cache_key")
  };
}

function cleanBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function toolPayload(request: NormalizedChatRequest): unknown[] | undefined {
  if (request.tools.length === 0) return undefined;
  return request.tools.map(tool => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));
}

function buildBody(request: NormalizedChatRequest): Record<string, unknown> {
  const tools = toolPayload(request);
  const messages = request.messages.map(message => ({
    role: message.role,
    content: message.content,
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
    ...(message.toolCalls === undefined
      ? {}
      : {
          tool_calls: message.toolCalls.map(call => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments }
          }))
        })
  }));
  return {
    model: request.modelId,
    messages,
    temperature: request.temperature,
    max_tokens: request.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
    user: request.sessionId,
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(tools === undefined ? {} : { tools }),
    ...(request.structuredOutput === undefined
      ? {}
      : {
          response_format: {
            type: "json_schema",
            json_schema: request.structuredOutput
          }
        }),
    ...(request.reasoning.enabled
      ? {
          reasoning: {
            enabled: true,
            exclude: request.reasoning.displayMode === "hidden",
            ...(request.reasoning.effort === undefined
              ? {}
              : { effort: request.reasoning.effort }),
            ...(request.reasoning.maxTokens === undefined
              ? {}
              : { max_tokens: request.reasoning.maxTokens })
          }
        }
      : {})
  };
}

async function* parseServerSentEvents(
  response: Response
): AsyncIterable<StreamDelta> {
  if (!response.body) throw new Error("Provider returned an empty streaming body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        yield JSON.parse(data) as StreamDelta;
      }
    }
    if (done) break;
  }
  if (buffer.trim()) {
    for (const line of buffer.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data && data !== "[DONE]") yield JSON.parse(data) as StreamDelta;
    }
  }
}

function deltaEvents(delta: StreamDelta): NormalizedGenerationEvent[] {
  const events: NormalizedGenerationEvent[] = [];
  if (delta.model || delta.provider) {
    events.push({
      type: "routing",
      ...(delta.model === undefined ? {} : { modelId: delta.model }),
      ...(delta.provider === undefined ? {} : { provider: delta.provider })
    });
  }
  const choice = delta.choices?.[0];
  const message = choice?.delta;
  const reasoning = message?.reasoning ?? message?.reasoning_content;
  if (reasoning) events.push({ type: "reasoning-delta", text: reasoning });
  for (const detail of message?.reasoning_details ?? []) {
    if (detail.type === "reasoning.summary" && detail.summary) {
      events.push({ type: "reasoning-summary", text: detail.summary });
    } else if (detail.type === "reasoning.text" && detail.text) {
      events.push({ type: "reasoning-delta", text: detail.text });
    }
  }
  if (message?.content) events.push({ type: "text-delta", text: message.content });
  for (const call of message?.tool_calls ?? []) {
    events.push({
      type: "tool-call",
      id: call.id ?? `tool-${call.index ?? 0}`,
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? ""
    });
  }
  if (delta.usage) {
    events.push({
      type: "usage",
      ...(delta.usage.prompt_tokens === undefined
        ? {}
        : { inputTokens: delta.usage.prompt_tokens }),
      ...(delta.usage.completion_tokens === undefined
        ? {}
        : { outputTokens: delta.usage.completion_tokens }),
      ...(delta.usage.completion_tokens_details?.reasoning_tokens === undefined
        ? {}
        : {
            reasoningTokens:
              delta.usage.completion_tokens_details.reasoning_tokens
          }),
      ...(delta.usage.cost === undefined ? {} : { costUsd: delta.usage.cost })
    });
  }
  if (choice?.finish_reason) {
    events.push({ type: "done", finishReason: choice.finish_reason });
  }
  return events;
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly headers: Record<string, string>;
  private readonly fetcher: typeof fetch;
  private readonly overrides: Record<string, ModelCapabilities>;

  constructor(options: ProviderOptions) {
    this.id = options.id;
    this.baseUrl = cleanBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.headers = options.headers ?? {};
    this.fetcher = options.fetcher ?? fetch;
    this.overrides = options.capabilityOverrides ?? {};
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const response = await this.fetcher(`${this.baseUrl}/models`, {
      headers: this.requestHeaders()
    });
    if (!response.ok) throw await this.providerError(response);
    const payload = await response.json() as {
      data?: Array<{
        id: string;
        name?: string;
        context_length?: number;
        supported_parameters?: string[];
      }>;
    };
    return (payload.data ?? []).map(model => ({
      id: model.id,
      name: model.name ?? model.id,
      capabilities: this.overrides[model.id] ?? capabilitiesFromParameters(
        model.context_length ?? 32_768,
        model.supported_parameters ?? []
      )
    }));
  }

  async getCapabilities(modelId: string): Promise<ModelCapabilities | undefined> {
    if (this.overrides[modelId]) return this.overrides[modelId];
    return (await this.listModels()).find(model => model.id === modelId)?.capabilities;
  }

  async *streamChat(
    request: NormalizedChatRequest
  ): AsyncIterable<NormalizedGenerationEvent> {
    const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.requestHeaders(),
      body: JSON.stringify(buildBody(request)),
      ...(request.signal === undefined ? {} : { signal: request.signal })
    });
    if (!response.ok) throw await this.providerError(response);
    for await (const delta of parseServerSentEvents(response)) {
      for (const event of deltaEvents(delta)) yield event;
    }
  }

  private requestHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json",
      ...this.headers,
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
    };
  }

  private async providerError(response: Response): Promise<Error> {
    const text = await response.text();
    const clipped = text.slice(0, 2_000);
    return new Error(
      `Provider ${this.id} returned ${response.status}: ${clipped || response.statusText}`
    );
  }
}
