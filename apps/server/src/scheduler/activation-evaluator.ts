import {
  activationDecisionSchema,
  type ActivationDecision,
  type AgentDefinition,
  type NormalizedChatRequest,
  type ReasoningConfig,
  type ReasoningEffort,
  type RoomMessage,
  type RoomSnapshot
} from "@writers-room/contracts";
import type { ModelDescriptor, ModelProvider } from "../providers/model-provider.js";

export interface ActivationEvaluationInput {
  room: RoomSnapshot;
  agent: AgentDefinition;
  eventMessage: RoomMessage;
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Activation output contains no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

export class ParticipantModelActivationEvaluator {
  private readonly reasoningSupport = new WeakMap<
    ModelProvider,
    Map<string, Promise<ModelDescriptor["reasoning"] | undefined>>
  >();

  constructor(private readonly providers: ReadonlyMap<string, ModelProvider>) {}

  async evaluate(input: ActivationEvaluationInput): Promise<ActivationDecision> {
    const provider = this.providers.get(input.agent.provider);
    if (!provider) throw new Error(`Provider is not configured: ${input.agent.provider}`);
    const reasoning = await this.activationReasoning(provider, input.agent);
    const eventSpeaker = input.room.agents.find(agent =>
      agent.id === input.eventMessage.authorId
    )?.name ?? (input.eventMessage.authorType === "human"
      ? "Human"
      : input.eventMessage.authorId);
    const styleInstruction = {
      conversation: "Favor a balanced natural conversation; join when you have a distinct useful move.",
      hollywood: "Favor energetic crosstalk. Be willing to riff, mutate an idea, punch up, or react directly to another voice; keep the eventual intervention short.",
      debate: "Favor substantive engagement with claims: steelman, challenge, defend, rebut, request evidence, or expose assumptions.",
      "deep-study": "Be selective. Speak when your specialty or private evidence can materially deepen the answer; avoid rapid reactive crosstalk."
    }[input.room.room.settings.conversationStyle];
    const recent = input.room.messages.slice(-6).map(message => {
      const speaker = input.room.agents.find(agent => agent.id === message.authorId)?.name
        ?? (message.authorType === "human" ? "Human" : message.authorId);
      return `[${speaker}] ${message.content.slice(0, 500)}`;
    }).join("\n");
    const request: NormalizedChatRequest = {
      modelId: input.agent.modelId,
      messages: [
        {
          role: "system",
          content: [
            `You decide whether ${input.agent.name} should speak in a group discussion.`,
            `Specialization: ${input.agent.description}`,
            "The current event may be from the human or another model participant.",
            "On another participant's event, speak when you can challenge, extend, connect, clarify, or add distinct evidence.",
            "Do not behave as though only human-authored messages deserve a reply.",
            styleInstruction,
            "Return one JSON object only with shouldRespond, urgency, confidence,",
            "intendedMove and a compact reason. Do not invent message IDs.",
            "Silence is good when the contribution would be redundant."
          ].join("\n")
        },
        {
          role: "user",
          content: `Recent room:\n${recent}\n\nCurrent event from [${eventSpeaker}]:\n${input.eventMessage.content}`
        }
      ],
      temperature: 0,
      // Reasoning-first models can spend a small completion entirely on hidden
      // thinking and never emit the JSON decision. Minimal effort plus a real
      // final-answer allowance keeps this housekeeping call bounded and usable.
      maxOutputTokens: 768,
      reasoning,
      tools: [],
      sessionId: `${input.room.room.id}:${input.agent.id}:activation`,
      signal: AbortSignal.timeout(60_000),
      ...(input.agent.capabilities?.structuredOutput
        ? {
          structuredOutput: {
            name: "activation_decision",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["shouldRespond", "urgency", "confidence"],
              properties: {
                shouldRespond: { type: "boolean" },
                urgency: { type: "number", minimum: 0, maximum: 1 },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                intendedMove: {
                  type: "string",
                  enum: [
                    "answer", "challenge", "extend", "clarify", "connect",
                    "summarize", "retrieve", "defer"
                  ]
                },
                reason: { type: "string" }
              }
            }
          }
        }
        : {})
    };
    let text = "";
    for await (const event of provider.streamChat(request)) {
      if (event.type === "text-delta") text += event.text;
    }
    return activationDecisionSchema.parse(extractJson(text));
  }

  private async activationReasoning(
    provider: ModelProvider,
    agent: AgentDefinition
  ): Promise<ReasoningConfig> {
    if (!agent.capabilities?.reasoningInputControl) {
      return { enabled: false, displayMode: "hidden" };
    }
    let providerSupport = this.reasoningSupport.get(provider);
    if (!providerSupport) {
      providerSupport = new Map();
      this.reasoningSupport.set(provider, providerSupport);
    }
    let lookup = providerSupport.get(agent.modelId);
    if (!lookup) {
      lookup = provider.listModels()
        .then(models => models.find(model => model.id === agent.modelId)?.reasoning)
        .catch(() => undefined);
      providerSupport.set(agent.modelId, lookup);
    }
    const support = await lookup;
    const effortOrder: ReasoningEffort[] = [
      "minimal", "low", "medium", "high", "xhigh", "max"
    ];
    const supported = support?.supportedEfforts;
    const effort = supported === null
      ? "minimal"
      : effortOrder.find(candidate => supported?.includes(candidate));
    if (effort) {
      return { enabled: true, effort, displayMode: "hidden" };
    }
    if (support?.supportsMaxTokens) {
      return { enabled: true, maxTokens: 128, displayMode: "hidden" };
    }
    if (agent.reasoning.maxTokens !== undefined) {
      return {
        enabled: true,
        maxTokens: Math.min(128, agent.reasoning.maxTokens),
        displayMode: "hidden"
      };
    }
    if (agent.reasoning.effort !== undefined) {
      return {
        enabled: true,
        effort: agent.reasoning.effort,
        displayMode: "hidden"
      };
    }
    return { enabled: true, displayMode: "hidden" };
  }
}
