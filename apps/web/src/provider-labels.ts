import type { AgentDefinition } from "@writers-room/contracts";

export const providerLabels: Record<AgentDefinition["provider"], string> = {
  openrouter: "OpenRouter",
  ollama: "Ollama",
  "openai-compatible": "OpenAI-compatible"
};
