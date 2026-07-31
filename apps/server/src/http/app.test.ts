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
    return [
      {
        id: "anthropic/claude-sonnet",
        name: "Claude Sonnet",
        capabilities: {
          contextLength: 200_000,
          textInput: true,
          imageInput: true,
          pdfInput: true,
          toolCalling: true,
          structuredOutput: true,
          reasoningInputControl: true,
          reasoningOutput: true,
          promptCaching: true
        }
      }
    ];
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
  it("exposes the configured provider model catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const application = createHttpApplication({
      store,
      providers: new Map([["openrouter", new FixtureProvider()]])
    });

    const response = await request(application)
      .get("/api/v1/providers/openrouter/models")
      .expect(200);

    expect(response.body).toMatchObject({
      provider: "openrouter",
      models: [
        {
          id: "anthropic/claude-sonnet",
          name: "Claude Sonnet",
          capabilities: {
            contextLength: 200_000,
            imageInput: true,
            toolCalling: true
          }
        }
      ]
    });
    store.close();
  });

  it("persists reusable voice templates across restarts", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const databasePath = join(root, "room.db");
    const firstStore = new RoomStore(databasePath);
    const firstApplication = createHttpApplication({
      store: firstStore,
      providers: new Map([["openrouter", new FixtureProvider()]])
    });
    const input = {
      title: "Systems critic",
      name: "Systems Engineer",
      description: "Finds durable seams and failure modes.",
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet",
      systemPrompt: "Challenge architecture with concrete failure modes.",
      personaPrompt: "Direct, skeptical, and concise.",
      temperature: 0.4,
      maxOutputTokens: 900,
      reasoning: { enabled: true, effort: "high", displayMode: "summary" },
      tools: ["search_workspace"],
      contextBudget: {
        softLimitTokens: 12_000,
        hardLimitTokens: 16_000,
        recentTranscriptTokens: 8_000,
        retrievedContextTokens: 2_000,
        notebookTokens: 0
      }
    };

    const created = await request(firstApplication)
      .post("/api/v1/voice-templates")
      .send(input)
      .expect(201);
    expect(created.body.template).toMatchObject(input);
    expect(created.body.template.id).toEqual(expect.any(String));
    firstStore.close();

    const reopenedStore = new RoomStore(databasePath);
    const reopenedApplication = createHttpApplication({
      store: reopenedStore,
      providers: new Map([["openrouter", new FixtureProvider()]])
    });
    const listed = await request(reopenedApplication)
      .get("/api/v1/voice-templates")
      .expect(200);
    expect(listed.body.templates).toMatchObject([input]);
    reopenedStore.close();
  });

  it("updates and deletes voice templates through the settings API", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const application = createHttpApplication({
      store,
      providers: new Map([["openrouter", new FixtureProvider()]])
    });
    const created = await request(application)
      .post("/api/v1/voice-templates")
      .send({
        title: "Draft critic",
        name: "Critic",
        description: "",
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet",
        systemPrompt: "Challenge the draft.",
        temperature: 0.6,
        maxOutputTokens: 700,
        reasoning: { enabled: false, displayMode: "hidden" },
        tools: [],
        contextBudget: {
          softLimitTokens: 12_000,
          hardLimitTokens: 16_000,
          recentTranscriptTokens: 8_000,
          retrievedContextTokens: 2_000,
          notebookTokens: 0
        }
      })
      .expect(201);
    const templateId = created.body.template.id as string;

    const updated = await request(application)
      .patch(`/api/v1/voice-templates/${templateId}`)
      .send({ title: "Adversarial critic", temperature: 0.3 })
      .expect(200);
    expect(updated.body.template).toMatchObject({
      id: templateId,
      title: "Adversarial critic",
      temperature: 0.3,
      systemPrompt: "Challenge the draft."
    });

    await request(application)
      .delete(`/api/v1/voice-templates/${templateId}`)
      .expect(200);
    const listed = await request(application)
      .get("/api/v1/voice-templates")
      .expect(200);
    expect(listed.body.templates).toEqual([]);
    store.close();
  });

  it("persists a manual agent turn and its inspectable generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const application = createHttpApplication({
      store,
      providers: new Map([["openrouter", new FixtureProvider()]]),
      automaticScheduling: false
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

    await request(application)
      .patch(`/api/v1/rooms/${roomId}/agents/systems/runtime`)
      .send({ muted: true })
      .expect(200);
    await request(application)
      .post(`/api/v1/rooms/${roomId}/speakers/systems`)
      .send({})
      .expect(409);

    store.close();
  });
});
