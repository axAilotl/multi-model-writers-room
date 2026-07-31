import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ModelCapabilities,
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
      },
      {
        id: "image-only/model",
        name: "Image-only model",
        capabilities: {
          contextLength: 32_000,
          textInput: false,
          imageInput: true,
          pdfInput: false,
          toolCalling: false,
          structuredOutput: false,
          reasoningInputControl: false,
          reasoningOutput: false,
          promptCaching: false
        }
      }
    ];
  }

  async getCapabilities(): Promise<ModelCapabilities | undefined> {
    return (await this.listModels())[0]?.capabilities;
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

class VoiceGeneratorFixtureProvider extends FixtureProvider {
  lastRequest?: NormalizedChatRequest;
  calls = 0;

  override async *streamChat(
    request: NormalizedChatRequest
  ): AsyncIterable<NormalizedGenerationEvent> {
    this.lastRequest = request;
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: "done", finishReason: "stop" };
      return;
    }
    yield {
      type: "text-delta",
      text: JSON.stringify({
        title: "Product Heretic",
        description: "Questions comfortable product assumptions.",
        systemPrompt: "Challenge the proposal and surface neglected alternatives.",
        personaPrompt: "Provocative, concrete, and constructively skeptical.",
        temperature: 0.85
      })
    };
    yield { type: "done", finishReason: "stop" };
  }
}

class LargeContextFixtureProvider extends FixtureProvider {
  override async getCapabilities(): Promise<ModelCapabilities> {
    return {
      contextLength: 1_200_000,
      textInput: true,
      imageInput: false,
      pdfInput: false,
      toolCalling: true,
      structuredOutput: true,
      reasoningInputControl: true,
      reasoningOutput: true,
      promptCaching: true
    };
  }
}

class DeferredCapabilitiesProvider extends FixtureProvider {
  readonly started: Promise<void>;
  private readonly gate: Promise<void>;
  private markStarted!: () => void;
  private releaseGate!: () => void;

  constructor() {
    super();
    this.started = new Promise(resolve => {
      this.markStarted = resolve;
    });
    this.gate = new Promise(resolve => {
      this.releaseGate = resolve;
    });
  }

  release(): void {
    this.releaseGate();
  }

  override async getCapabilities(): Promise<ModelCapabilities | undefined> {
    this.markStarted();
    await this.gate;
    return super.getCapabilities();
  }
}

class UnavailableCapabilitiesProvider extends FixtureProvider {
  override async getCapabilities(): Promise<undefined> {
    return undefined;
  }
}

class AbortableGenerationProvider extends FixtureProvider {
  readonly started: Promise<void>;
  private markStarted!: () => void;

  constructor() {
    super();
    this.started = new Promise(resolve => {
      this.markStarted = resolve;
    });
  }

  override async *streamChat(
    request: NormalizedChatRequest
  ): AsyncIterable<NormalizedGenerationEvent> {
    this.markStarted();
    const signal = request.signal;
    if (!signal) throw new Error("Expected generation abort signal");
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(new DOMException("aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
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

    expect(response.body.provider).toBe("openrouter");
    expect(response.body.models.find((model: { id: string }) =>
      model.id === "anthropic/claude-sonnet"
    )).toMatchObject({
      id: "anthropic/claude-sonnet",
      name: "Claude Sonnet",
      capabilities: {
        contextLength: 200_000,
        imageInput: true,
        toolCalling: true
      }
    });
    store.close();
  });

  it("persists the selected fallback model across restarts", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const databasePath = join(root, "room.db");
    const firstStore = new RoomStore(databasePath);
    const firstApplication = createHttpApplication({
      store: firstStore,
      providers: new Map([["openrouter", new FixtureProvider()]])
    });

    await request(firstApplication)
      .put("/api/v1/settings/default-model")
      .send({ provider: "openrouter", modelId: "image-only/model" })
      .expect(400);
    const stillEmpty = await request(firstApplication)
      .get("/api/v1/settings/default-model")
      .expect(200);
    expect(stillEmpty.body.defaultModel).toBeNull();

    const saved = await request(firstApplication)
      .put("/api/v1/settings/default-model")
      .send({
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet"
      })
      .expect(200);
    expect(saved.body.defaultModel).toEqual({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet"
    });
    firstStore.close();

    const reopenedStore = new RoomStore(databasePath);
    const reopenedApplication = createHttpApplication({
      store: reopenedStore,
      providers: new Map([["openrouter", new FixtureProvider()]])
    });
    const loaded = await request(reopenedApplication)
      .get("/api/v1/settings/default-model")
      .expect(200);
    expect(loaded.body.defaultModel).toEqual(saved.body.defaultModel);
    reopenedStore.close();
  });

