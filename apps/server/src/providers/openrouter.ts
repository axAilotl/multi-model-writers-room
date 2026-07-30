import { OpenAiCompatibleProvider } from "./openai-compatible.js";

export function createOpenRouterProvider(input: {
  apiKey: string;
  appUrl?: string;
  appName?: string;
}): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    id: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: input.apiKey,
    headers: {
      ...(input.appUrl ? { "HTTP-Referer": input.appUrl } : {}),
      ...(input.appName ? { "X-Title": input.appName } : {})
    }
  });
}

