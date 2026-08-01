import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "@writers-room/contracts";
import { RoomStore } from "../storage/room-store.js";
import { ensureConversationCompaction } from "./context-compactor.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("rolling conversation compaction", () => {
  it("persists an episode at 70% transcript pressure and leaves recent messages raw", () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-compaction-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({ title: "Long room" });
    const agent: AgentDefinition = {
      id: "reader",
      name: "Reader",
      description: "Keeps a large rolling context.",
      provider: "openrouter",
      modelId: "fixture",
      systemPrompt: "Keep continuity.",
      temperature: 0,
      maxOutputTokens: 256,
      reasoning: { enabled: false, displayMode: "hidden" },
      tools: [],
      contextBudget: {
        automatic: false,
        softLimitTokens: 4_000,
        hardLimitTokens: 4_000,
        recentTranscriptTokens: 1_000,
        retrievedContextTokens: 500,
        notebookTokens: 0
      },
      capabilities: {
        contextLength: 4_000,
        textInput: true,
        imageInput: false,
        pdfInput: false,
        toolCalling: false,
        structuredOutput: false,
        reasoningInputControl: false,
        reasoningOutput: false,
        promptCaching: false
      }
    };
    store.addAgent(room.id, agent);
    for (let index = 0; index < 20; index += 1) {
      store.appendMessage({
        roomId: room.id,
        authorType: index % 2 === 0 ? "human" : "agent",
        authorId: index % 2 === 0 ? "human" : agent.id,
        content: `Message ${index}: ${"context ".repeat(25)}`
      });
    }

    const episode = ensureConversationCompaction({ store, roomId: room.id, agent });

    expect(episode).toMatchObject({
      firstSequence: 1,
      lastSequence: expect.any(Number),
      sourceTokenCount: expect.any(Number)
    });
    expect(episode!.lastSequence).toBeLessThan(20);
    expect(store.listConversationEpisodes(room.id)).toHaveLength(1);
    expect(store.listMessages(room.id)).toHaveLength(20);
    store.close();
  });
});
