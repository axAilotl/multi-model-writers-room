import { describe, expect, it, vi } from "vitest";
import type { NormalizedChatRequest } from "@writers-room/contracts";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";

const request: NormalizedChatRequest = {
  modelId: "example/model",
  messages: [{ role: "user", content: "Hello" }],
  temperature: 0.4,
  maxOutputTokens: 256,
  reasoning: { enabled: true, effort: "low", displayMode: "full" },
  tools: [],
  sessionId: "agent-1"
};

describe("OpenAI-compatible provider seam", () => {
  it("normalizes model-catalog input modalities and supported parameters", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({
        data: [
          {
            id: "example/vision-model",
            name: "Vision Model",
            context_length: 128_000,
            architecture: {
              input_modalities: ["text", "image", "file"]
            },
            supported_parameters: [
              "tools",
              "reasoning",
              "structured_outputs",
              "prompt_cache_key"
            ]
          }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    const provider = new OpenAiCompatibleProvider({
      id: "generic",
      baseUrl: "http://model.test/v1",
      fetcher
    });

    await expect(provider.listModels()).resolves.toMatchObject([
      {
        id: "example/vision-model",
        capabilities: {
          contextLength: 128_000,
          textInput: true,
          imageInput: true,
          pdfInput: true,
          toolCalling: true,
          structuredOutput: true,
          reasoningInputControl: true,
          reasoningOutput: true,
          promptCaching: true
        }
      }
    ]);
  });

  it("normalizes streamed reasoning, text, routing, usage, and completion", async () => {
    const body = [
      'data: {"model":"routed/model","provider":"Together","choices":[{"delta":{"reasoning":"Think ","content":""}}]}',
      'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.summary","summary":"Checked evidence"}],"content":"Hello"}}]}',
      'data: {"choices":[{"delta":{"content":" room"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":2}}}',
      "data: [DONE]",
      ""
    ].join("\n\n");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }));
    const provider = new OpenAiCompatibleProvider({
      id: "generic",
      baseUrl: "http://model.test/v1",
      fetcher
    });

    const events = [];
    for await (const event of provider.streamChat(request)) events.push(event);

    expect(events).toEqual([
      { type: "routing", modelId: "routed/model", provider: "Together" },
      { type: "reasoning-delta", text: "Think " },
      { type: "reasoning-summary", text: "Checked evidence" },
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: " room" },
      { type: "usage", inputTokens: 12, outputTokens: 4, reasoningTokens: 2 },
      { type: "done", finishReason: "stop" }
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "http://model.test/v1/chat/completions",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("propagates aborts without retrying or inventing a completion event", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(
      new DOMException("aborted", "AbortError")
    );
    const provider = new OpenAiCompatibleProvider({
      id: "generic",
      baseUrl: "http://model.test/v1",
      fetcher
    });

    const collect = async () => {
      for await (const _event of provider.streamChat({ ...request, signal: controller.signal })) {
        // no events expected
      }
    };
    await expect(collect()).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps the provider tool-call ID across fragmented deltas", async () => {
    const body = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-real","function":{"name":"search_","arguments":"{\\"query\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"workspace","arguments":"\\"table\\"}"}}]}}]}',
      "data: [DONE]",
      ""
    ].join("\n\n");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }));
    const provider = new OpenAiCompatibleProvider({
      id: "generic",
      baseUrl: "http://model.test/v1",
      fetcher
    });

    const events = [];
    for await (const event of provider.streamChat(request)) events.push(event);

    expect(events).toEqual([
      {
        type: "tool-call",
        id: "call-real",
        name: "search_",
        arguments: '{"query":'
      },
      {
        type: "tool-call",
        id: "call-real",
        name: "workspace",
        arguments: '"table"}'
      }
    ]);
  });
});
