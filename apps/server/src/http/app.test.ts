import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ModelCapabilities,
  NormalizedChatRequest,
  NormalizedGenerationEvent
} from "@writers-room/contracts";
import { createDefaultVoiceConfiguration } from "@writers-room/contracts";
import { createHttpApplication } from "./app.js";
import type { ModelProvider, ModelDescriptor } from "../providers/model-provider.js";
import { ProviderConnectionManager } from "../providers/provider-connections.js";
import { RoomStore } from "../storage/room-store.js";
import { WorkspaceService } from "../workspace/workspace-service.js";

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

  async getCapabilities(_modelId = ""): Promise<ModelCapabilities | undefined> {
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

class ModelSwitchFixtureProvider extends FixtureProvider {
  override async getCapabilities(modelId = ""): Promise<ModelCapabilities | undefined> {
    const base = await super.getCapabilities(modelId);
    if (!base) return undefined;
    return modelId === "alternate/text"
      ? {
          ...base,
          contextLength: 128_000,
          toolCalling: false,
          structuredOutput: false,
          reasoningInputControl: false,
          reasoningOutput: false
        }
      : base;
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

class UnstructuredAutoReplyProvider implements ModelProvider {
  readonly id = "openrouter";
  activationRequest?: NormalizedChatRequest;

  async listModels(): Promise<ModelDescriptor[]> {
    return [{
      id: "fixture/unstructured",
      name: "Unstructured fixture",
      capabilities: {
        contextLength: 32_000,
        textInput: true,
        imageInput: false,
        pdfInput: false,
        toolCalling: false,
        structuredOutput: false,
        reasoningInputControl: false,
        reasoningOutput: false,
        promptCaching: false
      }
    }];
  }

  async getCapabilities(): Promise<ModelCapabilities> {
    return (await this.listModels())[0]!.capabilities;
  }

  async *streamChat(
    request: NormalizedChatRequest
  ): AsyncIterable<NormalizedGenerationEvent> {
    if (request.sessionId.endsWith(":activation")) {
      this.activationRequest = request;
      if (request.structuredOutput !== undefined) {
        throw new Error("This model does not support structured output");
      }
      yield {
        type: "text-delta",
        text: JSON.stringify({
          shouldRespond: true,
          urgency: 0.2,
          confidence: 0.2,
          intendedMove: "extend",
          reason: "Useful contribution"
        })
      };
      yield { type: "done", finishReason: "stop" };
      return;
    }
    yield { type: "text-delta", text: "Automatic response." };
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
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local HTTP room seam", () => {
  it("keeps the PSFN provider hidden unless its feature flag is enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const providers = new Map<string, ModelProvider>();
    const application = createHttpApplication({ store, providers });

    const settings = await request(application)
      .get("/api/v1/settings/providers")
      .expect(200);
    expect(settings.body.providers.some((provider: { provider: string }) =>
      provider.provider === "psfn"
    )).toBe(false);
    await request(application)
      .put("/api/v1/settings/providers/psfn")
      .send({ baseUrl: "https://companion.example.invalid/v1" })
      .expect(404);
    store.close();
  });

  it("tests and pins an enabled PSFN identity without sending a chat turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/identity")) {
        return new Response(JSON.stringify({
          object: "psfn.identity",
          companion: { id: "remote-companion", name: "Remote Companion" }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [{ id: "remote-companion", owned_by: "psfn" }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected PSFN request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const providers = new Map<string, ModelProvider>();
    const providerConnections = new ProviderConnectionManager(store, providers, {
      PSFN_PROVIDER_ENABLED: "true"
    });
    const application = createHttpApplication({
      store,
      providers,
      providerConnections
    });

    const saved = await request(application)
      .put("/api/v1/settings/providers/psfn")
      .send({
        baseUrl: "https://companion.example.invalid",
        apiKey: "psfn-test-bearer",
        sessionMode: "fixed",
        contextLength: 65_536
      })
      .expect(200);
    expect(saved.body.provider).toMatchObject({
      provider: "psfn",
      configured: true,
      hasApiKey: true,
      sessionMode: "fixed",
      connectionState: "connected",
      expectedCompanionId: "remote-companion",
      remoteCompanionId: "remote-companion",
      remoteCompanionName: "Remote Companion"
    });
    expect(JSON.stringify(saved.body)).not.toContain("psfn-test-bearer");
    expect(store.listVoiceTemplates()).toContainEqual(expect.objectContaining({
      provider: "psfn",
      modelId: "remote-companion",
      name: "Remote Companion",
      systemPrompt: ""
    }));

    const tested = await request(application)
      .post("/api/v1/settings/providers/psfn/test")
      .send({})
      .expect(200);
    expect(tested.body.provider).toMatchObject({
      connectionState: "connected",
      expectedCompanionId: "remote-companion",
      remoteCompanionId: "remote-companion",
      remoteCompanionName: "Remote Companion"
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.some(([input]) =>
      String(input).includes("chat/completions")
    )).toBe(false);
    expect(store.listVoiceTemplates().filter(template =>
      template.provider === "psfn" && template.modelId === "remote-companion"
    )).toHaveLength(1);
    expect(store.listProviderConnectionConfigurations()).toContainEqual(
      expect.objectContaining({
        provider: "psfn",
        expectedCompanionId: "remote-companion"
      })
    );
    await request(application)
      .put("/api/v1/settings/default-model")
      .send({ provider: "psfn", modelId: "remote-companion" })
      .expect(400);

    const firstRoom = store.createRoom({ title: "First fixed room" });
    const secondRoom = store.createRoom({ title: "Second fixed room" });
    const remoteVoice = (id: string) => ({
      id,
      name: "Remote Companion",
      description: "Stateful PSFN participant",
      provider: "psfn" as const,
      modelId: "remote-companion",
      systemPrompt: "",
      ...createDefaultVoiceConfiguration()
    });
    await request(application)
      .post(`/api/v1/rooms/${firstRoom.id}/agents`)
      .send(remoteVoice("remote-one"))
      .expect(201);
    await request(application)
      .post(`/api/v1/rooms/${secondRoom.id}/agents`)
      .send(remoteVoice("remote-two"))
      .expect(409);
    await request(application)
      .post(`/api/v1/rooms/${secondRoom.id}/agents`)
      .send({ ...remoteVoice("remote-two"), confirmSharedPsfnSession: true })
      .expect(201);
    store.close();
  });

  it("detects and explicitly accepts a changed PSFN identity on the same endpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    let companionId = "first-companion";
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/identity")) {
        return Response.json({
          object: "psfn.identity",
          companion: { id: companionId, name: companionId }
        });
      }
      if (url.endsWith("/models")) {
        return Response.json({ data: [{ id: `${companionId}-model` }] });
      }
      throw new Error(`Unexpected PSFN request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const providers = new Map<string, ModelProvider>();
    const providerConnections = new ProviderConnectionManager(store, providers, {
      PSFN_PROVIDER_ENABLED: "true"
    });
    const application = createHttpApplication({
      store,
      providers,
      providerConnections
    });

    await request(application)
      .put("/api/v1/settings/providers/psfn")
      .send({ baseUrl: "https://stable.example.invalid" })
      .expect(200);
    const room = store.createRoom({ title: "Identity migration room" });
    store.addAgent(room.id, {
      id: "remote",
      voiceTemplateId: store.listVoiceTemplates()[0]!.id,
      name: "First Companion",
      description: "Remote participant",
      provider: "psfn",
      modelId: "first-companion-model",
      systemPrompt: "",
      personaPrompt: "",
      ...createDefaultVoiceConfiguration()
    });
    store.beginPsfnDelivery({
      roomId: room.id,
      agentId: "remote",
      remoteCompanionId: "first-companion",
      sessionMode: "header",
      sessionKey: "writers-room:identity-migration:remote:v1",
      deliveryId: "completed-delivery",
      highSequence: 0,
      envelopeDigest: "a".repeat(64)
    });
    store.completePsfnDelivery(room.id, "remote", "completed-delivery");
    companionId = "second-companion";

    await request(application)
      .post("/api/v1/settings/providers/psfn/test")
      .send({})
      .expect(409);
    const drifted = await request(application)
      .get("/api/v1/settings/providers")
      .expect(200);
    expect(drifted.body.providers).toContainEqual(expect.objectContaining({
      provider: "psfn",
      expectedCompanionId: "first-companion",
      remoteCompanionId: "second-companion",
      connectionState: "identity-drift"
    }));

    const accepted = await request(application)
      .post("/api/v1/settings/providers/psfn/test")
      .send({ acceptIdentityChange: true })
      .expect(200);
    expect(accepted.body.provider).toMatchObject({
      expectedCompanionId: "second-companion",
      remoteCompanionId: "second-companion",
      connectionState: "connected"
    });
    expect(store.listProviderConnectionConfigurations()).toContainEqual(
      expect.objectContaining({
        provider: "psfn",
        expectedCompanionId: "second-companion"
      })
    );
    expect(store.getPsfnDeliveryState(room.id, "remote")).toBeUndefined();
    expect(store.getRoomAgent(room.id, "remote").modelId)
      .toBe("second-companion-model");
    expect(store.getRoomAgent(room.id, "remote").name).toBe("second-companion");
    expect(store.listVoiceTemplates().filter(template =>
      template.provider === "psfn"
    )).toMatchObject([{
      modelId: "second-companion-model",
      name: "second-companion"
    }]);

    store.beginPsfnDelivery({
      roomId: room.id,
      agentId: "remote",
      remoteCompanionId: "second-companion",
      sessionMode: "header",
      sessionKey: "writers-room:identity-migration:remote:v2",
      deliveryId: "ambiguous-second-delivery",
      highSequence: 0,
      envelopeDigest: "b".repeat(64),
      envelope: "Exact second-companion envelope"
    });
    store.markPsfnDeliveryAmbiguous(
      room.id,
      "remote",
      "ambiguous-second-delivery"
    );
    companionId = "third-companion";
    await request(application)
      .put("/api/v1/settings/providers/psfn")
      .send({
        baseUrl: "https://stable.example.invalid",
        expectedCompanionId: "third-companion"
      })
      .expect(409);
    expect(store.listProviderConnectionConfigurations()).toContainEqual(
      expect.objectContaining({ expectedCompanionId: "second-companion" })
    );
    expect(store.getPsfnDeliveryState(room.id, "remote")).toMatchObject({
      remoteCompanionId: "second-companion",
      deliveryStatus: "ambiguous",
      inflightEnvelope: "Exact second-companion envelope"
    });

    store.resolvePsfnDelivery(room.id, "remote", "assume-delivered");
    const directlySaved = await request(application)
      .put("/api/v1/settings/providers/psfn")
      .send({
        baseUrl: "https://stable.example.invalid",
        expectedCompanionId: "third-companion"
      })
      .expect(200);
    expect(directlySaved.body.provider).toMatchObject({
      expectedCompanionId: "third-companion",
      remoteCompanionId: "third-companion",
      connectionState: "connected"
    });
    expect(store.getPsfnDeliveryState(room.id, "remote")).toBeUndefined();
    expect(store.getRoomAgent(room.id, "remote")).toMatchObject({
      modelId: "third-companion-model",
      name: "third-companion"
    });
    expect(store.listVoiceTemplates().filter(template =>
      template.provider === "psfn"
    )).toMatchObject([{
      modelId: "third-companion-model",
      name: "third-companion"
    }]);
    store.close();
  });

  it("clips a long remote PSFN display name only for local voice fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const longName = "Remote Companion ".repeat(12).trim();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/identity")) {
        return Response.json({
          object: "psfn.identity",
          companion: { id: "long-name-companion", name: longName }
        });
      }
      if (url.endsWith("/models")) {
        return Response.json({ data: [{ id: "long-name-model" }] });
      }
      throw new Error(`Unexpected PSFN request: ${url}`);
    }));
    const providers = new Map<string, ModelProvider>();
    const providerConnections = new ProviderConnectionManager(store, providers, {
      PSFN_PROVIDER_ENABLED: "true"
    });
    const application = createHttpApplication({
      store,
      providers,
      providerConnections
    });

    const saved = await request(application)
      .put("/api/v1/settings/providers/psfn")
      .send({ baseUrl: "https://long-name.example.invalid" })
      .expect(200);

    expect(saved.body.provider.remoteCompanionName).toBe(longName);
    const template = store.listVoiceTemplates()[0]!;
    expect(template.name).toHaveLength(80);
    expect(longName.startsWith(template.name)).toBe(true);
    expect(template.modelId).toBe("long-name-model");
    store.close();
  });

  it("guards and migrates identity acceptance when the previous PSFN pin exists only in the environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const template = store.createVoiceTemplate({
      ...createDefaultVoiceConfiguration(),
      title: "PSFN — Environment Old",
      name: "Environment Old",
      description: "Stateful PSFN companion with remotely owned persona, memory, prompt, and faculties.",
      provider: "psfn",
      modelId: "environment-old-model",
      systemPrompt: "",
      personaPrompt: "",
      reasoning: { enabled: false, displayMode: "hidden" },
      tools: []
    });
    const room = store.createRoom({ title: "Environment identity migration" });
    store.addAgent(room.id, {
      id: "environment-remote",
      voiceTemplateId: template.id,
      name: template.name,
      description: template.description,
      provider: "psfn",
      modelId: template.modelId,
      systemPrompt: "",
      personaPrompt: "",
      ...createDefaultVoiceConfiguration()
    });
    store.beginPsfnDelivery({
      roomId: room.id,
      agentId: "environment-remote",
      remoteCompanionId: "environment-old",
      sessionMode: "header",
      sessionKey: "writers-room:environment-identity:remote:v1",
      deliveryId: "environment-ambiguous",
      highSequence: 0,
      envelopeDigest: "c".repeat(64),
      envelope: "Environment-pinned exact envelope"
    });
    store.markPsfnDeliveryAmbiguous(
      room.id,
      "environment-remote",
      "environment-ambiguous"
    );
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/identity")) {
        return Response.json({
          object: "psfn.identity",
          companion: { id: "environment-new", name: "Environment New" }
        });
      }
      if (url.endsWith("/models")) {
        return Response.json({ data: [{ id: "environment-new-model" }] });
      }
      throw new Error(`Unexpected PSFN request: ${url}`);
    }));
    const providers = new Map<string, ModelProvider>();
    const providerConnections = new ProviderConnectionManager(store, providers, {
      PSFN_PROVIDER_ENABLED: "true",
      PSFN_BASE_URL: "https://environment-pin.example.invalid/v1",
      PSFN_EXPECTED_COMPANION_ID: "environment-old"
    });
    const application = createHttpApplication({
      store,
      providers,
      providerConnections
    });

    await request(application)
      .post("/api/v1/settings/providers/psfn/test")
      .send({ acceptIdentityChange: true })
      .expect(409);
    expect(store.listProviderConnectionConfigurations()).toEqual([]);
    expect(store.getPsfnDeliveryState(room.id, "environment-remote")).toMatchObject({
      remoteCompanionId: "environment-old",
      deliveryStatus: "ambiguous",
      inflightEnvelope: "Environment-pinned exact envelope"
    });

    store.resolvePsfnDelivery(room.id, "environment-remote", "assume-delivered");
    const accepted = await request(application)
      .post("/api/v1/settings/providers/psfn/test")
      .send({ acceptIdentityChange: true })
      .expect(200);
    expect(accepted.body.provider).toMatchObject({
      expectedCompanionId: "environment-new",
      remoteCompanionId: "environment-new",
      connectionState: "connected"
    });
    expect(store.getPsfnDeliveryState(room.id, "environment-remote"))
      .toBeUndefined();
    expect(store.getRoomAgent(room.id, "environment-remote")).toMatchObject({
      modelId: "environment-new-model",
      name: "Environment New"
    });
    expect(store.getVoiceTemplate(template.id)).toMatchObject({
      modelId: "environment-new-model",
      name: "Environment New"
    });
    store.close();
  });

  it("keeps the working PSFN connection when a replacement fails its pinned identity handshake", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const replacement = url.hostname.startsWith("replacement");
      if (url.pathname.endsWith("/identity")) {
        return Response.json({
          object: "psfn.identity",
          companion: {
            id: replacement ? "unexpected-companion" : "original-companion",
            name: replacement ? "Unexpected Companion" : "Original Companion"
          }
        });
      }
      if (url.pathname.endsWith("/models")) {
        return Response.json({
          data: [{ id: replacement ? "unexpected-companion" : "original-companion" }]
        });
      }
      throw new Error(`Unexpected PSFN request: ${url.toString()}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const providers = new Map<string, ModelProvider>();
    const providerConnections = new ProviderConnectionManager(store, providers, {
      PSFN_PROVIDER_ENABLED: "true"
    });
    const application = createHttpApplication({
      store,
      providers,
      providerConnections
    });

    await request(application)
      .put("/api/v1/settings/providers/psfn")
      .send({
        baseUrl: "https://original.example.invalid",
        apiKey: "original-test-credential",
        sessionMode: "header"
      })
      .expect(200);
    const workingProvider = providers.get("psfn");

    await request(application)
      .put("/api/v1/settings/providers/psfn")
      .send({ baseUrl: "https://replacement.example.invalid" })
      .expect(409);

    const status = await request(application)
      .get("/api/v1/settings/providers")
      .expect(200);
    expect(status.body.providers).toContainEqual(expect.objectContaining({
      provider: "psfn",
      baseUrl: "https://original.example.invalid/v1",
      expectedCompanionId: "original-companion",
      connectionState: "connected"
    }));
    expect(providers.get("psfn")).toBe(workingProvider);
    expect(store.listProviderConnectionConfigurations()).toContainEqual(
      expect.objectContaining({
        provider: "psfn",
        baseUrl: "https://original.example.invalid/v1",
        expectedCompanionId: "original-companion"
      })
    );
    store.close();
  });

  it("retains an environment PSFN credential across canonically equivalent endpoint spelling", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization"))
        .toBe("Bearer environment-test-credential");
      const url = String(input);
      if (url.endsWith("/identity")) {
        return Response.json({
          object: "psfn.identity",
          companion: { id: "environment-companion", name: "Environment Companion" }
        });
      }
      if (url.endsWith("/models")) {
        return Response.json({ data: [{ id: "environment-companion" }] });
      }
      throw new Error(`Unexpected PSFN request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const providers = new Map<string, ModelProvider>();
    const providerConnections = new ProviderConnectionManager(store, providers, {
      PSFN_PROVIDER_ENABLED: "true",
      PSFN_BASE_URL: "https://environment.example.invalid/v1",
      PSFN_API_KEY: "environment-test-credential"
    });
    const application = createHttpApplication({
      store,
      providers,
      providerConnections
    });

    const saved = await request(application)
      .put("/api/v1/settings/providers/psfn")
      .send({ baseUrl: "https://environment.example.invalid" })
      .expect(200);

    expect(saved.body.provider).toMatchObject({
      provider: "psfn",
      baseUrl: "https://environment.example.invalid/v1",
      hasApiKey: true,
      credentialSource: "environment",
      connectionState: "connected"
    });
    expect(store.listProviderConnectionConfigurations()).toContainEqual(
      expect.not.objectContaining({ apiKey: expect.anything() })
    );
    store.close();
  });

  it("configures an OpenAI-compatible provider without exposing its key", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const databasePath = join(root, "room.db");
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer local-secret");
      return new Response(JSON.stringify({
        data: [{ id: "local/test-model", name: "Local test model" }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const firstStore = new RoomStore(databasePath);
    const firstProviders = new Map<string, ModelProvider>();
    const firstApplication = createHttpApplication({
      store: firstStore,
      providers: firstProviders
    });

    const unconfigured = await request(firstApplication)
      .get("/api/v1/providers/openai-compatible/models")
      .expect(409);
    expect(unconfigured.body.error).toContain(
      "Settings → Providers & models"
    );

    const saved = await request(firstApplication)
      .put("/api/v1/settings/providers/openai-compatible")
      .send({
        baseUrl: "https://compatible.example/v1",
        apiKey: "local-secret"
      })
      .expect(200);
    expect(saved.body.provider).toMatchObject({
      provider: "openai-compatible",
      configured: true,
      baseUrl: "https://compatible.example/v1",
      hasApiKey: true,
      endpointSource: "settings",
      credentialSource: "settings"
    });
    expect(JSON.stringify(saved.body)).not.toContain("local-secret");

    const models = await request(firstApplication)
      .get("/api/v1/providers/openai-compatible/models")
      .expect(200);
    expect(models.body.models).toEqual([
      expect.objectContaining({ id: "local/test-model" })
    ]);
    firstStore.close();

    const reopenedStore = new RoomStore(databasePath);
    const reopenedProviders = new Map<string, ModelProvider>();
    const reopenedApplication = createHttpApplication({
      store: reopenedStore,
      providers: reopenedProviders
    });
    const settings = await request(reopenedApplication)
      .get("/api/v1/settings/providers")
      .expect(200);
    expect(settings.body.providers).toContainEqual(saved.body.provider);
    expect(JSON.stringify(settings.body)).not.toContain("local-secret");
    await request(reopenedApplication)
      .get("/api/v1/providers/openai-compatible/models")
      .expect(200);
    reopenedStore.close();
  });

  it("does not carry a credential to a different compatible endpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const providers = new Map<string, ModelProvider>();
    const providerConnections = new ProviderConnectionManager(store, providers, {
      OPENAI_COMPATIBLE_BASE_URL: "https://first.example/v1",
      OPENAI_COMPATIBLE_API_KEY: "first-endpoint-secret"
    });
    const application = createHttpApplication({
      store,
      providers,
      providerConnections
    });

    const saved = await request(application)
      .put("/api/v1/settings/providers/openai-compatible")
      .send({ baseUrl: "https://second.example/v1" })
      .expect(200);
    expect(saved.body.provider).toMatchObject({
      baseUrl: "https://second.example/v1",
      hasApiKey: false,
      endpointSource: "settings",
      credentialSource: "none"
    });
    await request(application)
      .get("/api/v1/providers/openai-compatible/models")
      .expect(200);
    store.close();
  });

  it("reports an Ollama environment key as environment configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const providers = new Map<string, ModelProvider>();
    const providerConnections = new ProviderConnectionManager(store, providers, {
      OLLAMA_API_KEY: "ollama-proxy-secret"
    });
    const application = createHttpApplication({
      store,
      providers,
      providerConnections
    });

    const settings = await request(application)
      .get("/api/v1/settings/providers")
      .expect(200);
    expect(settings.body.providers).toContainEqual(expect.objectContaining({
      provider: "ollama",
      endpointSource: "built-in",
      credentialSource: "environment",
      hasApiKey: true
    }));
    expect(JSON.stringify(settings.body)).not.toContain("ollama-proxy-secret");
    store.close();
  });

  it("preserves an injected Ollama provider until settings override it", () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const injected = new FixtureProvider();
    const providers = new Map<string, ModelProvider>([["ollama", injected]]);

    new ProviderConnectionManager(store, providers);

    expect(providers.get("ollama")).toBe(injected);
    store.close();
  });

  it("does not relay an upstream response body that echoes a provider key", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "rejected authorization: Bearer echoed-provider-secret",
      { status: 401, statusText: "echoed-provider-secret" }
    )));
    const providers = new Map<string, ModelProvider>();
    const application = createHttpApplication({ store, providers });
    await request(application)
      .put("/api/v1/settings/providers/openai-compatible")
      .send({
        baseUrl: "https://untrusted.example/v1",
        apiKey: "echoed-provider-secret"
      })
      .expect(200);

    const response = await request(application)
      .get("/api/v1/providers/openai-compatible/models")
      .expect(500);
    expect(response.body.error).toContain("401");
    expect(JSON.stringify(response.body)).not.toContain("echoed-provider-secret");
    expect(JSON.stringify(response.body)).not.toContain("rejected authorization");
    store.close();
  });

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

    const staleAgent = {
      ...added.body.agent,
      capabilities: {
        ...added.body.agent.capabilities,
        contextLength: 1
      }
    };
    store.database.prepare(
      "UPDATE agents SET definition_json = ? WHERE id = ?"
    ).run(JSON.stringify(staleAgent), staleAgent.id);
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
    const room = store.createRoom({ title: "Template deletion room" });
    await request(application)
      .post(`/api/v1/rooms/${room.id}/agents`)
      .send({
        ...created.body.template,
        id: "invalid-template-link",
        voiceTemplateId: "missing-template"
      })
      .expect(404);
    expect(store.getSnapshot(room.id).agents).toEqual([]);
    const linkedParticipant = await request(application)
      .post(`/api/v1/rooms/${room.id}/agents`)
      .send({
        ...created.body.template,
        id: "detached-after-delete",
        voiceTemplateId: templateId,
        name: "Client-supplied spoof",
        systemPrompt: "Client-supplied prompt must not replace the saved voice."
      })
      .expect(201);
    expect(linkedParticipant.body.agent).toMatchObject({
      name: "Critic",
      systemPrompt: "Challenge the draft.",
      voiceTemplateId: templateId
    });
    await request(application)
      .post(`/api/v1/rooms/${room.id}/agents`)
      .send({
        ...created.body.template,
        id: "detached-after-delete",
        voiceTemplateId: templateId
      })
      .expect(409);
    expect(store.getSnapshot(room.id).agents).toHaveLength(1);

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
    expect(store.getRoomAgent(room.id, "detached-after-delete").voiceTemplateId)
      .toBeUndefined();
    store.close();
  });

  it("propagates a linked voice template name into room participants and chat identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const application = createHttpApplication({
      store,
      providers: new Map([["openrouter", new ModelSwitchFixtureProvider()]])
    });
    const room = store.createRoom({ title: "Linked voice room" });
    const created = await request(application)
      .post("/api/v1/voice-templates")
      .send({
        title: "Linked critic",
        name: "Original Name",
        description: "A linked room voice.",
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
    const template = created.body.template;
    await request(application)
      .post(`/api/v1/rooms/${room.id}/agents`)
      .send({
        ...template,
        id: "linked-critic",
        voiceTemplateId: template.id
      })
      .expect(201);
    store.appendMessage({
      roomId: room.id,
      authorType: "agent",
      authorId: "linked-critic",
      content: "Existing message"
    });

    await request(application)
      .patch(`/api/v1/voice-templates/${template.id}`)
      .send({ name: "Renamed Voice", modelId: "alternate/text" })
      .expect(200);
    const snapshot = await request(application)
      .get(`/api/v1/rooms/${room.id}`)
      .expect(200);

    expect(snapshot.body.agents).toMatchObject([
      {
        id: "linked-critic",
        name: "Renamed Voice",
        modelId: "alternate/text",
        voiceTemplateId: template.id,
        capabilities: {
          contextLength: 128_000,
          toolCalling: false,
          structuredOutput: false
        }
      }
    ]);
    expect(snapshot.body.messages).toMatchObject([
      { authorId: "linked-critic", content: "Existing message" }
    ]);
    store.close();
  });

  it("does not link an independent voice merely because its prompt matches a template", () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const databasePath = join(root, "room.db");
    const firstStore = new RoomStore(databasePath);
    const room = firstStore.createRoom({ title: "Legacy voice room" });
    const template = firstStore.createVoiceTemplate({
      title: "Canonical reviewer",
      name: "Canonical Name",
      description: "Template-backed identity.",
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet",
      systemPrompt: "A uniquely identifying legacy system prompt.",
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
    });
    firstStore.addAgent(room.id, {
      id: "legacy-reviewer",
      name: "Stale Room Name",
      description: "",
      provider: "openrouter",
      modelId: "older/model-selection",
      systemPrompt: template.systemPrompt,
      temperature: 0.2,
      maxOutputTokens: 300,
      reasoning: { enabled: false, displayMode: "hidden" },
      tools: [],
      contextBudget: {
        softLimitTokens: 4_000,
        hardLimitTokens: 8_000,
        recentTranscriptTokens: 2_000,
        retrievedContextTokens: 1_000,
        notebookTokens: 0
      }
    });
    firstStore.close();

    const reopenedStore = new RoomStore(databasePath);
    expect(reopenedStore.getRoomAgent(room.id, "legacy-reviewer")).toMatchObject({
      name: "Stale Room Name",
      modelId: "older/model-selection",
      maxOutputTokens: 300
    });
    expect(reopenedStore.getRoomAgent(room.id, "legacy-reviewer").voiceTemplateId)
      .toBeUndefined();
    reopenedStore.updateVoiceTemplate(template.id, { name: "Another Template Name" });
    expect(reopenedStore.getRoomAgent(room.id, "legacy-reviewer")).toMatchObject({
      name: "Stale Room Name",
      systemPrompt: template.systemPrompt
    });
    expect(reopenedStore.getRoomAgent(room.id, "legacy-reviewer").voiceTemplateId)
      .toBeUndefined();
    reopenedStore.close();
  });

  it("resets chat while retaining participants, artifacts, notes, and room settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const workspace = new WorkspaceService({
      store,
      dataRoot: root,
      embeddings: {
        dimensions: 2,
        embedDocuments: async texts => texts.map(() => new Float32Array([1, 0])),
        embedQuery: async () => new Float32Array([1, 0])
      },
      housekeeping: {
        summarize: async () => ({ summary: "Persistent test evidence." })
      }
    });
    const application = createHttpApplication({
      store,
      workspace,
      providers: new Map([["openrouter", new FixtureProvider()]])
    });
    const room = store.createRoom({
      title: "Resettable room",
      settings: { maxResponders: 2 }
    });
    await request(application)
      .post(`/api/v1/rooms/${room.id}/agents`)
      .send({
        id: "reset-voice",
        name: "Reset Voice",
        description: "Survives transcript resets.",
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet",
        systemPrompt: "Answer directly.",
        temperature: 0.5,
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
    await workspace.ingest({
      roomId: room.id,
      filename: "keep.md",
      mediaType: "text/markdown",
      bytes: Buffer.from("# Keep me\nThis artifact survives chat reset.")
    });
    store.appendNote({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      text: "Keep this note"
    });
    const human = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "Temporary transcript"
    });
    await request(application)
      .post(`/api/v1/rooms/${room.id}/speakers/reset-voice`)
      .send({ targetMessageId: human.id })
      .expect(201);
    const transcriptBeforeReset = store.listMessages(room.id);
    const lastBeforeReset = transcriptBeforeReset.at(-1)!;
    store.createConversationEpisode({
      roomId: room.id,
      firstMessageId: human.id,
      lastMessageId: lastBeforeReset.id,
      firstSequence: human.sequence,
      lastSequence: lastBeforeReset.sequence,
      title: "Temporary episode",
      summary: "This rolling episode should be cleared with the chat.",
      tokenCount: 12,
      sourceTokenCount: 24
    });
    store.updateRuntime(room.id, "reset-voice", {
      fatigue: 0.8,
      activation: 0.7,
      consecutiveTurns: 3
    });

    await request(application)
      .post(`/api/v1/rooms/${room.id}/chat/reset`)
      .send({})
      .expect(200);
    const snapshot = store.getSnapshot(room.id);

    expect(snapshot.messages).toEqual([]);
    expect(snapshot.generations).toEqual([]);
    expect(snapshot.episodes).toEqual([]);
    expect(snapshot.activations).toEqual([]);
    expect(snapshot.agents).toMatchObject([{ id: "reset-voice" }]);
    expect(snapshot.artifacts).toMatchObject([{ filename: "keep.md" }]);
    expect(snapshot.notes).toMatchObject([{ text: "Keep this note" }]);
    expect(snapshot.room.settings.maxResponders).toBe(2);
    expect(snapshot.runtime).toMatchObject([{
      agentId: "reset-voice",
      fatigue: 0,
      activation: 0,
      consecutiveTurns: 0
    }]);
    await workspace.waitForEnrichment();
    store.close();
  });

  it("skips credential-like files during repository directory ingestion", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-repo-safety-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const workspace = new WorkspaceService({
      store,
      dataRoot: root,
      embeddings: {
        dimensions: 2,
        embedDocuments: async texts => texts.map(() => new Float32Array([1, 0])),
        embedQuery: async () => new Float32Array([1, 0])
      },
      housekeeping: { summarize: async () => ({ summary: "Repository file." }) }
    });
    const application = createHttpApplication({
      store,
      workspace,
      providers: new Map([["openrouter", new FixtureProvider()]])
    });
    const room = store.createRoom({ title: "Safe repository room" });

    const response = await request(application)
      .post(`/api/v1/rooms/${room.id}/repositories`)
      .field("paths", JSON.stringify([".env", ".git/config", "src/okay.ts"]))
      .attach("files", Buffer.from("credential fixture intentionally redacted"), {
        filename: ".env",
        contentType: "text/plain"
      })
      .attach("files", Buffer.from("[remote \"origin\"]\nurl=https://token@example.test/repo"), {
        filename: "config",
        contentType: "text/plain"
      })
      .attach("files", Buffer.from("export const safe = true;"), {
        filename: "okay.ts",
        contentType: "text/typescript"
      })
      .expect(201);

    expect(response.body.artifacts).toMatchObject([{
      filename: "src/okay.ts",
      sourceType: "repository"
    }]);
    expect(response.body.failures).toMatchObject([
      {
        path: ".env",
        error: expect.stringMatching(/credential|secret/i)
      },
      {
        path: ".git/config",
        error: expect.stringMatching(/credential|secret/i)
      }
    ]);
    expect(workspace.listArtifacts(room.id).map(artifact => artifact.filename))
      .toEqual(["src/okay.ts"]);
    store.close();
  });

  it("manages a voice-template reference library and inherits it into new rooms", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-voice-library-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const workspace = new WorkspaceService({
      store,
      dataRoot: root,
      embeddings: {
        dimensions: 2,
        embedDocuments: async texts => texts.map(() => new Float32Array([1, 0])),
        embedQuery: async () => new Float32Array([1, 0])
      },
      housekeeping: { summarize: async () => ({ summary: "Voice reference." }) }
    });
    const application = createHttpApplication({
      store,
      workspace,
      providers: new Map([["openrouter", new FixtureProvider()]])
    });
    const template = store.createVoiceTemplate({
      title: "Grounded architect",
      name: "Architect",
      description: "Uses private interviews.",
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet",
      systemPrompt: "Ground claims in the private reference library.",
      temperature: 0.5,
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
    });
    const firstRoom = store.createRoom({ title: "First library room" });
    await request(application)
      .post(`/api/v1/rooms/${firstRoom.id}/agents`)
      .send({ ...template, id: "architect-one", voiceTemplateId: template.id })
      .expect(201);

    const uploaded = await request(application)
      .post(`/api/v1/voice-templates/${template.id}/library`)
      .attach(
        "file",
        Buffer.from("# Interview\nFailure modes are design inputs."),
        { filename: "architect-interview.md", contentType: "text/markdown" }
      )
      .expect(201);
    expect(uploaded.body.failures).toEqual([]);
    expect(uploaded.body.item).toMatchObject({
      voiceTemplateId: template.id,
      filename: "architect-interview.md"
    });
    expect(workspace.listArtifacts(firstRoom.id)).toMatchObject([{
      ownerAgentId: "architect-one",
      sourceType: "persona-memory",
      voiceTemplateLibraryItemId: uploaded.body.item.id
    }]);
    const managedArtifact = workspace.listArtifacts(firstRoom.id)[0]!;
    const blockedDelete = await request(application)
      .delete(`/api/v1/rooms/${firstRoom.id}/artifacts/${managedArtifact.id}`)
      .expect(409);
    expect(blockedDelete.body.error).toMatch(/Voice Settings/i);
    expect(workspace.listArtifacts(firstRoom.id)).toHaveLength(1);

    const secondRoom = store.createRoom({ title: "Second library room" });
    const inherited = await request(application)
      .post(`/api/v1/rooms/${secondRoom.id}/agents`)
      .send({ ...template, id: "architect-two", voiceTemplateId: template.id })
      .expect(201);
    expect(inherited.body.libraryFailures).toEqual([]);
    expect(workspace.listArtifacts(secondRoom.id)).toMatchObject([{
      ownerAgentId: "architect-two",
      voiceTemplateLibraryItemId: uploaded.body.item.id
    }]);
    expect((await request(application)
      .get(`/api/v1/voice-templates/${template.id}/library`)
      .expect(200)).body.items).toHaveLength(1);

    const originalIngest = workspace.ingest.bind(workspace);
    let retryCalls = 0;
    const retrySpy = vi.spyOn(workspace, "ingest").mockImplementation(async input => {
      retryCalls += 1;
      if (retryCalls === 2) {
        return originalIngest({
          ...input,
          filename: "forced-retry-failure.bin",
          mediaType: "application/octet-stream"
        });
      }
      return originalIngest(input);
    });
    const rejectedRetry = await request(application)
      .post(`/api/v1/voice-templates/${template.id}/library`)
      .attach(
        "file",
        Buffer.from("# Interview\nFailure modes are design inputs."),
        { filename: "architect-interview.md", contentType: "text/markdown" }
      )
      .expect(500);
    retrySpy.mockRestore();
    expect(rejectedRetry.body.error).toMatch(/is saved/i);
    expect(store.listVoiceTemplateLibraryItems(template.id)).toHaveLength(1);
    expect(workspace.listArtifacts(firstRoom.id)).toHaveLength(1);
    expect(workspace.listArtifacts(secondRoom.id)).toHaveLength(1);

    let materializationCalls = 0;
    const ingestSpy = vi.spyOn(workspace, "ingest").mockImplementation(async input => {
      materializationCalls += 1;
      if (materializationCalls === 2) {
        return originalIngest({
          ...input,
          filename: "forced-failure.bin",
          mediaType: "application/octet-stream"
        });
      }
      return originalIngest(input);
    });
    const rejectedUpload = await request(application)
      .post(`/api/v1/voice-templates/${template.id}/library`)
      .attach(
        "file",
        Buffer.from("This source must be attached everywhere or nowhere."),
        { filename: "atomic-reference.txt", contentType: "text/plain" }
      )
      .expect(500);
    ingestSpy.mockRestore();
    expect(rejectedUpload.body.error).toMatch(/not saved/i);
    expect(store.listVoiceTemplateLibraryItems(template.id)).toHaveLength(1);
    expect(workspace.listArtifacts(firstRoom.id).some(
      artifact => artifact.filename === "atomic-reference.txt"
    )).toBe(false);
    expect(workspace.listArtifacts(secondRoom.id).some(
      artifact => artifact.voiceTemplateLibraryItemId !== uploaded.body.item.id
    )).toBe(false);

    await request(application)
      .delete(`/api/v1/voice-templates/${template.id}/library/${uploaded.body.item.id}`)
      .expect(200);
    expect(store.listVoiceTemplateLibraryItems(template.id)).toEqual([]);
    expect(workspace.listArtifacts(firstRoom.id)).toEqual([]);
    expect(workspace.listArtifacts(secondRoom.id)).toEqual([]);
    store.close();
  });

  it("auto-replies through a model that does not support structured output", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-auto-unstructured-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const provider = new UnstructuredAutoReplyProvider();
    const application = createHttpApplication({
      store,
      providers: new Map([[provider.id, provider]])
    });
    const room = store.createRoom({
      title: "Unstructured activation room",
      settings: {
        maxResponders: 1,
        maxAutonomousWaves: 1,
        maxAutonomousReplies: 1
      }
    });
    await request(application)
      .post(`/api/v1/rooms/${room.id}/agents`)
      .send({
        id: "plain-json-voice",
        name: "Plain JSON Voice",
        description: "Contributes without provider-enforced schemas.",
        provider: "openrouter",
        modelId: "fixture/unstructured",
        systemPrompt: "Advance the discussion.",
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
      })
      .expect(201);

    await request(application)
      .post(`/api/v1/rooms/${room.id}/messages`)
      .send({ content: "Offer one useful thought." })
      .expect(201);

    await vi.waitFor(() => {
      expect(store.listMessages(room.id).map(message => message.content)).toEqual([
        "Offer one useful thought.",
        "Automatic response."
      ]);
    });
    expect(provider.activationRequest?.structuredOutput).toBeUndefined();
    expect(store.getSnapshot(room.id).activations).toMatchObject([{
      decision: { shouldRespond: true }
    }]);
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
    const thirdRoom = store.createRoom({ title: "Third room" });
    expect(() => store.addAgent(thirdRoom.id, {
      ...agent,
      name: "Different voice reusing the ID"
    })).toThrow(/already used/i);

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

  it("fences participant removal against a generation waiting for admission", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-http-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const provider = new DeferredCapabilitiesProvider();
    const application = createHttpApplication({
      store,
      providers: new Map([["openrouter", provider]])
    });
    const room = store.createRoom({ title: "Removal fence" });
    const agent = {
      id: "waiting-agent",
      name: "Waiting Agent",
      description: "Waits during capability discovery.",
      provider: "openrouter" as const,
      modelId: "fixture/model",
      systemPrompt: "Respond.",
      temperature: 0.5,
      maxOutputTokens: 600,
      reasoning: { enabled: false, displayMode: "hidden" as const },
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
    store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "Start while removal is requested."
    });

    const pendingGeneration = request(application)
      .post(`/api/v1/rooms/${room.id}/speakers/${agent.id}`)
      .send({})
      .then(result => result);
    await provider.started;
    await request(application)
      .delete(`/api/v1/rooms/${room.id}/agents/${agent.id}`)
      .expect(200);
    provider.release();
    const generation = await pendingGeneration;

    expect(generation.status).toBe(404);
    expect(store.getSnapshot(room.id).agents).toEqual([]);
    expect(store.getSnapshot(room.id).generations).toEqual([]);
    expect(store.getSnapshot(room.id).messages.filter(message =>
      message.authorType === "agent"
    )).toEqual([]);
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
