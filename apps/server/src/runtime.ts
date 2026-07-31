import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import type { ModelProvider } from "./providers/model-provider.js";
import { createOllamaProvider } from "./providers/ollama.js";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible.js";
import { createOpenRouterProvider } from "./providers/openrouter.js";
import { createHttpApplication } from "./http/app.js";
import { LocalModelWorker } from "./ml/local-models.js";
import { RoomStore } from "./storage/room-store.js";
import { RoomToolExecutor } from "./tools/room-tools.js";
import { WorkspaceService } from "./workspace/workspace-service.js";

export interface WritersRoomRuntime {
  server: Server;
  store: RoomStore;
  localModels: LocalModelWorker;
  address: () => AddressInfo | null;
  close: () => Promise<void>;
}

function providerRegistry(): Map<string, ModelProvider> {
  const providers = new Map<string, ModelProvider>();
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (openRouterKey) {
    providers.set("openrouter", createOpenRouterProvider({
      apiKey: openRouterKey,
      appName: "Multi-Model Writers' Room"
    }));
  }
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL?.trim();
  providers.set("ollama", createOllamaProvider(
    ollamaBaseUrl ? { baseUrl: ollamaBaseUrl } : undefined
  ));
  const genericUrl = process.env.OPENAI_COMPATIBLE_BASE_URL?.trim();
  if (genericUrl) {
    providers.set("openai-compatible", new OpenAiCompatibleProvider({
      id: "openai-compatible",
      baseUrl: genericUrl,
      ...(process.env.OPENAI_COMPATIBLE_API_KEY
        ? { apiKey: process.env.OPENAI_COMPATIBLE_API_KEY }
        : {})
    }));
  }
  return providers;
}

function bindRoomWebSocket(server: Server, store: RoomStore): () => void {
  const sockets = new WebSocketServer({ noServer: true });
  const cleanup = new Set<() => void>();
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const match = /^\/api\/v1\/rooms\/([^/]+)\/stream$/.exec(url.pathname);
    if (!match) {
      socket.destroy();
      return;
    }
    const roomId = decodeURIComponent(match[1]!);
    try {
      store.getRoom(roomId);
    } catch {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, webSocket => {
      sockets.emit("connection", webSocket, roomId, url);
    });
  });
  sockets.on("connection", (socket: WebSocket, roomId: string, url: URL) => {
    let lastSequence = Number(url.searchParams.get("after") ?? 0);
    if (!Number.isSafeInteger(lastSequence) || lastSequence < 0) lastSequence = 0;
    const send = (event: { sequence: number }) => {
      if (event.sequence <= lastSequence || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(event));
      lastSequence = event.sequence;
    };
    for (const event of store.getEvents(roomId, lastSequence)) send(event);
    const unsubscribe = store.subscribeEvents((eventRoomId, event) => {
      if (eventRoomId === roomId) send(event);
    });
    const dispose = () => {
      unsubscribe();
      cleanup.delete(dispose);
    };
    cleanup.add(dispose);
    socket.once("close", dispose);
  });
  return () => {
    for (const socket of sockets.clients) socket.terminate();
    for (const dispose of cleanup) dispose();
    sockets.close();
  };
}

export async function startRuntime(input?: {
  dataRoot?: string;
  host?: string;
  port?: number;
}): Promise<WritersRoomRuntime> {
  const dataRoot = resolve(
    input?.dataRoot ??
      process.env.WRITERS_ROOM_DATA_DIR ??
      join(process.cwd(), "data")
  );
  const store = new RoomStore(join(dataRoot, "room.db"));
  const localModels = new LocalModelWorker({ dataRoot });
  const workspace = new WorkspaceService({
    store,
    dataRoot,
    embeddings: localModels,
    housekeeping: localModels
  });
  const tools = new RoomToolExecutor(store, workspace);
  const app = createHttpApplication({
    store,
    providers: providerRegistry(),
    workspace,
    tools
  });
  const webDist = resolve(process.cwd(), "apps/web/dist");
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get("*splat", (_request, response) => {
      response.sendFile(join(webDist, "index.html"));
    });
  }
  const server = createServer(app);
  const closeWebSockets = bindRoomWebSocket(server, store);
  const host = input?.host ?? process.env.WRITERS_ROOM_HOST ?? "127.0.0.1";
  const port = input?.port ?? Number(process.env.WRITERS_ROOM_PORT ?? 8787);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  return {
    server,
    store,
    localModels,
    address: () => server.address() as AddressInfo | null,
    close: async () => {
      closeWebSockets();
      await new Promise<void>((resolveClose, reject) => {
        server.close(error => error ? reject(error) : resolveClose());
      });
      await localModels.close();
      store.close();
    }
  };
}
