import type { ModelCapabilities } from "@writers-room/contracts";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";

const defaultOllamaCapabilities: ModelCapabilities = {
  contextLength: 32_768,
  textInput: true,
  imageInput: false,
  pdfInput: false,
  toolCalling: true,
  structuredOutput: true,
  reasoningInputControl: true,
  reasoningOutput: true,
  promptCaching: false
};

export function createOllamaProvider(input?: {
  baseUrl?: string;
  capabilityOverrides?: Record<string, ModelCapabilities>;
}): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    id: "ollama",
    baseUrl: input?.baseUrl ?? "http://127.0.0.1:11434/v1",
    capabilityOverrides: new Proxy(input?.capabilityOverrides ?? {}, {
      get(target, property: string) {
        return target[property] ?? defaultOllamaCapabilities;
      }
    })
  });
}