  it("generates an editable voice draft with the fallback model", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const provider = new VoiceGeneratorFixtureProvider();
    const application = createHttpApplication({
      store,
      providers: new Map([["openrouter", provider]])
    });
    await request(application)
      .put("/api/v1/settings/default-model")
      .send({
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet"
      })
      .expect(200);

    const generated = await request(application)
      .post("/api/v1/voice-templates/generate")
      .send({
        name: "Mara",
        sourceText: "Act as a product strategist who challenges safe assumptions and asks what users truly need."
      })
      .expect(200);

    expect(generated.body.template).toMatchObject({
      title: "Product Heretic",
      name: "Mara",
      description: "Questions comfortable product assumptions.",
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet",
      systemPrompt: "Challenge the proposal and surface neglected alternatives.",
      personaPrompt: "Provocative, concrete, and constructively skeptical.",
      temperature: 0.85
    });
    expect(provider.lastRequest?.modelId).toBe("anthropic/claude-sonnet");
    expect(provider.lastRequest?.signal).toBeInstanceOf(AbortSignal);
    expect(provider.calls).toBe(2);
    expect(provider.lastRequest?.messages.some(message =>
      message.content.includes("what users truly need")
    )).toBe(true);
    const templates = await request(application)
      .get("/api/v1/voice-templates")
      .expect(200);
    expect(templates.body.templates).toEqual([]);
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

  it("saves a voice template with a large-context persona", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const provider = new LargeContextFixtureProvider();
    const application = createHttpApplication({
      store,
      providers: new Map([["openrouter", provider]])
    });
    const personaPrompt = "Long-context persona instruction. ".repeat(125_000);

    const created = await request(application)
      .post("/api/v1/voice-templates")
      .send({
        title: "Long-context researcher",
        name: "Researcher",
        description: "Works from an extensive operating brief.",
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet",
        systemPrompt: "Follow the full persona brief.",
        personaPrompt,
        temperature: 0.4,
        maxOutputTokens: 900,
        reasoning: { enabled: true, effort: "high", displayMode: "summary" },
        tools: ["search_workspace"],
        contextBudget: {
          softLimitTokens: 1_000_000,
          hardLimitTokens: 1_100_000,
          recentTranscriptTokens: 8_000,
          retrievedContextTokens: 2_000,
          notebookTokens: 0
        }
      })
      .expect(201);

    expect(created.body.template.personaPrompt).toBe(personaPrompt.trim());
    const room = store.createRoom({ title: "Large-context room" });
    const added = await request(application)
      .post(`/api/v1/rooms/${room.id}/agents`)
      .send({
        ...created.body.template,
        id: "large-context-researcher",
        capabilities: {
          ...await provider.getCapabilities(),
          contextLength: 1
        }
      })
      .expect(201);
    expect(added.body.agent.capabilities.contextLength).toBe(1_200_000);

    store.addAgent(room.id, {
      ...added.body.agent,
      capabilities: {
        ...added.body.agent.capabilities,
        contextLength: 1
      }
    });
    await request(application)
      .post(`/api/v1/rooms/${room.id}/speakers/large-context-researcher`)
      .send({})
      .expect(201);
    store.close();
  });

