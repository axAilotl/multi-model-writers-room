import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoomStore } from "./room-store.js";
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
});
