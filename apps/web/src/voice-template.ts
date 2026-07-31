import type {
  DefaultModelSelection,
  VoiceTemplate,
  VoiceTemplateInput
} from "@writers-room/contracts";
import { defaultRoomToolNames } from "@writers-room/contracts";

export function blankVoiceTemplate(
  defaultModel?: DefaultModelSelection
): VoiceTemplateInput {
  return {
    title: "New voice",
    name: "",
    description: "",
    provider: defaultModel?.provider ?? "openrouter",
    modelId: defaultModel?.modelId ?? "",
    systemPrompt: "Advance the discussion from your distinct expertise.",
    personaPrompt: "",
    temperature: 0.7,
    maxOutputTokens: 1_200,
    reasoning: {
      enabled: true,
      effort: "medium",
      displayMode: "summary"
    },
    tools: [...defaultRoomToolNames],
    contextBudget: {
      softLimitTokens: 120_000,
      hardLimitTokens: 160_000,
      recentTranscriptTokens: 70_000,
      retrievedContextTokens: 24_000,
      notebookTokens: 0
    }
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
