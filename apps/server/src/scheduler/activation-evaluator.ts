import {
  activationDecisionSchema,
  type ActivationDecision,
  type AgentDefinition,
  type NormalizedChatRequest,
  type RoomMessage,
  type RoomSnapshot
} from "@writers-room/contracts";
import type { ModelProvider } from "../providers/model-provider.js";

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
  constructor(private readonly providers: ReadonlyMap<string, ModelProvider>) {}

  async evaluate(input: ActivationEvaluationInput): Promise<ActivationDecision> {
    const provider = this.providers.get(input.agent.provider);
    if (!provider) throw new Error(`Provider is not configured: ${input.agent.provider}`);
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
            "Return one JSON object only with shouldRespond, urgency, confidence,",
            "intendedMove, targetMessageId, and a compact reason.",
            "Silence is good when the contribution would be redundant."
          ].join("\n")
        },
        {
          role: "user",
          content: `Recent room:\n${recent}\n\nCurrent event:\n${input.eventMessage.content}`
        }
      ],
      temperature: 0,
      maxOutputTokens: 160,
      reasoning: { enabled: false, displayMode: "hidden" },
      tools: [],
      sessionId: `${input.room.room.id}:${input.agent.id}:activation`,
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
            targetMessageId: { type: "string" },
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
    };
    let text = "";
    for await (const event of provider.streamChat(request)) {
      if (event.type === "text-delta") text += event.text;
    }
    return activationDecisionSchema.parse(extractJson(text));
  }
}

