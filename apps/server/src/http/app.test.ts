import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type {
  NormalizedChatRequest,
  NormalizedGenerationEvent
} from "@writers-room/contracts";
import { createHttpApplication } from "./app.js";
import type { ModelProvider, ModelDescriptor } from "../providers/model-provider.js";
import { RoomStore } from "../storage/room-store.js";

class FixtureProvider implements ModelProvider {
  readonly id = "openrouter";

  async listModels(): Promise<ModelDescriptor[]> {
    return [];
  }

  async getCapabilities(): Promise<undefined> {
    return undefined;
  }

  async *streamChat(
    _request: NormalizedChatRequest
  ): AsyncIterable<NormalizedGenerationEvent> {
    yield { type: "reasoning-summary", text: "Found the architectural seam." };
    yield { type: "text-delta", text: "The table " };
    yield { type: "text-delta", text: "is a manifest." };
    yield { type: "usage", inputTokens: 100, outputTokens: 8, costUsd: 0.002 };
    yield { type: "done", finishReason: "stop" };
  }
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local HTTP room seam", () => {
  it("persists a manual agent turn and its inspectable generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const application = createHttpApplication({
      store,
      providers: new Map([["openrouter", new FixtureProvider()]])
    });

    const created = await request(application)
      .post("/api/v1/rooms")
      .send({ title: "Design room" })
      .expect(201);
    const roomId = created.body.room.id as string;
    const agent = {
      id: "systems",
      name: "Systems Engineer",
      description: "Finds durable architectural seams.",
      provider: "openrouter",
      modelId: "fixture/model",
      systemPrompt: "Advance the design with concrete architecture.",
      temperature: 0.5,
      maxOutputTokens: 600,
      reasoning: { enabled: true, displayMode: "summary" },
      tools: [],
      contextBudget: {
        softLimitTokens: 12_000,
        hardLimitTokens: 16_000,
        recentTranscriptTokens: 8_000,
        retrievedContextTokens: 2_000,
        notebookTokens: 0
      }
    };
    await request(application)
      .post(`/api/v1/rooms/${roomId}/agents`)
      .send(agent)
      .expect(201);
    const human = await request(application)
      .post(`/api/v1/rooms/${roomId}/messages`)
      .send({ content: "What is the table?" })
      .expect(201);

    await request(application)
      .post(`/api/v1/rooms/${roomId}/speakers/systems`)
      .send({ targetMessageId: human.body.message.id })
      .expect(201);

    const snapshot = await request(application)
      .get(`/api/v1/rooms/${roomId}`)
      .expect(200);
    expect(snapshot.body.messages.map((message: { content: string }) => message.content))
      .toEqual(["What is the table?", "The table is a manifest."]);
    expect(snapshot.body.generations).toMatchObject([
      {
        agentId: "systems",
        status: "complete",
        reasoningSummary: "Found the architectural seam.",
        inputTokens: 100,
        outputTokens: 8,
        costUsd: 0.002
      }
    ]);

    store.close();
  });
});
