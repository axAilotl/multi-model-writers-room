import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import multer from "multer";
import { z } from "zod";
import {
  agentDefinitionSchema,
  defaultModelSelectionSchema,
  roomSettingsSchema,
  voiceTemplateGenerationRequestSchema,
  voiceTemplateInputSchema,
  voiceTemplatePatchSchema
} from "@writers-room/contracts";
import type {
  VoiceTemplateLibraryItem,
  WorkspaceArtifact
} from "@writers-room/contracts";
import type { ModelProvider } from "../providers/model-provider.js";
import { ProviderConnectionManager } from "../providers/provider-connections.js";
import { RoomEngine } from "../room/room-engine.js";
import { ParticipantModelActivationEvaluator } from "../scheduler/activation-evaluator.js";
import { ConversationScheduler } from "../scheduler/scheduler.js";
import { RoomStore } from "../storage/room-store.js";
import type { ToolExecutor } from "../tools/room-tools.js";
import type { WorkspaceService } from "../workspace/workspace-service.js";
import { generateVoiceTemplate } from "../voices/voice-template-generator.js";

interface ApplicationOptions {
  store: RoomStore;
  providers: Map<string, ModelProvider>;
  providerConnections?: ProviderConnectionManager;
  workspace?: WorkspaceService;
  tools?: ToolExecutor;
  automaticScheduling?: boolean;
}

const createRoomSchema = z.object({
  title: z.string().trim().min(1).max(160),
  settings: roomSettingsSchema.partial().optional()
});

const createMessageSchema = z.object({
  content: z.string().trim().min(1).max(200_000),
  mentionedAgentIds: z.array(z.string()).default([]),
  attachmentIds: z.array(z.string()).default([]),
  replyToMessageId: z.string().min(1).optional()
});

const speakerSchema = z.object({
  targetMessageId: z.string().optional()
});

const VOICE_GENERATION_TIMEOUT_MS = 5 * 60_000;
const MAX_REPOSITORY_UPLOAD_BYTES = 100 * 1024 * 1024;

const repositoryUploadTotals = new WeakMap<object, number>();
const repositoryStorage: multer.StorageEngine = {
  _handleFile(request, file, callback) {
    const chunks: Buffer[] = [];
    let fileBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      file.stream.resume();
      callback(error);
    };
    file.stream.on("data", (chunk: Buffer) => {
      if (settled) return;
      const nextTotal = (repositoryUploadTotals.get(request) ?? 0) + chunk.byteLength;
      if (nextTotal > MAX_REPOSITORY_UPLOAD_BYTES) {
        fail(Object.assign(
          new Error("Repository upload exceeds 100 MB"),
          { status: 413 }
        ));
        return;
      }
      repositoryUploadTotals.set(request, nextTotal);
      fileBytes += chunk.byteLength;
      chunks.push(chunk);
    });
    file.stream.once("error", fail);
    file.stream.once("end", () => {
      if (settled) return;
      settled = true;
      callback(null, { buffer: Buffer.concat(chunks), size: fileBytes });
    });
  },
  _removeFile(_request, _file, callback) {
    callback(null);
  }
};

function repositoryPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.length > 500 ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    segments.some(segment => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid repository-relative path: ${value}`);
  }
  return normalized;
}

function assertRepositoryFileSafe(path: string, bytes: Buffer): void {
  const segments = path.toLowerCase().split("/");
  const filename = segments.at(-1)!;
  const blockedDirectories = new Set([
    ".aws", ".git", ".gnupg", ".hg", ".ssh", ".svn",
    ".next", "build", "coverage", "dist", "node_modules", "target", "vendor"
  ]);
  const blockedNames = new Set([
    ".env", ".netrc", ".npmrc", ".pypirc", "credentials",
    "credentials.json", "id_dsa", "id_ed25519", "id_rsa"
  ]);
  if (
    segments.some(segment => blockedDirectories.has(segment)) ||
    blockedNames.has(filename) ||
    filename.startsWith(".env.") ||
    /(?:^|\.)(?:key|p12|pfx)$/.test(filename) ||
    /(?:^|[._-])secrets?(?:[._-]|$)/.test(filename)
  ) {
    throw new Error("Skipped a credential or secret file");
  }
  const sample = bytes.toString("utf8");
  if (
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(sample) ||
    /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/.test(sample)
  ) {
    throw new Error("Skipped a file containing credential-like material");
  }
}

function asyncRoute(
  handler: (request: express.Request, response: express.Response) => Promise<void>
): express.RequestHandler {
  return (request, response, next) => {
    void handler(request, response).catch(next);
  };
}

export function createHttpApplication(options: ApplicationOptions): express.Express {
  const application = express();
  const providerConnections = options.providerConnections ??
    new ProviderConnectionManager(options.store, options.providers);
  const engine = new RoomEngine(options.store, options.providers, options.tools);
  const scheduler = new ConversationScheduler({
    store: options.store,
    evaluator: new ParticipantModelActivationEvaluator(options.providers),
    generator: engine
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024, files: 1 }
  });
  const repositoryUpload = multer({
    storage: repositoryStorage,
    limits: { fileSize: 10 * 1024 * 1024, files: 500, fields: 4 }
  });
  async function materializeVoiceReference(
    item: VoiceTemplateLibraryItem,
    memberships = options.store.listVoiceTemplateMemberships(item.voiceTemplateId)
  ): Promise<{
    artifacts: WorkspaceArtifact[];
    failures: Array<{ roomId: string; agentId: string; error: string }>;
  }> {
    if (!options.workspace) return { artifacts: [], failures: [] };
    const bytes = options.workspace.readReferenceBlob(item.sha256);
    const artifacts: WorkspaceArtifact[] = [];
    const failures: Array<{ roomId: string; agentId: string; error: string }> = [];
    for (const membership of memberships) {
      try {
        artifacts.push(await options.workspace.ingest({
          roomId: membership.roomId,
          filename: item.filename,
          mediaType: item.mediaType,
          bytes,
          sourceType: "persona-memory",
          ownerAgentId: membership.agentId,
          voiceTemplateLibraryItemId: item.id
        }));
      } catch (error) {
        for (const artifact of options.workspace.listArtifacts(membership.roomId)) {
          if (
            artifact.ownerAgentId === membership.agentId &&
            artifact.voiceTemplateLibraryItemId === item.id &&
            artifact.ingestionStatus === "failed"
          ) {
            options.workspace.deleteArtifact(membership.roomId, artifact.id, {
              allowTemplateManaged: true
            });
          }
        }
        failures.push({
          ...membership,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return { artifacts, failures };
  }

  async function addVoiceReference(
    templateId: string,
    file: Express.Multer.File
  ) {
    options.store.getVoiceTemplate(templateId);
    if (!options.workspace) throw new Error("Workspace service is unavailable");
    const description = await options.workspace.describeReferenceSource({
      filename: file.originalname,
      mediaType: file.mimetype,
      bytes: file.buffer
    });
    const sha256 = options.workspace.storeReferenceBlob(file.buffer);
    const existingItem = options.store.listVoiceTemplateLibraryItems(templateId)
      .find(candidate => candidate.sha256 === sha256);
    const item = existingItem ?? options.store.createVoiceTemplateLibraryItem({
        voiceTemplateId: templateId,
        filename: file.originalname,
        mediaType: file.mimetype,
        sha256,
        byteSize: file.size,
        summary: description.summary,
        ...(description.outline === undefined ? {} : { outline: description.outline })
      });
    const materialized = await materializeVoiceReference(item);
    if (materialized.failures.length > 0) {
      if (!existingItem) {
        for (const artifact of materialized.artifacts) {
          options.workspace.deleteArtifact(artifact.roomId, artifact.id, {
            allowTemplateManaged: true
          });
        }
        options.store.deleteVoiceTemplateLibraryItem(templateId, item.id);
        options.workspace.garbageCollectBlobs([item.sha256]);
      }
      const locations = materialized.failures
        .map(failure => `${failure.roomId}/${failure.agentId}: ${failure.error}`)
        .join("; ");
      throw new Error(
        `${existingItem ? "Reference is saved, but still" : "Reference was not saved because it"} ` +
        `could not be attached everywhere: ${locations}`
      );
    }
    return { item, ...materialized };
  }

  function removeVoiceReference(templateId: string, itemId: string) {
    const item = options.store.getVoiceTemplateLibraryItem(itemId);
    if (item.voiceTemplateId !== templateId) {
      throw new Error("Voice reference does not belong to this template");
    }
    if (options.workspace) {
      for (const room of options.store.listRooms()) {
        for (const artifact of options.workspace.listArtifacts(room.id)) {
          if (artifact.voiceTemplateLibraryItemId !== item.id) continue;
          options.workspace.deleteArtifact(room.id, artifact.id, {
            allowTemplateManaged: true
          });
        }
      }
    }
    const deleted = options.store.deleteVoiceTemplateLibraryItem(templateId, itemId);
    options.workspace?.garbageCollectBlobs([deleted.sha256]);
    return deleted;
  }
  application.disable("x-powered-by");
  application.use(cors({ origin: /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/ }));
  const standardJson = express.json({ limit: "2mb" });
  const largePromptJson = express.json({ limit: "16mb" });
  application.use((request, response, next) => {
    const acceptsLargePrompt =
      (request.method === "POST" && (
        request.path === "/api/v1/voice-templates" ||
        /^\/api\/v1\/rooms\/[^/]+\/agents$/.test(request.path)
      )) ||
      (request.method === "PATCH" &&
        /^\/api\/v1\/voice-templates\/[^/]+$/.test(request.path));
    (acceptsLargePrompt ? largePromptJson : standardJson)(request, response, next);
  });

  application.get("/api/v1/health", (_request, response) => {
    response.json({
      ok: true,
      database: true,
      providers: [...options.providers.keys()],
      ...(options.workspace ? { workspace: options.workspace.health() } : {})
    });
  });

  application.get("/api/v1/settings/providers", (_request, response) => {
    response.json({ providers: providerConnections.list() });
  });

  application.put(
    "/api/v1/settings/providers/:providerId",
    (request, response) => {
      response.json({
        provider: providerConnections.configure(
          String(request.params.providerId),
          request.body
        )
      });
    }
  );

  application.delete(
    "/api/v1/settings/providers/:providerId",
    (request, response) => {
      response.json({
        provider: providerConnections.remove(String(request.params.providerId))
      });
    }
  );

  application.get(
    "/api/v1/providers/:providerId/models",
    asyncRoute(async (request, response) => {
      const providerId = String(request.params.providerId);
      const provider = options.providers.get(providerId);
      if (!provider) {
        response.status(409).json({
          error: `Provider is not configured: ${providerId}. Add its endpoint and credentials under Settings → Providers & models.`
        });
        return;
      }
      const models = await provider.listModels();
      response.json({
        provider: providerId,
        models: [...models].sort((left, right) =>
          left.name.localeCompare(right.name)
        )
      });
    })
  );

  application.get("/api/v1/settings/default-model", (_request, response) => {
    response.json({ defaultModel: options.store.getDefaultModel() ?? null });
  });

  application.put(
    "/api/v1/settings/default-model",
    asyncRoute(async (request, response) => {
      const selection = defaultModelSelectionSchema.parse(request.body);
      const provider = options.providers.get(selection.provider);
      if (!provider) {
        response.status(400).json({
          error: `Provider is not configured: ${selection.provider}`
        });
        return;
      }
      const models = await provider.listModels();
      const model = models.find(candidate => candidate.id === selection.modelId);
      if (!model) {
        response.status(400).json({
          error: `Model is not available from ${selection.provider}: ${selection.modelId}`
        });
        return;
      }
      if (!model.capabilities.textInput) {
        response.status(400).json({
          error: `Model cannot accept text input: ${selection.modelId}`
        });
        return;
      }
      response.json({
        defaultModel: options.store.setDefaultModel(selection)
      });
    })
  );

  application.get("/api/v1/voice-templates", (_request, response) => {
    response.json({ templates: options.store.listVoiceTemplates() });
  });

  application.post("/api/v1/voice-templates", (request, response) => {
    const input = voiceTemplateInputSchema.parse(request.body);
    response.status(201).json({
      template: options.store.createVoiceTemplate(input)
    });
  });

  application.post(
    "/api/v1/voice-templates/generate",
    asyncRoute(async (request, response) => {
      const generationRequest = voiceTemplateGenerationRequestSchema.parse(request.body);
      const selection = options.store.getDefaultModel();
      if (!selection) {
        response.status(409).json({
          error: "Choose a default model in Settings before generating a voice"
        });
        return;
      }
      const provider = options.providers.get(selection.provider);
      if (!provider) {
        response.status(409).json({
          error: `The default provider is not configured: ${selection.provider}`
        });
        return;
      }
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, VOICE_GENERATION_TIMEOUT_MS);
      const abortDisconnectedRequest = () => {
        if (!response.writableEnded) controller.abort();
      };
      request.once("aborted", abortDisconnectedRequest);
      response.once("close", abortDisconnectedRequest);
      try {
        const template = await generateVoiceTemplate({
          request: generationRequest,
          selection,
          provider,
          signal: controller.signal
        });
        if (!controller.signal.aborted) {
          response.json({ template });
        } else if (timedOut && !response.headersSent && !response.destroyed) {
          response.status(504).json({ error: "Voice generation timed out" });
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        if (timedOut && !response.headersSent && !response.destroyed) {
          response.status(504).json({ error: "Voice generation timed out" });
        }
      } finally {
        clearTimeout(timeout);
        request.off("aborted", abortDisconnectedRequest);
        response.off("close", abortDisconnectedRequest);
      }
    })
  );

  application.patch(
    "/api/v1/voice-templates/:templateId",
    asyncRoute(async (request, response) => {
      const templateId = String(request.params.templateId);
      const patch = voiceTemplatePatchSchema.parse(request.body);
      const current = options.store.getVoiceTemplate(templateId);
      const providerChanged = patch.provider !== undefined &&
        patch.provider !== current.provider;
      const modelChanged = patch.modelId !== undefined &&
        patch.modelId !== current.modelId;
      let capabilities;
      if (providerChanged || modelChanged) {
        const providerId = patch.provider ?? current.provider;
        const modelId = patch.modelId ?? current.modelId;
        const provider = options.providers.get(providerId);
        if (!provider) {
          response.status(400).json({
            error: `Provider is not configured: ${providerId}`
          });
          return;
        }
        capabilities = await provider.getCapabilities(modelId).catch(() => undefined);
        if (!capabilities) {
          response.status(400).json({
            error: `Model capabilities are unavailable: ${modelId}`
          });
          return;
        }
        if (!capabilities.textInput) {
          response.status(400).json({
            error: `Model cannot accept text input: ${modelId}`
          });
          return;
        }
      }
      response.json({
        template: options.store.updateVoiceTemplate(templateId, patch, capabilities)
      });
    })
  );

  application.delete("/api/v1/voice-templates/:templateId", (request, response) => {
    const templateId = String(request.params.templateId);
    for (const item of options.store.listVoiceTemplateLibraryItems(templateId)) {
      removeVoiceReference(templateId, item.id);
    }
    const template = options.store.deleteVoiceTemplate(
      templateId
    );
    response.json({ deleted: true, template });
  });

  if (options.workspace) {
    application.get(
      "/api/v1/voice-templates/:templateId/library",
      (request, response) => {
        response.json({
          items: options.store.listVoiceTemplateLibraryItems(
            String(request.params.templateId)
          )
        });
      }
    );

    application.post(
      "/api/v1/voice-templates/:templateId/library",
      upload.single("file"),
      asyncRoute(async (request, response) => {
        if (!request.file) {
          response.status(400).json({ error: "A reference file is required" });
          return;
        }
        const result = await addVoiceReference(
          String(request.params.templateId),
          request.file
        );
        response.status(201).json(result);
      })
    );

    application.delete(
      "/api/v1/voice-templates/:templateId/library/:itemId",
      (request, response) => {
        const item = removeVoiceReference(
          String(request.params.templateId),
          String(request.params.itemId)
        );
        response.json({ deleted: true, item });
      }
    );
  }

  application.get("/api/v1/rooms", (_request, response) => {
    response.json({ rooms: options.store.listRooms() });
  });

  application.post("/api/v1/rooms", (request, response) => {
    const input = createRoomSchema.parse(request.body);
    const room = options.store.createRoom({
      title: input.title,
      ...(input.settings === undefined ? {} : { settings: input.settings })
    });
    response.status(201).json({ room });
  });

  application.get("/api/v1/rooms/:roomId", (request, response) => {
    response.json(options.store.getSnapshot(request.params.roomId!));
  });

  application.patch("/api/v1/rooms/:roomId", (request, response) => {
    const patch = z.object({
      title: z.string().trim().min(1).max(160).optional(),
      status: z.enum(["running", "paused"]).optional(),
      settings: roomSettingsSchema.partial().optional()
    }).parse(request.body);
    if (patch.status === "paused") engine.interruptRoom(request.params.roomId!);
    const room = options.store.updateRoom(String(request.params.roomId), {
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.settings === undefined ? {} : { settings: patch.settings })
    });
    options.store.appendRoomEvent(room.id, { type: "room.snapshot", room });
    response.json({ room });
  });

  application.delete(
    "/api/v1/rooms/:roomId",
    asyncRoute(async (request, response) => {
      const roomId = String(request.params.roomId);
      const current = options.store.getRoom(roomId);
      if (current.status !== "paused") {
        options.store.updateRoom(roomId, { status: "paused" });
      }
      await engine.interruptRoomAndWait(roomId);
      const artifactHashes = options.workspace
        ?.listArtifacts(roomId)
        .map(artifact => artifact.sha256) ?? [];
      const room = options.store.deleteRoom(roomId);
      options.workspace?.garbageCollectBlobs(artifactHashes);
      response.json({ deleted: true, room });
    })
  );

  application.post(
    "/api/v1/rooms/:roomId/chat/reset",
    asyncRoute(async (request, response) => {
      const roomId = String(request.params.roomId);
      const current = options.store.getRoom(roomId);
      const resumeAfterReset = current.status === "running";
      if (resumeAfterReset) options.store.updateRoom(roomId, { status: "paused" });
      await engine.interruptRoomAndWait(roomId);
      options.store.resetChat(roomId);
      const room = resumeAfterReset
        ? options.store.updateRoom(roomId, { status: "running" })
        : options.store.getRoom(roomId);
      options.store.appendRoomEvent(roomId, { type: "room.snapshot", room });
      response.json({ reset: true, room });
    })
  );

  application.post(
    "/api/v1/rooms/:roomId/agents",
    asyncRoute(async (request, response) => {
      const submitted = agentDefinitionSchema.parse(request.body);
      const linkedTemplate = submitted.voiceTemplateId
        ? options.store.getVoiceTemplate(submitted.voiceTemplateId)
        : undefined;
      const canonical = linkedTemplate
        ? agentDefinitionSchema.parse({
            ...submitted,
            name: linkedTemplate.name,
            description: linkedTemplate.description,
            provider: linkedTemplate.provider,
            modelId: linkedTemplate.modelId,
            systemPrompt: linkedTemplate.systemPrompt,
            personaPrompt: linkedTemplate.personaPrompt,
            temperature: linkedTemplate.temperature,
            topP: linkedTemplate.topP,
            maxOutputTokens: linkedTemplate.maxOutputTokens,
            reasoning: linkedTemplate.reasoning,
            tools: linkedTemplate.tools,
            contextBudget: linkedTemplate.contextBudget
          })
        : submitted;
      const provider = options.providers.get(canonical.provider);
      if (!provider) {
        response.status(400).json({
          error: `Provider is not configured: ${canonical.provider}`
        });
        return;
      }
      const capabilities = await provider.getCapabilities(canonical.modelId)
        .catch(() => undefined);
      if (capabilities === undefined) {
        response.status(400).json({
          error: `Model capabilities are unavailable: ${canonical.modelId}`
        });
        return;
      }
      if (!capabilities.textInput) {
        response.status(400).json({
          error: `Model cannot accept text input: ${canonical.modelId}`
        });
        return;
      }
      const { capabilities: _clientCapabilities, ...definition } = canonical;
      const agent = agentDefinitionSchema.parse({
        ...definition,
        ...(capabilities === undefined ? {} : { capabilities })
      });
      const roomId = String(request.params.roomId);
      const templateLibraryItems = agent.voiceTemplateId
        ? options.store.listVoiceTemplateLibraryItems(agent.voiceTemplateId)
        : [];
      if (templateLibraryItems.length > 0 && !options.workspace) {
        throw new Error(
          "This voice has private references, but the workspace service is unavailable"
        );
      }
      const added = options.store.addAgent(roomId, agent);
      const libraryFailures: Array<{ roomId: string; agentId: string; error: string }> = [];
      if (added.voiceTemplateId && options.workspace) {
        for (const item of templateLibraryItems) {
          const result = await materializeVoiceReference(item, [{
            roomId,
            agentId: added.id
          }]);
          libraryFailures.push(...result.failures);
        }
      }
      if (libraryFailures.length > 0 && options.workspace) {
        for (const artifact of options.workspace.listArtifacts(roomId)) {
          if (
            artifact.ownerAgentId === added.id &&
            artifact.voiceTemplateLibraryItemId
          ) {
            options.workspace.deleteArtifact(roomId, artifact.id, {
              allowTemplateManaged: true
            });
          }
        }
        options.store.removeAgent(roomId, added.id);
        throw new Error(
          `Participant was not added because private references could not be attached: ${
            libraryFailures.map(failure => failure.error).join("; ")
          }`
        );
      }
      const room = options.store.getRoom(roomId);
      options.store.appendRoomEvent(room.id, { type: "room.snapshot", room });
      response.status(201).json({ agent: added, libraryFailures });
    })
  );

  application.delete(
    "/api/v1/rooms/:roomId/agents/:agentId",
    (request, response) => {
      const roomId = String(request.params.roomId);
      const agentId = String(request.params.agentId);
      options.store.getRoomAgent(roomId, agentId);
      engine.interruptAgent(roomId, agentId);
      if (options.workspace) {
        for (const artifact of options.workspace.listArtifacts(roomId)) {
          if (artifact.ownerAgentId === agentId) {
            options.workspace.deleteArtifact(roomId, artifact.id, {
              allowTemplateManaged: true
            });
          }
        }
      }
      const agent = options.store.removeAgent(roomId, agentId);
      const room = options.store.getRoom(roomId);
      options.store.appendRoomEvent(room.id, { type: "room.snapshot", room });
      response.json({ removed: true, agent });
    }
  );

  application.post("/api/v1/rooms/:roomId/messages", (request, response) => {
    const input = createMessageSchema.parse(request.body);
    const message = options.store.appendMessage({
      roomId: request.params.roomId!,
      authorType: "human",
      authorId: "human",
      content: input.content,
      mentionedAgentIds: input.mentionedAgentIds,
      attachmentIds: input.attachmentIds,
      ...(input.replyToMessageId === undefined
        ? {}
        : { replyToMessageId: input.replyToMessageId })
    });
    response.status(201).json({ message });
    const room = options.store.getRoom(message.roomId);
    if (
      options.automaticScheduling !== false &&
      room.settings.autoMode &&
      options.store.listAgents(room.id).length > 0
    ) {
      void scheduler.runFromHumanMessage(room.id, message.id).catch(error => {
        try {
          options.store.appendRoomEvent(room.id, {
            type: "system.error",
            message: error instanceof Error ? error.message : String(error)
          });
        } catch {
          // The room may have been deleted while activation was in progress.
        }
      });
    }
  });

  application.post(
    "/api/v1/rooms/:roomId/speakers/:agentId",
    asyncRoute(async (request, response) => {
      const input = speakerSchema.parse(request.body ?? {});
      const result = await engine.generate({
        roomId: String(request.params.roomId),
        agentId: String(request.params.agentId),
        ...(input.targetMessageId === undefined
          ? {}
          : { targetMessageId: input.targetMessageId })
      });
      response.status(201).json(result);
    })
  );

  application.post("/api/v1/generations/:generationId/interrupt", (request, response) => {
    const interrupted = engine.interrupt(request.params.generationId!);
    response.status(interrupted ? 202 : 404).json({ interrupted });
  });

  application.get("/api/v1/generations/:generationId/inspection", (request, response) => {
    response.json(
      options.store.getGenerationInspection(String(request.params.generationId))
    );
  });

  application.get("/api/v1/rooms/:roomId/events", (request, response) => {
    const after = z.coerce.number().int().nonnegative().default(0)
      .parse(request.query.after);
    response.json({ events: options.store.getEvents(request.params.roomId!, after) });
  });

  application.patch(
    "/api/v1/rooms/:roomId/agents/:agentId/runtime",
    (request, response) => {
      const patch = z.object({ muted: z.boolean() }).parse(request.body);
      if (patch.muted) {
        engine.interruptAgent(
          String(request.params.roomId),
          String(request.params.agentId)
        );
      }
      const runtime = options.store.updateRuntime(
        String(request.params.roomId),
        String(request.params.agentId),
        patch
      );
      response.json({ runtime });
    }
  );

  application.delete("/api/v1/rooms/:roomId/messages/tail", (request, response) => {
    const tail = options.store.getTailMessage(String(request.params.roomId));
    if (!tail || tail.authorType !== "agent" || tail.status === "streaming") {
      response.status(409).json({ error: "Only a completed tail agent response can be deleted" });
      return;
    }
    response.json({
      message: options.store.updateMessage(tail.id, { lifecycle: "deleted" })
    });
  });

  application.post(
    "/api/v1/rooms/:roomId/messages/tail/regenerate",
    asyncRoute(async (request, response) => {
      const tail = options.store.getTailMessage(String(request.params.roomId));
      if (!tail || tail.authorType !== "agent" || tail.status === "streaming") {
        response.status(409).json({ error: "Only a completed tail agent response can be regenerated" });
        return;
      }
      options.store.updateMessage(tail.id, { lifecycle: "superseded" });
      const result = await engine.generate({
        roomId: tail.roomId,
        agentId: tail.authorId,
        ...(tail.replyToMessageId === undefined
          ? {}
          : { targetMessageId: tail.replyToMessageId })
      });
      response.status(201).json(result);
    })
  );

  if (options.workspace) {
    application.get("/api/v1/rooms/:roomId/artifacts", (request, response) => {
      response.json({
        artifacts: options.workspace!.listArtifacts(String(request.params.roomId))
      });
    });

    application.post(
      "/api/v1/rooms/:roomId/artifacts",
      upload.single("file"),
      asyncRoute(async (request, response) => {
        if (!request.file) {
          response.status(400).json({ error: "A file is required" });
          return;
        }
        const ownerAgentId = z.string().trim().min(1).optional()
          .parse(request.body.ownerAgentId || undefined);
        if (ownerAgentId !== undefined) {
          const owner = options.store.getRoomAgent(
            String(request.params.roomId),
            ownerAgentId
          );
          if (owner.voiceTemplateId) {
            const result = await addVoiceReference(owner.voiceTemplateId, request.file);
            const artifact = result.artifacts.find(candidate =>
              candidate.roomId === String(request.params.roomId) &&
              candidate.ownerAgentId === ownerAgentId
            );
            if (!artifact) {
              throw new Error(
                result.failures.find(failure =>
                  failure.roomId === String(request.params.roomId) &&
                  failure.agentId === ownerAgentId
                )?.error ?? "Could not materialize the voice reference"
              );
            }
            response.status(201).json({ artifact, libraryItem: result.item });
            return;
          }
        }
        const artifact = await options.workspace!.ingest({
          roomId: String(request.params.roomId),
          filename: request.file.originalname,
          mediaType: request.file.mimetype,
          bytes: request.file.buffer,
          ...(ownerAgentId === undefined
            ? {}
            : { sourceType: "persona-memory", ownerAgentId })
        });
        response.status(201).json({ artifact });
      })
    );

    application.post(
      "/api/v1/rooms/:roomId/repositories",
      repositoryUpload.array("files", 500),
      asyncRoute(async (request, response) => {
        const files = (request.files ?? []) as Express.Multer.File[];
        const paths = z.array(z.string()).parse(
          JSON.parse(z.string().parse(request.body.paths ?? "[]"))
        );
        if (files.length === 0 || files.length !== paths.length) {
          response.status(400).json({
            error: "Repository upload requires one relative path per file"
          });
          return;
        }
        const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
        if (totalBytes > MAX_REPOSITORY_UPLOAD_BYTES) {
          response.status(413).json({ error: "Repository upload exceeds 100 MB" });
          return;
        }
        const artifacts = [];
        const failures: Array<{ path: string; error: string }> = [];
        for (const [index, file] of files.entries()) {
          const submittedPath = paths[index]!;
          try {
            const path = repositoryPath(submittedPath);
            assertRepositoryFileSafe(path, file.buffer);
            artifacts.push(await options.workspace!.ingest({
              roomId: String(request.params.roomId),
              filename: path,
              mediaType: file.mimetype || "application/octet-stream",
              bytes: file.buffer,
              sourceType: "repository"
            }));
          } catch (error) {
            failures.push({
              path: submittedPath,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
        response.status(201).json({ artifacts, failures });
      })
    );

    application.post(
      "/api/v1/rooms/:roomId/artifacts/:artifactId/retry",
      asyncRoute(async (request, response) => {
        const artifact = await options.workspace!.retryArtifact(
          String(request.params.roomId),
          String(request.params.artifactId)
        );
        response.json({ artifact });
      })
    );

    application.delete(
      "/api/v1/rooms/:roomId/artifacts/:artifactId",
      (request, response) => {
        const artifact = options.workspace!.deleteArtifact(
          String(request.params.roomId),
          String(request.params.artifactId)
        );
        response.json({ deleted: true, artifact });
      }
    );

    application.get(
      "/api/v1/rooms/:roomId/workspace/search",
      asyncRoute(async (request, response) => {
        const query = z.string().trim().min(1).parse(request.query.q);
        const limit = z.coerce.number().int().min(1).max(20).default(8)
          .parse(request.query.limit);
        response.json({
          results: await options.workspace!.search({
            roomId: String(request.params.roomId),
            query,
            limit
          })
        });
      })
    );

    application.get("/api/v1/artifact-chunks/:chunkId", (request, response) => {
      response.json({
        chunk: options.workspace!.getChunk(String(request.params.chunkId))
      });
    });
  }

  application.get("/api/v1/rooms/:roomId/scratchpad", (request, response) => {
    response.json({ notes: options.store.listNotes(String(request.params.roomId)) });
  });

  application.post("/api/v1/rooms/:roomId/scratchpad", (request, response) => {
    const input = z.object({
      text: z.string().trim().min(1).max(4_000),
      category: z.string().trim().max(80).optional()
    }).parse(request.body);
    const note = options.store.appendNote({
      roomId: String(request.params.roomId),
      authorType: "human",
      authorId: "human",
      text: input.text,
      ...(input.category === undefined ? {} : { category: input.category })
    });
    response.status(201).json({ note });
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: "Invalid request", details: error.issues });
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    if (error instanceof multer.MulterError) {
      response.status(413).json({ error: message });
      return;
    }
    const explicitStatus = typeof error === "object" && error !== null &&
      "status" in error && typeof error.status === "number" &&
      error.status >= 400 && error.status < 500
      ? error.status
      : undefined;
    if (explicitStatus !== undefined) {
      response.status(explicitStatus).json({
        error: explicitStatus === 413 ? "Request payload is too large" : message
      });
      return;
    }
    const status = /not found/i.test(message)
      ? 404
      : /paused|already|muted|does not belong|configuration changed/i.test(message)
        ? 409
        : 500;
    response.status(status).json({ error: message });
  };
  application.use(errorHandler);
  return application;
}
