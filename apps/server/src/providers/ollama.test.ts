import { describe, expect, it } from "vitest";
import { createOllamaProvider } from "./ollama.js";

describe("Ollama provider capabilities", () => {
  it("uses native model metadata when the compatible listing omits context", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const provider = createOllamaProvider({
      fetcher: async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {})
        });
        const payload = url.endsWith("/api/show")
          ? {
              capabilities: ["completion", "tools", "thinking"],
              model_info: { "qwen3.context_length": 262_144 }
            }
          : {
              data: [{
                id: "qwen-local",
                supported_parameters: [],
                architecture: { input_modalities: ["text"] }
              }]
            };
        return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
        });
      }
    });

    expect(await provider.getCapabilities("qwen-local")).toMatchObject({
      contextLength: 262_144,
      textInput: true,
      toolCalling: true,
      reasoningOutput: true
    });
    expect(requests).toContainEqual({
      url: "http://127.0.0.1:11434/api/show",
      body: { model: "qwen-local" }
    });
  });

  it("retries native metadata after a transient failure", async () => {
    let showCalls = 0;
    const provider = createOllamaProvider({
      fetcher: async input => {
        const url = String(input);
        if (url.endsWith("/api/show")) {
          showCalls += 1;
          return new Response(showCalls === 1
            ? "temporarily unavailable"
            : JSON.stringify({
                capabilities: ["completion"],
                model_info: { "llama.context_length": 131_072 }
              }), {
            status: showCalls === 1 ? 503 : 200,
            headers: { "content-type": "application/json" }
          });
        }
        return new Response(JSON.stringify({ data: [{ id: "llama-local" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    expect(await provider.getCapabilities("llama-local")).toMatchObject({
      contextLength: 32_768
    });
    expect(await provider.getCapabilities("llama-local")).toMatchObject({
      contextLength: 131_072
    });
    expect(showCalls).toBe(2);
  });
});
