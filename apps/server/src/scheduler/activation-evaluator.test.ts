import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ModelCapabilities,
  ModelDescriptor,
  NormalizedChatRequest,
  NormalizedGenerationEvent
} from "@writers-room/contracts";
import type { ModelProvider } from "../providers/model-provider.js";
import { RoomStore } from "../storage/room-store.js";
import { ParticipantModelActivationEvaluator } from "./activation-evaluator.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const capabilities: ModelCapabilities = {
  contextLength: 1_000_000,
  textInput: true,
  imageInput: false,
  pdfInput: false,
  toolCalling: true,
  structuredOutput: true,
  reasoningInputControl: true,
  reasoningOutput: true,
  promptCaching: true
};

class ReasoningHungryActivationProvider implements ModelProvider {
  readonly id = "openrouter";
  requests: NormalizedChatRequest[] = [];

  constructor(private readonly supportedEfforts?: Array<"low" | "medium">) {}

  async listModels(): Promise<ModelDescriptor[]> {
    return [{
      id: "reasoning/model",
      name: "Reasoning model",
      capabilities,
      ...(this.supportedEfforts === undefined
        ? {}
        : { reasoning: { supportedEfforts: this.supportedEfforts } })
    }];
  }

  async getCapabilities(): Promise<ModelCapabilities> {
    return capabilities;
  }

  async *streamChat(
    request: NormalizedChatRequest
  ): AsyncIterable<NormalizedGenerationEvent> {
    this.requests.push(request);
    yield { type: "reasoning-delta", text: "I should decide whether to answer." };
    if (request.maxOutputTokens < 640) {
      yield { type: "done", finishReason: "length" };
      return;
    }
    yield {
      type: "text-delta",
      text: JSON.stringify({
        shouldRespond: true,
        urgency: 0.8,
        confidence: 0.9,
        intendedMove: "extend",
        reason: "Distinct relevant evidence"
      })
    };
    yield { type: "done", finishReason: "stop" };
  }
}

describe("participant activation evaluator", () => {
  it("reserves enough output for a reasoning model to emit its final decision", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-activation-budget-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({ title: "Activation budget room" });
    const agent = store.addAgent(room.id, {
      id: "reasoner",
      name: "Reasoner",
      description: "Connects architecture evidence.",
      provider: "openrouter",
      modelId: "reasoning/model",
      systemPrompt: "Advance the room.",
      temperature: 0.4,
      maxOutputTokens: 2_000,
      reasoning: { enabled: true, effort: "high", displayMode: "summary" },
      tools: [],
      contextBudget: {
        automatic: true,
        softLimitTokens: 240_000,
        hardLimitTokens: 512_000,
        recentTranscriptTokens: 120_000,
        retrievedContextTokens: 80_000,
        notebookTokens: 40_000
      },
      capabilities
    });
    const message = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "How should the retrieval boundary work?"
    });
    const provider = new ReasoningHungryActivationProvider();
    const evaluator = new ParticipantModelActivationEvaluator(new Map([
      [provider.id, provider]
    ]));

    await expect(evaluator.evaluate({
      room: store.getSnapshot(room.id),
      agent,
      eventMessage: message
    })).resolves.toMatchObject({
      shouldRespond: true,
      intendedMove: "extend"
    });
    expect(provider.requests[0]?.maxOutputTokens).toBeGreaterThanOrEqual(640);
    store.close();
  });

  it("uses the model's lowest advertised reasoning effort", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-activation-effort-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({ title: "Activation effort room" });
    const agent = store.addAgent(room.id, {
      id: "low-effort-reasoner",
      name: "Low Effort Reasoner",
      description: "Makes bounded routing decisions.",
      provider: "openrouter",
      modelId: "reasoning/model",
      systemPrompt: "Advance the room.",
      temperature: 0.4,
      maxOutputTokens: 2_000,
      reasoning: { enabled: true, effort: "medium", displayMode: "summary" },
      tools: [],
      contextBudget: {
        automatic: true,
        softLimitTokens: 240_000,
        hardLimitTokens: 512_000,
        recentTranscriptTokens: 120_000,
        retrievedContextTokens: 80_000,
        notebookTokens: 40_000
      },
      capabilities
    });
    const message = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "Who should answer?"
    });
    const provider = new ReasoningHungryActivationProvider(["medium", "low"]);
    const evaluator = new ParticipantModelActivationEvaluator(new Map([
      [provider.id, provider]
    ]));

    await evaluator.evaluate({
      room: store.getSnapshot(room.id),
      agent,
      eventMessage: message
    });

    expect(provider.requests[0]?.reasoning).toMatchObject({
      enabled: true,
      effort: "low",
      displayMode: "hidden"
    });
    store.close();
  });
});