  it("keeps the ordinary JSON request ceiling at two megabytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const application = createHttpApplication({
      store,
      providers: new Map([["openrouter", new FixtureProvider()]])
    });
    const room = store.createRoom({ title: "Ordinary request room" });

    const response = await request(application)
      .post(`/api/v1/rooms/${room.id}/messages`)
      .send({ content: "x".repeat(3_000_000) })
      .expect(413);

    expect(response.body.error).toMatch(/too large/i);
    store.close();
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
        description: "Preserve this description.",
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet",
        systemPrompt: "Challenge the draft.",
        temperature: 0.6,
        maxOutputTokens: 700,
        reasoning: { enabled: false, displayMode: "hidden" },
        tools: ["search_workspace"],
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
      .send({ title: "Adversarial critic" })
      .expect(200);
    expect(updated.body.template).toMatchObject({
      id: templateId,
      title: "Adversarial critic",
      description: "Preserve this description.",
      temperature: 0.6,
      maxOutputTokens: 700,
      tools: ["search_workspace"],
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

  it("does not start generation when a room is paused during capability lookup", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const provider = new DeferredCapabilitiesProvider();
    const application = createHttpApplication({
      store,
      providers: new Map([["openrouter", provider]]),
      automaticScheduling: false
    });
    const room = store.createRoom({ title: "Capability race room" });
    store.addAgent(room.id, {
      id: "systems",
      name: "Systems Engineer",
      description: "Finds durable seams.",
      provider: "openrouter",
      modelId: "fixture/model",
      systemPrompt: "Challenge the design.",
      temperature: 0.5,
      maxOutputTokens: 600,
      reasoning: { enabled: false, displayMode: "hidden" },
      tools: [],
      contextBudget: {
        softLimitTokens: 12_000,
        hardLimitTokens: 16_000,
        recentTranscriptTokens: 8_000,
        retrievedContextTokens: 2_000,
        notebookTokens: 0
      }
    });

    const generation = request(application)
      .post(`/api/v1/rooms/${room.id}/speakers/systems`)
      .send({})
      .expect(409)
      .then(response => response);
    await provider.started;
    await request(application)
      .patch(`/api/v1/rooms/${room.id}`)
      .send({ status: "paused" })
      .expect(200);
    provider.release();
    await generation;

    expect(store.getSnapshot(room.id).generations).toEqual([]);
    expect(store.getSnapshot(room.id).messages).toEqual([]);
    store.close();
  });

  it("fails closed when authoritative model capabilities are unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const application = createHttpApplication({
      store,
      providers: new Map([["openrouter", new UnavailableCapabilitiesProvider()]]),
      automaticScheduling: false
    });
    const room = store.createRoom({ title: "Unknown capability room" });
    const agent = {
      id: "unknown-model",
      name: "Unknown Model",
      description: "Uses a model without authoritative metadata.",
      provider: "openrouter" as const,
      modelId: "unknown/model",
      systemPrompt: "Advance the design.",
      temperature: 0.5,
      maxOutputTokens: 600,
      reasoning: { enabled: false, displayMode: "hidden" as const },
      tools: [],
      contextBudget: {
        softLimitTokens: 120_000,
        hardLimitTokens: 1_100_000,
        recentTranscriptTokens: 8_000,
        retrievedContextTokens: 2_000,
        notebookTokens: 0
      }
    };

    const addResponse = await request(application)
      .post(`/api/v1/rooms/${room.id}/agents`)
      .send(agent)
      .expect(400);
    expect(addResponse.body.error).toMatch(/capabilities are unavailable/i);

    store.addAgent(room.id, agent);
    const generationResponse = await request(application)
      .post(`/api/v1/rooms/${room.id}/speakers/${agent.id}`)
      .send({})
      .expect(500);
    expect(generationResponse.body.error).toMatch(/capabilities are unavailable/i);
    expect(store.getSnapshot(room.id).generations).toEqual([]);
    expect(store.getSnapshot(room.id).messages).toEqual([]);
    store.close();
  });

  it("removes a participant from one room without deleting it from another room", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const application = createHttpApplication({
      store,
      providers: new Map([["openrouter", new FixtureProvider()]])
    });
    const firstRoom = store.createRoom({ title: "First room" });
    const secondRoom = store.createRoom({ title: "Second room" });
    const agent = {
      id: "systems",
      name: "Systems Engineer",
      description: "Finds durable architectural seams.",
      provider: "openrouter" as const,
      modelId: "fixture/model",
      systemPrompt: "Advance the design with concrete architecture.",
      temperature: 0.5,
      maxOutputTokens: 600,
      reasoning: { enabled: true, displayMode: "summary" as const },
      tools: [],
      contextBudget: {
        softLimitTokens: 12_000,
        hardLimitTokens: 16_000,
        recentTranscriptTokens: 8_000,
        retrievedContextTokens: 2_000,
        notebookTokens: 0
      }
    };
    store.addAgent(firstRoom.id, agent);
    store.addAgent(secondRoom.id, agent);

    const removed = await request(application)
      .delete(`/api/v1/rooms/${firstRoom.id}/agents/${agent.id}`)
      .expect(200);

    expect(removed.body).toMatchObject({
      removed: true,
      agent: { id: agent.id, name: agent.name }
    });
    expect(store.getSnapshot(firstRoom.id).agents).toEqual([]);
    expect(store.getSnapshot(firstRoom.id).runtime).toEqual([]);
    expect(store.getSnapshot(secondRoom.id).agents).toMatchObject([
      { id: agent.id, name: agent.name }
    ]);
    store.close();
  });

  it("deletes a room without deleting the user's other rooms", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const application = createHttpApplication({
      store,
      providers: new Map([["openrouter", new FixtureProvider()]])
    });
    const deletedRoom = store.createRoom({ title: "Delete me" });
    const remainingRoom = store.createRoom({ title: "Keep me" });

    const deleted = await request(application)
      .delete(`/api/v1/rooms/${deletedRoom.id}`)
      .expect(200);

    expect(deleted.body).toMatchObject({
      deleted: true,
      room: { id: deletedRoom.id, title: "Delete me" }
    });
    await request(application)
      .get(`/api/v1/rooms/${deletedRoom.id}`)
      .expect(404);
    const listed = await request(application)
      .get("/api/v1/rooms")
      .expect(200);
    expect(listed.body.rooms).toMatchObject([
      { id: remainingRoom.id, title: "Keep me" }
    ]);
    store.close();
  });

  it("interrupts an active generation before deleting its room", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const provider = new AbortableGenerationProvider();
    const application = createHttpApplication({
      store,
      providers: new Map([["openrouter", provider]]),
      automaticScheduling: false
    });
    const room = store.createRoom({ title: "Delete while speaking" });
    const agent = {
      id: "systems",
      name: "Systems Engineer",
      description: "Finds durable architectural seams.",
      provider: "openrouter" as const,
      modelId: "fixture/model",
      systemPrompt: "Advance the design with concrete architecture.",
      temperature: 0.5,
      maxOutputTokens: 600,
      reasoning: { enabled: true, displayMode: "summary" as const },
      tools: [],
      contextBudget: {
        softLimitTokens: 12_000,
        hardLimitTokens: 16_000,
        recentTranscriptTokens: 8_000,
        retrievedContextTokens: 2_000,
        notebookTokens: 0
      }
    };
    store.addAgent(room.id, agent);

    const speaking = request(application)
      .post(`/api/v1/rooms/${room.id}/speakers/${agent.id}`)
      .send({})
      .then(response => response);
    await provider.started;
    const deleted = await request(application)
      .delete(`/api/v1/rooms/${room.id}`);
    const interrupted = await speaking;

    expect(deleted.status).toBe(200);
    expect(interrupted.status).toBe(201);
    expect(interrupted.body.generation.status).toBe("interrupted");
    await request(application).get(`/api/v1/rooms/${room.id}`).expect(404);
    store.close();
  });
});
