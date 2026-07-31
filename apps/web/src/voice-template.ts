import type {
  DefaultModelSelection,
  VoiceTemplate,
  VoiceTemplateInput
} from "@writers-room/contracts";
import { createDefaultVoiceConfiguration } from "@writers-room/contracts";

export function blankVoiceTemplate(
  defaultModel?: DefaultModelSelection
): VoiceTemplateInput {
  return {
    ...createDefaultVoiceConfiguration(),
    title: "New voice",
    name: "",
    description: "",
    provider: defaultModel?.provider ?? "openrouter",
    modelId: defaultModel?.modelId ?? "",
    systemPrompt: "Advance the discussion from your distinct expertise.",
    personaPrompt: "",
  };
}

export function voiceTemplateInput(template: VoiceTemplate): VoiceTemplateInput {
  return {
    title: template.title,
    name: template.name,
    description: template.description,
    provider: template.provider,
    modelId: template.modelId,
    systemPrompt: template.systemPrompt,
    ...(template.personaPrompt === undefined
      ? {}
      : { personaPrompt: template.personaPrompt }),
    temperature: template.temperature,
    ...(template.topP === undefined ? {} : { topP: template.topP }),
    maxOutputTokens: template.maxOutputTokens,
    reasoning: template.reasoning,
    tools: [...template.tools],
    contextBudget: { ...template.contextBudget }
  };
}
