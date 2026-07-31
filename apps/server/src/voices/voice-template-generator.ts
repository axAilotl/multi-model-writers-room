import { z } from "zod";
import {
  createDefaultVoiceConfiguration,
  voiceTemplateInputSchema,
  type DefaultModelSelection,
  type NormalizedChatRequest,
  type VoiceTemplateGenerationRequest,
  type VoiceTemplateInput
} from "@writers-room/contracts";
import type { ModelProvider } from "../providers/model-provider.js";

const generatedFieldsSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500),
  systemPrompt: z.string().trim().min(1).max(8_000),
  personaPrompt: z.string().trim().min(1).max(2_000),
  temperature: z.number().min(0).max(2).default(0.7)
});

const generatedFieldsJsonSchema = {
  name: "voice_template",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "title",
      "description",
      "systemPrompt",
      "personaPrompt",
      "temperature"
    ],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 120 },
      description: { type: "string", minLength: 1, maxLength: 500 },
      systemPrompt: { type: "string", minLength: 1, maxLength: 8_000 },
      personaPrompt: { type: "string", minLength: 1, maxLength: 2_000 },
      temperature: { type: "number", minimum: 0, maximum: 2 }
    }
  }
};

function parseJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("The fallback model did not return a voice template");
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function completionText(
  provider: ModelProvider,
  request: NormalizedChatRequest
): Promise<string> {
  let text = "";
  for await (const event of provider.streamChat(request)) {
    if (event.type === "text-delta") text += event.text;
  }
  return text;
}

function parseGeneratedFields(text: string): z.infer<typeof generatedFieldsSchema> {
  return generatedFieldsSchema.parse(parseJsonObject(text));
}

export async function generateVoiceTemplate(input: {
  request: VoiceTemplateGenerationRequest;
  selection: DefaultModelSelection;
  provider: ModelProvider;
  signal?: AbortSignal;
}): Promise<VoiceTemplateInput> {
  const capabilities = await input.provider
    .getCapabilities(input.selection.modelId)
    .catch(() => undefined);
  const request: NormalizedChatRequest = {
    modelId: input.selection.modelId,
    messages: [
      {
        role: "system",
        content: [
          "Create one reusable voice template for a multi-model writers' room.",
          "Translate the source material into operational instructions and a short persona.",
          "The system prompt must describe expertise, priorities, productive moves, and boundaries.",
          "The persona prompt should control style without repeating the system prompt.",
          "Return one JSON object only with title, description, systemPrompt, personaPrompt, and temperature."
        ].join("\n")
      },
      {
        role: "user",
        content: `Voice name: ${input.request.name}\n\nSource material:\n${input.request.sourceText}`
      }
    ],
    temperature: 0.35,
    maxOutputTokens: 1_500,
    reasoning: { enabled: false, displayMode: "hidden" },
    tools: [],
    sessionId: "voice-template-generator",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(capabilities?.structuredOutput
      ? { structuredOutput: generatedFieldsJsonSchema }
      : {})
  };
  const firstText = await completionText(input.provider, request);
  let generated: z.infer<typeof generatedFieldsSchema>;
  try {
    generated = parseGeneratedFields(firstText);
  } catch {
    if (input.signal?.aborted) {
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error("Voice generation was aborted");
    }
    const repairRequest: NormalizedChatRequest = {
      modelId: input.selection.modelId,
      messages: [
        ...request.messages,
        ...(firstText.trim()
          ? [{ role: "assistant" as const, content: firstText.slice(0, 8_000) }]
          : []),
        {
          role: "user",
          content: [
            "The previous response was empty or invalid.",
            "Try once more. Return raw JSON only—no Markdown fence or commentary.",
            "Include every required field: title, description, systemPrompt, personaPrompt, temperature."
          ].join("\n")
        }
      ],
      temperature: 0,
      maxOutputTokens: 1_500,
      reasoning: { enabled: false, displayMode: "hidden" },
      tools: [],
      sessionId: "voice-template-generator:repair",
      ...(input.signal === undefined ? {} : { signal: input.signal })
    };
    const repairedText = await completionText(input.provider, repairRequest);
    try {
      generated = parseGeneratedFields(repairedText);
    } catch {
      throw new Error(
        "The fallback model did not return a valid voice template after two attempts"
      );
    }
  }
  return voiceTemplateInputSchema.parse({
    ...createDefaultVoiceConfiguration(),
    ...generated,
    name: input.request.name,
    provider: input.selection.provider,
    modelId: input.selection.modelId
  });
}
