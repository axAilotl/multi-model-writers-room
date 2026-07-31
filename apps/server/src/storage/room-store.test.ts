import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomStore } from "./room-store.js";
import { createDefaultVoiceConfiguration } from "@writers-room/contracts";
import type { AgentDefinition } from "@writers-room/contracts";

const roots: string[] = [];

function makeStore(): RoomStore {
  const root = mkdtempSync(join(tmpdir(), "writers-room-store-"));
  roots.push(root);
  return new RoomStore(join(root, "room.db"));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("RoomStore public room seam", () => {
  it("isolates event-listener failures from storage and other listeners", async () => {
    const store = makeStore();
    const room = store.createRoom({ title: "Listener isolation" });
    const received: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    store.subscribeEvents(() => {
      throw new Error("broken listener");
    });
    store.subscribeEvents((_roomId, event) => received.push(event.type));

    expect(() => store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "Keep storing this."
    })).not.toThrow();
    await new Promise<void>(resolve => queueMicrotask(resolve));

    expect(received).toEqual(["message.created"]);
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
    store.close();
  });

  it("replays durable messages and sequenced events after restart", () => {
    const first = makeStore();
    const databasePath = first.databasePath;
    const room = first.createRoom({ title: "Architecture workshop" });
    const message = first.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "What should the table remember?"
    });
    expect(message.sequence).toBe(1);
    expect(first.getEvents(room.id, 0).map(event => event.type)).toEqual([
      "message.created"
    ]);
    first.close();

    const reopened = new RoomStore(databasePath);
    expect(reopened.getSnapshot(room.id).messages).toMatchObject([
      {
        id: message.id,
        content: "What should the table remember?",
        status: "complete"
      }
    ]);
    expect(reopened.getEvents(room.id, 0)).toHaveLength(1);
    reopened.close();
  });

  it("reconciles stale streaming state as interrupted after process restart", () => {
    const first = makeStore();
    const databasePath = first.databasePath;
    const room = first.createRoom({ title: "Recovery room" });
    const agent: AgentDefinition = {
      id: "recovery-agent",
      name: "Recovery Agent",
      description: "",
      provider: "ollama",
      modelId: "fixture",
      systemPrompt: "Respond.",
      temperature: 0.5,
      maxOutputTokens: 256,
      reasoning: { enabled: false, displayMode: "hidden" },
      tools: [],
      contextBudget: {
        softLimitTokens: 2_000,
        hardLimitTokens: 4_000,
        recentTranscriptTokens: 1_000,
        retrievedContextTokens: 500,
        notebookTokens: 0
      }
    };
    first.addAgent(room.id, agent);
    const message = first.appendMessage({
      roomId: room.id,
      authorType: "agent",
      authorId: agent.id,
      content: "Partial",
      status: "streaming",
      generationId: "stale-generation"
    });
    first.createGeneration({
      id: "stale-generation",
      roomId: room.id,
      messageId: message.id,
      agent
    });
    first.close();

    const reopened = new RoomStore(databasePath);
    const snapshot = reopened.getSnapshot(room.id);
    expect(snapshot.messages.at(-1)?.status).toBe("interrupted");
    expect(snapshot.generations.at(-1)).toMatchObject({
      status: "interrupted",
      error: "Generation interrupted by process restart"
    });
    reopened.close();
  });

  it("persists fallback selection and voice templates across restart", () => {
    const first = makeStore();
    const databasePath = first.databasePath;
    first.setDefaultModel({
      provider: "openrouter",
      modelId: "moonshotai/kimi-k3"
    });
    const created = first.createVoiceTemplate({
      ...createDefaultVoiceConfiguration(),
      title: "Product Heretic",
      name: "Mara",
      description: "Challenges safe assumptions.",
      provider: "openrouter",
      modelId: "moonshotai/kimi-k3",
      systemPrompt: "Expose neglected alternatives.",
      personaPrompt: "Provocative and constructive.",
      temperature: 0.85,
      topP: 0.73
    });
    first.close();

    const reopened = new RoomStore(databasePath);
    expect(reopened.getDefaultModel()).toEqual({
      provider: "openrouter",
      modelId: "moonshotai/kimi-k3"
    });
    expect(reopened.listVoiceTemplates()).toMatchObject([
      {
        id: created.id,
        name: "Mara",
        temperature: 0.85,
        topP: 0.73
      }
    ]);
    reopened.close();
  });

  it("deletes a room whose generation cites a workspace chunk", () => {
    const store = makeStore();
    const room = store.createRoom({ title: "Cited workspace room" });
    const agent: AgentDefinition = {
      id: "citing-agent",
      name: "Citing Agent",
      description: "Uses workspace evidence.",
      provider: "ollama",
      modelId: "fixture",
      systemPrompt: "Cite retrieved evidence.",
      temperature: 0.5,
      maxOutputTokens: 256,
      reasoning: { enabled: false, displayMode: "hidden" },
      tools: [],
      contextBudget: {
        softLimitTokens: 2_000,
        hardLimitTokens: 4_000,
        recentTranscriptTokens: 1_000,
        retrievedContextTokens: 500,
        notebookTokens: 0
      }
    };
    store.addAgent(room.id, agent);
    const message = store.appendMessage({
      roomId: room.id,
      authorType: "agent",
      authorId: agent.id,
      content: "The evidence supports this.",
      generationId: "cited-generation"
    });
    store.createGeneration({
      id: "cited-generation",
      roomId: room.id,
      messageId: message.id,
      agent
    });
    const now = new Date().toISOString();
    store.database.prepare(`
      INSERT INTO artifacts(id, room_id, sha256, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("artifact-1", room.id, "hash-1", "{}", now, now);
    store.database.prepare(`
      INSERT INTO artifact_chunks(id, artifact_id, ordinal, text, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run("chunk-1", "artifact-1", 0, "Evidence", "{}");
    store.recordCitations({
      generationId: "cited-generation",
      messageId: message.id,
      chunkIds: ["chunk-1"]
    });

    expect(() => store.deleteRoom(room.id)).not.toThrow();
    expect(store.listRooms()).toEqual([]);
    store.close();
  });
});
