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
  it("queues a human interjection while an autonomous run is active", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-interjection-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({
      title: "Interruptible room",
      settings: { maxResponders: 1, maxAutonomousWaves: 8 }
    });
    store.addAgent(room.id, agent("alpha"));
    const first = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "Start with the first idea."
    });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    let generationCount = 0;
    const scheduler = new ConversationScheduler({
      store,
      evaluator: {
        evaluate: async ({ eventMessage }) => ({
          shouldRespond: eventMessage.authorType === "human",
          urgency: 1,
          confidence: 1,
          intendedMove: eventMessage.authorType === "human" ? "answer" : "defer"
        })
      },
      generator: {
        generate: async input => {
          generationCount += 1;
          if (generationCount === 1) await firstBlocked;
          const message = store.appendMessage({
            roomId: input.roomId,
            authorType: "agent",
            authorId: input.agentId,
            content: `Response ${generationCount}`,
            ...(input.targetMessageId ? { replyToMessageId: input.targetMessageId } : {})
          });
          return {
            message,
            generation: {
              id: `generation-${generationCount}`,
              roomId: input.roomId,
              messageId: message.id,
              agentId: input.agentId,
              provider: "openrouter",
              requestedModelId: "fixture",
              status: "complete",
              finalText: message.content,
              retrievedChunkIds: [],
              outputTokens: 40,
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString()
            }
          };
        }
      }
    });

    const activeRun = scheduler.runFromHumanMessage(room.id, first.id);
    await new Promise(resolve => setTimeout(resolve, 5));
    const interjection = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "Hold on—use this new direction."
    });
    await expect(scheduler.runFromHumanMessage(room.id, interjection.id))
      .resolves.toMatchObject({ stopReason: "interjection_queued" });
    const secondInterjection = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "One more constraint before you continue."
    });
    await expect(scheduler.runFromHumanMessage(room.id, secondInterjection.id))
      .resolves.toMatchObject({ stopReason: "interjection_queued" });
    releaseFirst();
    await activeRun;

    expect(generationCount).toBe(3);
    const replies = store.listMessages(room.id).filter(message =>
      message.authorType === "agent"
    );
    expect(replies.map(message => message.replyToMessageId)).toEqual([
      first.id,
      interjection.id,
      secondInterjection.id
    ]);
    expect(store.listMessages(room.id).at(-1)).toMatchObject({
      authorType: "agent",
      replyToMessageId: secondInterjection.id
    });
    store.close();
  });

  it("links autonomous speakers to real messages across agent-to-agent waves", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-crosstalk-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({
      title: "Crosstalk room",
      settings: {
        maxResponders: 1,
        maxAutonomousWaves: 2,
        maxAutonomousReplies: 2,
        agentContinuation: true
      }
    });
    store.addAgent(room.id, agent("alpha"));
    store.addAgent(room.id, agent("beta"));
    const human = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "Start a discussion about the architecture."
    });
    const evaluator: ActivationEvaluator = {
      evaluate: async ({ agent: candidate, eventMessage }) => ({
        shouldRespond: eventMessage.authorType === "human"
          ? candidate.id === "alpha"
          : candidate.id === "beta",
        urgency: 0.9,
        confidence: 0.9,
        targetMessageId: eventMessage.authorType === "human"
          ? "current"
          : eventMessage.id,
        intendedMove: eventMessage.authorType === "human" ? "answer" : "challenge"
      })
    };
    let generationOrdinal = 0;
    const generator: SpeakerGenerator = {
      generate: async input => {
        generationOrdinal += 1;
        const message = store.appendMessage({
          roomId: input.roomId,
          authorType: "agent",
          authorId: input.agentId,
          content: `${input.agentId} contribution`,
          ...(input.targetMessageId === undefined
            ? {}
            : { replyToMessageId: input.targetMessageId })
        });
        return {
          message,
          generation: {
            id: `generation-${generationOrdinal}`,
            roomId: input.roomId,
            messageId: message.id,
            agentId: input.agentId,
            provider: "openrouter",
            requestedModelId: "fixture",
            status: "complete",
            finalText: message.content,
            retrievedChunkIds: [],
            outputTokens: 60,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          }
        };
      }
    };
    const scheduler = new ConversationScheduler({ store, evaluator, generator });

    const result = await scheduler.runFromHumanMessage(room.id, human.id);
    const [, alphaMessage, betaMessage] = store.listMessages(room.id);

    expect(result).toMatchObject({ waves: 2, replies: 2, stopReason: "wave_cap" });
    expect(alphaMessage).toMatchObject({
      authorId: "alpha",
      replyToMessageId: human.id
    });
    expect(betaMessage).toMatchObject({
      authorId: "beta",
      replyToMessageId: alphaMessage!.id
    });
    store.close();
  });

  it("admits a willing participant even when its ranking score is below the old cutoff", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-willing-candidate-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({
      title: "Willing candidate room",
      settings: { maxResponders: 1, maxAutonomousWaves: 1 }
    });
    store.addAgent(room.id, agent("alpha"));
    const human = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "What do you make of this idea?"
    });
    const evaluator: ActivationEvaluator = {
      evaluate: async () => ({
        shouldRespond: true,
        urgency: 0.1,
        confidence: 0.1,
        intendedMove: "extend",
        reason: "I have a useful but non-urgent contribution"
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
          content: "A useful contribution."
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
            outputTokens: 40,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          }
        };
      }
    };
    const scheduler = new ConversationScheduler({ store, evaluator, generator });

    const result = await scheduler.runFromHumanMessage(room.id, human.id);

    expect(result).toMatchObject({ waves: 1, replies: 1, stopReason: "wave_cap" });
    expect(spoken).toEqual(["alpha"]);
    store.close();
  });

  it("guarantees one eligible response to a human event when auto scheduling is running", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-human-fallback-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({
      title: "Human response room",
      settings: { maxResponders: 2, maxAutonomousWaves: 1 }
    });
    store.addAgent(room.id, agent("alpha"));
    store.addAgent(room.id, agent("beta"));
    const human = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "I expect the room to pick a speaker automatically."
    });
    const evaluator: ActivationEvaluator = {
      evaluate: async () => ({
        shouldRespond: false,
        urgency: 0.1,
        confidence: 0.8,
        intendedMove: "defer",
        reason: "Would otherwise stay silent"
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
          content: "The room selected me.",
          ...(input.targetMessageId === undefined
            ? {}
            : { replyToMessageId: input.targetMessageId })
        });
        return {
          message,
          generation: {
            id: "generation-fallback",
            roomId: input.roomId,
            messageId: message.id,
            agentId: input.agentId,
            provider: "openrouter",
            requestedModelId: "fixture",
            status: "complete",
            finalText: message.content,
            retrievedChunkIds: [],
            outputTokens: 40,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          }
        };
      }
    };
    const scheduler = new ConversationScheduler({ store, evaluator, generator });

    await scheduler.runFromHumanMessage(room.id, human.id);

    expect(spoken).toHaveLength(1);
    expect(store.listMessages(room.id).at(-1)).toMatchObject({
      replyToMessageId: human.id
    });

    const unavailableEvent = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "Keep going even if a lightweight activation call is unavailable."
    });
    const unavailableScheduler = new ConversationScheduler({
      store,
      evaluator: {
        evaluate: async () => {
          throw new Error("fixture activation produced no final JSON");
        }
      },
      generator
    });
    await unavailableScheduler.runFromHumanMessage(room.id, unavailableEvent.id);
    const unavailableActivations = store.getSnapshot(room.id).activations.filter(
      activation =>
        activation.source === "participant" &&
        activation.decision.targetMessageId === unavailableEvent.id
    );
    expect(unavailableActivations).toHaveLength(2);
    expect(unavailableActivations.every(activation =>
      !/failed/i.test(activation.decision.reason ?? "")
    )).toBe(true);
    expect(spoken).toHaveLength(2);
    store.close();
  });

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

  it("routes a human direct mention only to the mentioned participant", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-direct-mention-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({
      title: "Direct mention room",
      settings: {
        maxResponders: 2,
        maxAutonomousWaves: 1,
        maxAutonomousReplies: 2
      }
    });
    store.addAgent(room.id, agent("alpha"));
    store.addAgent(room.id, agent("beta"));
    const human = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "@Alpha answer this directly.",
      mentionedAgentIds: ["alpha"]
    });
    const spoken: string[] = [];
    const evaluator: ActivationEvaluator = {
      evaluate: async () => ({
        shouldRespond: true,
        urgency: 1,
        confidence: 1,
        intendedMove: "answer"
      })
    };
    const generator: SpeakerGenerator = {
      generate: async input => {
        spoken.push(input.agentId);
        const message = store.appendMessage({
          roomId: input.roomId,
          authorType: "agent",
          authorId: input.agentId,
          content: `${input.agentId} response`
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
            outputTokens: 40,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString()
          }
        };
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
      muted: true,
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

  it("does not launch an agent removed while activation is being evaluated", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-removal-race-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({
      title: "Removal race room",
      settings: { maxResponders: 1, maxAutonomousWaves: 1 }
    });
    store.addAgent(room.id, agent("alpha"));
    const human = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "Should the remaining participant answer?"
    });
    let evaluationStarted!: () => void;
    const started = new Promise<void>(resolve => {
      evaluationStarted = resolve;
    });
    let releaseEvaluation!: () => void;
    const evaluationGate = new Promise<void>(resolve => {
      releaseEvaluation = resolve;
    });
    const evaluator: ActivationEvaluator = {
      evaluate: async () => {
        evaluationStarted();
        await evaluationGate;
        return {
          shouldRespond: true,
          urgency: 1,
          confidence: 1
        };
      }
    };
    const spoken: string[] = [];
    const generator: SpeakerGenerator = {
      generate: async input => {
        spoken.push(input.agentId);
        throw new Error("A removed participant must not be launched");
      }
    };
    const scheduler = new ConversationScheduler({ store, evaluator, generator });

    const run = scheduler.runFromHumanMessage(room.id, human.id);
    await started;
    store.removeAgent(room.id, "alpha");
    releaseEvaluation();

    await expect(run).resolves.toMatchObject({
      waves: 0,
      replies: 0,
      stopReason: "silence"
    });
    expect(spoken).toEqual([]);
    store.close();
  });
});
