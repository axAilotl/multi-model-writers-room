import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ActivationDecision,
  AgentDefinition,
  GenerationRecord
} from "@writers-room/contracts";
import { RoomStore } from "../storage/room-store.js";
import {
  ConversationScheduler,
  type ActivationEvaluator,
  type SpeakerGenerator
} from "./scheduler.js";

const roots: string[] = [];

function agent(id: string): AgentDefinition {
  return {
    id,
    name: id.toUpperCase(),
    description: `${id} specialist`,
    provider: "openrouter",
    modelId: "fixture",
    systemPrompt: "Advance the room.",
    temperature: 0.5,
    maxOutputTokens: 800,
    reasoning: { enabled: false, displayMode: "hidden" },
    tools: [],
    contextBudget: {
      softLimitTokens: 8_000,
      hardLimitTokens: 12_000,
      recentTranscriptTokens: 6_000,
      retrievedContextTokens: 1_000,
      notebookTokens: 0
    }
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("conversation scheduler seam", () => {
  it("launches the top candidates in one bounded parallel wave and records fatigue", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-scheduler-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({
      title: "Parallel room",
      settings: {
        maxResponders: 2,
        maxAutonomousWaves: 1,
        maxAutonomousReplies: 2
      }
    });
    for (const id of ["alpha", "beta", "gamma"]) store.addAgent(room.id, agent(id));
    const human = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "Compare the architecture."
    });
    const evaluator: ActivationEvaluator = {
      evaluate: async ({ agent: candidate }): Promise<ActivationDecision> => ({
        shouldRespond: candidate.id !== "gamma",
        urgency: candidate.id === "alpha" ? 0.95 : 0.8,
        confidence: 0.9,
        intendedMove: "challenge",
        reason: "Relevant specialist"
      })
    };
    let active = 0;
    let peakActive = 0;
    const generator: SpeakerGenerator = {
      generate: async input => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        const message = store.appendMessage({
          roomId: input.roomId,
          authorType: "agent",
          authorId: input.agentId,
          content: `${input.agentId} contribution`
        });
        active -= 1;
        return {
          message,
          generation: {
            id: `generation-${input.agentId}`,
            roomId: input.roomId,
            messageId: message.id,
            agentId: input.agentId,
            provider: "openrouter",
            requestedModelId: "fixture",
            status: "complete",
            finalText: message.content,
            retrievedChunkIds: [],
            outputTokens: 300,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          }
        };
      }
    };
    const scheduler = new ConversationScheduler({ store, evaluator, generator });

    const result = await scheduler.runFromHumanMessage(room.id, human.id);

    expect(result).toMatchObject({ waves: 1, replies: 2, stopReason: "wave_cap" });
    expect(peakActive).toBe(2);
    expect(store.listMessages(room.id).map(message => message.authorId)).toEqual([
      "human",
      "alpha",
      "beta"
    ]);
    expect(store.getRuntime(room.id, "alpha").fatigue).toBeCloseTo(0.2);
    expect(store.getRuntime(room.id, "beta").fatigue).toBeCloseTo(0.2);
    expect(store.getRuntime(room.id, "gamma").fatigue).toBe(0);
    store.close();
  });

  it("lets a directly mentioned exhausted agent respond despite a negative activation decision", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-mention-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({
      title: "Mention room",
      settings: { maxResponders: 1, maxAutonomousWaves: 1 }
    });
    store.addAgent(room.id, agent("alpha"));
    store.updateRuntime(room.id, "alpha", { fatigue: 0.98, muted: false });
    const human = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "@alpha check this.",
      mentionedAgentIds: ["alpha"]
    });
    const spoken: string[] = [];
    const evaluator: ActivationEvaluator = {
      evaluate: async () => ({
        shouldRespond: false,
        urgency: 0,
        confidence: 1,
        intendedMove: "defer",
        reason: "Would normally defer"
      })
    };
    const generator: SpeakerGenerator = {
      generate: async input => {
        spoken.push(input.agentId);
        const message = store.appendMessage({
          roomId: input.roomId,
          authorType: "agent",
          authorId: input.agentId,
          content: "Correction."
        });
        const generation = {
          id: "generation",
          roomId: input.roomId,
          messageId: message.id,
          agentId: input.agentId,
          provider: "openrouter" as const,
          requestedModelId: "fixture",
          status: "complete" as const,
          finalText: "Correction.",
          retrievedChunkIds: [],
          outputTokens: 40,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        } satisfies GenerationRecord;
        return { message, generation };
      }
    };
    const scheduler = new ConversationScheduler({ store, evaluator, generator });

    await scheduler.runFromHumanMessage(room.id, human.id);

    expect(spoken).toEqual(["alpha"]);
    store.close();
  });

  it("never launches more speakers than the remaining autonomous reply budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-reply-cap-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({
      title: "Reply cap room",
      settings: {
        maxResponders: 3,
        maxAutonomousWaves: 3,
        maxAutonomousReplies: 1
      }
    });
    for (const id of ["alpha", "beta", "gamma"]) store.addAgent(room.id, agent(id));
    const human = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "Only one response is allowed."
    });
    const evaluator: ActivationEvaluator = {
      evaluate: async () => ({
        shouldRespond: true,
        urgency: 1,
        confidence: 1
      })
    };
    const spoken: string[] = [];
    const generator: SpeakerGenerator = {
      generate: async input => {
        spoken.push(input.agentId);
        const message = store.appendMessage({
          roomId: input.roomId,
          authorType: "agent",
          authorId: input.agentId,
          content: "One bounded reply."
        });
        return {
          message,
          generation: {
            id: `generation-${input.agentId}`,
            roomId: input.roomId,
            messageId: message.id,
            agentId: input.agentId,
            provider: "openrouter",
            requestedModelId: "fixture",
            status: "complete",
            finalText: message.content,
            retrievedChunkIds: [],
            startedAt: new Date().toISOString()
          }
        };
      }
    };
    const scheduler = new ConversationScheduler({ store, evaluator, generator });

    const result = await scheduler.runFromHumanMessage(room.id, human.id);

    expect(result).toMatchObject({ replies: 1, stopReason: "reply_cap" });
    expect(spoken).toHaveLength(1);
    store.close();
  });

  it("applies idle recovery before human recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-idle-recovery-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const now = Date.parse("2026-07-31T14:00:00.000Z");
    const room = store.createRoom({ title: "Idle recovery room" });
    store.addAgent(room.id, agent("alpha"));
    store.updateRuntime(room.id, "alpha", {
      fatigue: 0.8,
      lastEvaluatedAt: new Date(now - 30 * 60_000).toISOString()
    });
    const human = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "Wake up."
    });
    const evaluator: ActivationEvaluator = {
      evaluate: async () => ({
        shouldRespond: false,
        urgency: 0,
        confidence: 0
      })
    };
    const generator: SpeakerGenerator = {
      generate: async () => {
        throw new Error("No speaker should be selected");
      }
    };
    const scheduler = new ConversationScheduler({
      store,
      evaluator,
      generator,
      now: () => now
    });

    await scheduler.runFromHumanMessage(room.id, human.id);

    expect(store.getRuntime(room.id, "alpha").fatigue).toBeCloseTo(0.5);
    store.close();
  });
});
