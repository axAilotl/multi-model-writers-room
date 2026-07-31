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
import type { ModelProvider } from "../providers/model-provider.js";
import { RoomEngine } from "../room/room-engine.js";
import { ParticipantModelActivationEvaluator } from "../scheduler/activation-evaluator.js";
import { ConversationScheduler } from "../scheduler/scheduler.js";
import { RoomStore } from "../storage/room-store.js";
import type { ToolExecutor } from "../tools/room-tools.js";
import type { WorkspaceService } from "../workspace/workspace-service.js";
import { generateVoiceTemplate } from "../voices/voice-template-generator.js";

interface ApplicationOptions {
  store: RoomStore;
  providers: ReadonlyMap<string, ModelProvider>;
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
  attachmentIds: z.array(z.string()).default([])
});

const speakerSchema = z.object({
  targetMessageId: z.string().optional()
});

const VOICE_GENERATION_TIMEOUT_MS = 5 * 60_000;

function asyncRoute(
  handler: (request: express.Request, response: express.Response) => Promise<void>
): express.RequestHandler {
  return (request, response, next) => {
    void handler(request, response).catch(next);
  };
}

export function createHttpApplication(options: ApplicationOptions): express.Express {
  const application = express();
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
  application.disable("x-powered-by");
  application.use(cors({ origin: /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/ }));
  application.use(express.json({ limit: "2mb" }));

  application.get("/api/v1/health", (_request, response) => {
    response.json({
      ok: true,
      database: true,
      providers: [...options.providers.keys()],
      ...(options.workspace ? { workspace: options.workspace.health() } : {})
    });
  });

  application.get(
    "/api/v1/providers/:providerId/models",
    asyncRoute(async (request, response) => {
      const providerId = String(request.params.providerId);
      const provider = options.providers.get(providerId);
      if (!provider) throw new Error(`Provider not found: ${providerId}`);
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

  application.patch("/api/v1/voice-templates/:templateId", (request, response) => {
    const patch = voiceTemplatePatchSchema.parse(request.body);
    response.json({
      template: options.store.updateVoiceTemplate(
        String(request.params.templateId),
        patch
      )
    });
  });

  application.delete("/api/v1/voice-templates/:templateId", (request, response) => {
    const template = options.store.deleteVoiceTemplate(
      String(request.params.templateId)
    );
    response.json({ deleted: true, template });
  });

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

  application.post("/api/v1/rooms/:roomId/agents", (request, response) => {
    const agent = agentDefinitionSchema.parse(request.body);
    const added = options.store.addAgent(String(request.params.roomId), agent);
    const room = options.store.getRoom(String(request.params.roomId));
    options.store.appendRoomEvent(room.id, { type: "room.snapshot", room });
    response.status(201).json({ agent: added });
  });

  application.post("/api/v1/rooms/:roomId/messages", (request, response) => {
    const input = createMessageSchema.parse(request.body);
    const message = options.store.appendMessage({
      roomId: request.params.roomId!,
      authorType: "human",
      authorId: "human",
      content: input.content,
      mentionedAgentIds: input.mentionedAgentIds,
      attachmentIds: input.attachmentIds
    });
    response.status(201).json({ message });
    const room = options.store.getRoom(message.roomId);
    if (
      options.automaticScheduling !== false &&
      room.settings.autoMode &&
      options.store.listAgents(room.id).length > 0
    ) {
      void scheduler.runFromHumanMessage(room.id, message.id).catch(error => {
        options.store.appendRoomEvent(room.id, {
          type: "system.error",
          message: error instanceof Error ? error.message : String(error)
        });
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
        const artifact = await options.workspace!.ingest({
          roomId: String(request.params.roomId),
          filename: request.file.originalname,
          mediaType: request.file.mimetype,
          bytes: request.file.buffer
        });
        response.status(201).json({ artifact });
      })
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
    const status = /not found/i.test(message)
      ? 404
      : /paused|already|muted|does not belong/i.test(message)
        ? 409
        : 500;
    response.status(status).json({ error: message });
  };
  application.use(errorHandler);
  return application;
}
