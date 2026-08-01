import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultVoiceConfiguration } from "@writers-room/contracts";
import { PsfnProvider } from "../providers/psfn.js";
import { RoomStore } from "../storage/room-store.js";
import { RoomEngine } from "./room-engine.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sse(text: string): Response {
  return new Response([
    `data: ${JSON.stringify({ model: "companion-1", choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n"
  ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function emptySse(): Response {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n"
  ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function setup(fetcher: typeof fetch): {
  store: RoomStore;
  engine: RoomEngine;
  roomId: string;
} {
  const root = mkdtempSync(join(tmpdir(), "writers-room-psfn-engine-"));
  roots.push(root);
  const store = new RoomStore(join(root, "room.db"));
  const room = store.createRoom({ title: "PSFN room" });
  store.addAgent(room.id, {
    id: "remote",
    name: "Remote",
    description: "Stateful companion",
    provider: "psfn",
    modelId: "companion-1",
    systemPrompt: "",
    personaPrompt: "",
    ...createDefaultVoiceConfiguration()
  });
  const provider = new PsfnProvider({
    baseUrl: "https://psfn.example.invalid/v1",
    sessionMode: "header",
    fetcher
  });
  return {
    store,
    engine: new RoomEngine(store, new Map([["psfn", provider]])),
    roomId: room.id
  };
}

describe("PSFN room generation", () => {
  it("uses one stateful turn, advances the cursor, and excludes local persona prompts", async () => {
    const chatBodies: Array<Record<string, unknown>> = [];
    const fetcher = (async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/identity")) {
        return Response.json({
          object: "psfn.identity",
          companion: { id: "companion-1", name: "Companion" }
        });
      }
      if (pathname.endsWith("/models")) {
        return Response.json({ data: [{ id: "companion-1" }] });
      }
      chatBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse("Grounded reply");
    }) as typeof fetch;
    const { store, engine, roomId } = setup(fetcher);
    const human = store.appendMessage({
      roomId,
      authorType: "human",
      authorId: "human",
      content: "What do you remember?"
    });

    const result = await engine.generate({
      roomId,
      agentId: "remote",
      targetMessageId: human.id
    });

    expect(result.message.content).toBe("Grounded reply");
    expect(result.generation.disposition).toBe("published");
    expect(chatBodies).toHaveLength(1);
    const body = chatBodies[0] as { messages: Array<{ content: string }>; systemPrompt?: unknown };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]!.content).toContain("What do you remember?");
    expect(body.messages[0]!.content).not.toContain("personaPrompt");
    expect(body.systemPrompt).toBeUndefined();
    expect(store.getPsfnDeliveryState(roomId, "remote")).toMatchObject({
      deliveryStatus: "idle",
      lastDeliveredSequence: human.sequence
    });
    store.close();
  });

  it("bounds the stateful event envelope independently of the remote model window", async () => {
    let envelopeCharacters = 0;
    const fetcher = (async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/identity")) {
        return Response.json({
          object: "psfn.identity",
          companion: { id: "companion-1", name: "Companion" }
        });
      }
      if (pathname.endsWith("/models")) {
        return Response.json({ data: [{ id: "companion-1" }] });
      }
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
      };
      envelopeCharacters = body.messages[0]!.content.length;
      return sse("Grounded reply");
    }) as typeof fetch;
    const { store, engine, roomId } = setup(fetcher);
    const human = store.appendMessage({
      roomId,
      authorType: "human",
      authorId: "human",
      content: `Large room context ${"x".repeat(80_000)}`
    });

    await engine.generate({
      roomId,
      agentId: "remote",
      targetMessageId: human.id
    });

    // PSFN can own a very large model window while its stateful ingress still
    // needs a smaller bounded event packet. Live validation proved this bound
    // succeeds where an 88k bootstrap failed before model completion.
    expect(envelopeCharacters).toBeLessThanOrEqual(32_768);
    expect(envelopeCharacters).toBeGreaterThan(24_000);
    store.close();
  });

  it("uses the durable delivery identity to pin an environment-only provider after restart", async () => {
    const firstFetcher = (async url => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/identity")) {
        return Response.json({
          object: "psfn.identity",
          companion: { id: "companion-1", name: "Companion One" }
        });
      }
      if (pathname.endsWith("/models")) {
        return Response.json({ data: [{ id: "companion-1" }] });
      }
      return sse("First reply");
    }) as typeof fetch;
    const { store, engine, roomId } = setup(firstFetcher);
    const databasePath = store.databasePath;
    const firstHuman = store.appendMessage({
      roomId,
      authorType: "human",
      authorId: "human",
      content: "Establish the remote identity"
    });
    await engine.generate({
      roomId,
      agentId: "remote",
      targetMessageId: firstHuman.id
    });
    expect(store.getPsfnDeliveryState(roomId, "remote")?.remoteCompanionId)
      .toBe("companion-1");
    store.close();

    let changedCompanionChatCalls = 0;
    const changedFetcher = (async url => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/identity")) {
        return Response.json({
          object: "psfn.identity",
          companion: { id: "companion-2", name: "Companion Two" }
        });
      }
      if (pathname.endsWith("/models")) {
        return Response.json({ data: [{ id: "companion-2" }] });
      }
      changedCompanionChatCalls += 1;
      return sse("Wrong companion reply");
    }) as typeof fetch;
    const reopened = new RoomStore(databasePath);
    const secondHuman = reopened.appendMessage({
      roomId,
      authorType: "human",
      authorId: "human",
      content: "Do not silently switch companions"
    });
    const changedProvider = new PsfnProvider({
      baseUrl: "https://psfn.example.invalid/v1",
      sessionMode: "header",
      fetcher: changedFetcher
    });
    const changedEngine = new RoomEngine(
      reopened,
      new Map([["psfn", changedProvider]])
    );

    await expect(changedEngine.generate({
      roomId,
      agentId: "remote",
      targetMessageId: secondHuman.id
    })).rejects.toThrow(/identity changed|different PSFN identity|different.*observed/i);
    expect(changedProvider.connectionState).toBe("identity-drift");
    expect(changedCompanionChatCalls).toBe(0);
    expect(reopened.getPsfnDeliveryState(roomId, "remote")?.remoteCompanionId)
      .toBe("companion-1");
    reopened.close();
  });

  it("records intentional no-reply without leaving an empty bubble", async () => {
    const fetcher = (async url => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/identity")) {
        return Response.json({
          object: "psfn.identity",
          companion: { id: "companion-1", name: "Companion" }
        });
      }
      if (pathname.endsWith("/models")) {
        return Response.json({ data: [{ id: "companion-1" }] });
      }
      return emptySse();
    }) as typeof fetch;
    const { store, engine, roomId } = setup(fetcher);
    const human = store.appendMessage({
      roomId,
      authorType: "human",
      authorId: "human",
      content: "You may stay silent."
    });

    const result = await engine.generate({ roomId, agentId: "remote", targetMessageId: human.id });

    expect(result.generation.disposition).toBe("no-reply");
    expect(result.message.lifecycle).toBe("deleted");
    expect(store.getSnapshot(roomId).messages.filter(message =>
      message.lifecycle === "active" && message.authorType === "agent"
    )).toEqual([]);
    store.close();
  });

  it("marks an admitted malformed stream ambiguous and blocks automatic resend", async () => {
    let chatCalls = 0;
    const chatBodies: string[] = [];
    const fetcher = (async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/identity")) {
        return Response.json({
          object: "psfn.identity",
          companion: { id: "companion-1", name: "Companion" }
        });
      }
      if (pathname.endsWith("/models")) {
        return Response.json({ data: [{ id: "companion-1" }] });
      }
      chatCalls += 1;
      chatBodies.push(String(init?.body));
      if (chatCalls === 2) return sse("Recovered without reassembly");
      return new Response("data: {malformed}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }) as typeof fetch;
    const { store, engine, roomId } = setup(fetcher);
    const human = store.appendMessage({
      roomId,
      authorType: "human",
      authorId: "human",
      content: "Potentially admitted turn"
    });

    await expect(engine.generate({ roomId, agentId: "remote", targetMessageId: human.id }))
      .rejects.toThrow("malformed stream JSON");
    expect(store.getPsfnDeliveryState(roomId, "remote")?.deliveryStatus).toBe("ambiguous");
    await expect(engine.generate({ roomId, agentId: "remote", targetMessageId: human.id }))
      .rejects.toThrow("requires human resolution");
    expect(chatCalls).toBe(1);
    const retried = await engine.retryPsfnDelivery({ roomId, agentId: "remote" });
    expect(retried.message.content).toBe("Recovered without reassembly");
    expect(chatCalls).toBe(2);
    expect(chatBodies[1]).toBe(chatBodies[0]);
    expect(store.getPsfnDeliveryState(roomId, "remote")).toMatchObject({
      deliveryStatus: "idle",
      lastDeliveredSequence: human.sequence
    });
    store.close();
  });

  it("keeps the original ambiguity evidence when an exact retry is rejected before admission", async () => {
    let chatCalls = 0;
    const fetcher = (async url => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/identity")) {
        return Response.json({
          object: "psfn.identity",
          companion: { id: "companion-1", name: "Companion" }
        });
      }
      if (pathname.endsWith("/models")) {
        return Response.json({ data: [{ id: "companion-1" }] });
      }
      chatCalls += 1;
      if (chatCalls === 1) {
        return new Response("data: {malformed}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      }
      return Response.json({
        error: { type: "authentication_error", message: "Rejected" }
      }, { status: 401 });
    }) as typeof fetch;
    const { store, engine, roomId } = setup(fetcher);
    const human = store.appendMessage({
      roomId,
      authorType: "human",
      authorId: "human",
      content: "Preserve this exact delivery"
    });

    await expect(engine.generate({ roomId, agentId: "remote", targetMessageId: human.id }))
      .rejects.toThrow("malformed stream JSON");
    const original = store.getPsfnDeliveryState(roomId, "remote")!;
    await expect(engine.retryPsfnDelivery({ roomId, agentId: "remote" }))
      .rejects.toThrow(/authentication was rejected/i);

    expect(chatCalls).toBe(2);
    expect(store.getPsfnDeliveryState(roomId, "remote")).toMatchObject({
      deliveryStatus: "ambiguous",
      inflightDeliveryId: original.inflightDeliveryId,
      inflightEnvelope: original.inflightEnvelope,
      inflightEnvelopeDigest: original.inflightEnvelopeDigest
    });
    await expect(engine.generate({ roomId, agentId: "remote", targetMessageId: human.id }))
      .rejects.toThrow(/requires human resolution/i);
    expect(chatCalls).toBe(2);
    store.close();
  });

  it("can resolve an ambiguous turn by sending a bounded resynchronization summary", async () => {
    let chatCalls = 0;
    const chatBodies: string[] = [];
    const fetcher = (async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/identity")) {
        return Response.json({
          object: "psfn.identity",
          companion: { id: "companion-1", name: "Companion" }
        });
      }
      if (pathname.endsWith("/models")) {
        return Response.json({ data: [{ id: "companion-1" }] });
      }
      chatCalls += 1;
      chatBodies.push(String(init?.body));
      if (chatCalls === 1) {
        return new Response("data: {malformed}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      }
      return sse("Resynchronized reply");
    }) as typeof fetch;
    const { store, engine, roomId } = setup(fetcher);
    const human = store.appendMessage({
      roomId,
      authorType: "human",
      authorId: "human",
      content: "Recover our shared state"
    });

    await expect(engine.generate({ roomId, agentId: "remote", targetMessageId: human.id }))
      .rejects.toThrow("malformed stream JSON");
    const result = await engine.resynchronizePsfnDelivery({
      roomId,
      agentId: "remote"
    });

    expect(result.message.content).toBe("Resynchronized reply");
    expect(chatCalls).toBe(2);
    expect(chatBodies[1]).toContain("resynchronization");
    expect(chatBodies[1]).toContain("Recover our shared state");
    expect(store.getPsfnDeliveryState(roomId, "remote")?.deliveryStatus).toBe("idle");
    store.close();
  });

  it("restores the exact original ambiguity when resynchronization is rejected before admission", async () => {
    let chatCalls = 0;
    const fetcher = (async url => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/identity")) {
        return Response.json({
          object: "psfn.identity",
          companion: { id: "companion-1", name: "Companion" }
        });
      }
      if (pathname.endsWith("/models")) {
        return Response.json({ data: [{ id: "companion-1" }] });
      }
      chatCalls += 1;
      if (chatCalls === 1) {
        return new Response("data: {malformed}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      }
      return Response.json({
        error: { type: "invalid_api_key", message: "Rejected" }
      }, { status: 401 });
    }) as typeof fetch;
    const { store, engine, roomId } = setup(fetcher);
    const human = store.appendMessage({
      roomId,
      authorType: "human",
      authorId: "human",
      content: "Keep recovery reversible"
    });

    await expect(engine.generate({ roomId, agentId: "remote", targetMessageId: human.id }))
      .rejects.toThrow("malformed stream JSON");
    const original = store.getPsfnDeliveryState(roomId, "remote")!;
    await expect(engine.resynchronizePsfnDelivery({ roomId, agentId: "remote" }))
      .rejects.toThrow(/authentication was rejected/i);

    expect(chatCalls).toBe(2);
    expect(store.getPsfnDeliveryState(roomId, "remote")).toMatchObject({
      deliveryStatus: "ambiguous",
      lastDeliveredSequence: original.lastDeliveredSequence,
      inflightDeliveryId: original.inflightDeliveryId,
      inflightHighSequence: original.inflightHighSequence,
      inflightEnvelope: original.inflightEnvelope,
      inflightEnvelopeDigest: original.inflightEnvelopeDigest,
      inflightTriggerMessageId: original.inflightTriggerMessageId,
      inflightChunkIds: original.inflightChunkIds
    });
    store.close();
  });
});
