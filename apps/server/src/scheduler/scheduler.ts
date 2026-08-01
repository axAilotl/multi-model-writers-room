import type {
  ActivationDecision,
  AgentDefinition,
  GenerationRecord,
  RoomMessage
} from "@writers-room/contracts";
import { RoomStore } from "../storage/room-store.js";
import type { ActivationEvaluationInput } from "./activation-evaluator.js";
import {
  assessRoomPressure,
  effectiveFatigue,
  fatigueAfterWave,
  recoverForHuman,
  recoverIdle
} from "./fatigue.js";
import { arbitrateSpeakers } from "./speaker-arbiter.js";

export interface ActivationEvaluator {
  evaluate(input: ActivationEvaluationInput): Promise<ActivationDecision>;
}

export interface SpeakerGenerator {
  generate(input: {
    roomId: string;
    agentId: string;
    targetMessageId?: string;
  }): Promise<{ message: RoomMessage; generation: GenerationRecord }>;
}

export interface SchedulerResult {
  waves: number;
  replies: number;
  stopReason:
    | "wave_cap"
    | "reply_cap"
    | "silence"
    | "paused"
    | "pressure"
    | "interjection_queued"
    | "continuation_disabled";
}

interface ScoredCandidate {
  agent: AgentDefinition;
  decision: ActivationDecision;
  score: number;
  directlyMentioned: boolean;
}

function lexicalRelevance(agent: AgentDefinition, message: RoomMessage): number {
  const terms = new Set(
    `${agent.name} ${agent.description}`.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []
  );
  const messageTerms = new Set(
    message.content.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []
  );
  for (const term of terms) if (messageTerms.has(term)) return 1;
  return 0;
}

function deterministicJitter(agentId: string, amount: number): number {
  let hash = 2166136261;
  for (const character of agentId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 0xffffffff) * amount;
}

export class ConversationScheduler {
  private readonly activeRooms = new Set<string>();
  private readonly pendingHumanMessages = new Map<string, string[]>();

  constructor(private readonly dependencies: {
    store: RoomStore;
    evaluator: ActivationEvaluator;
    generator: SpeakerGenerator;
    now?: () => number;
  }) {}

  async runFromHumanMessage(
    roomId: string,
    messageId: string
  ): Promise<SchedulerResult> {
    if (this.activeRooms.has(roomId)) {
      const pending = this.pendingHumanMessages.get(roomId) ?? [];
      pending.push(messageId);
      this.pendingHumanMessages.set(roomId, pending);
      return { waves: 0, replies: 0, stopReason: "interjection_queued" };
    }
    this.activeRooms.add(roomId);
    try {
      let nextMessageId = messageId;
      let result: SchedulerResult;
      do {
        result = await this.run(roomId, nextMessageId);
        const pending = this.pendingHumanMessages.get(roomId);
        const nextPendingMessage = pending?.shift();
        if (nextPendingMessage === undefined) return result;
        if (pending && pending.length === 0) {
          this.pendingHumanMessages.delete(roomId);
        }
        nextMessageId = nextPendingMessage;
      } while (true);
    } finally {
      this.pendingHumanMessages.delete(roomId);
      this.activeRooms.delete(roomId);
    }
  }

  private async run(roomId: string, initialMessageId: string): Promise<SchedulerResult> {
    let triggerMessageId = initialMessageId;
    let waves = 0;
    let replies = 0;
    this.applyHumanRecovery(roomId);

    while (true) {
      const snapshot = this.dependencies.store.getSnapshot(roomId);
      if (snapshot.room.status !== "running") {
        return { waves, replies, stopReason: "paused" };
      }
      const trigger = snapshot.messages.find(message => message.id === triggerMessageId);
      if (!trigger) throw new Error(`Trigger message not found: ${triggerMessageId}`);
      const remainingReplies = snapshot.room.settings.maxAutonomousReplies - replies;
      if (remainingReplies <= 0) {
        return { waves, replies, stopReason: "reply_cap" };
      }
      const mentioned = new Set(trigger.mentionedAgentIds);
      const directHumanTargets = trigger.authorType === "human" && mentioned.size > 0;
      const pressure = assessRoomPressure(snapshot.messages, this.now());
      if (
        pressure.hardSuppressed &&
        mentioned.size === 0 &&
        snapshot.room.settings.conversationStyle !== "hollywood"
      ) {
        return { waves, replies, stopReason: "pressure" };
      }
      const candidates = await Promise.all(snapshot.agents.map(async agent => {
        if (directHumanTargets && !mentioned.has(agent.id)) return undefined;
        const storedRuntime = this.dependencies.store.getRuntime(roomId, agent.id);
        const runtime = recoverIdle({
          runtime: storedRuntime,
          nowMs: this.now(),
          intervalMs: snapshot.room.settings.idleRecoveryIntervalMs
        });
        if (runtime !== storedRuntime) {
          this.dependencies.store.updateRuntime(roomId, agent.id, runtime);
        }
        if (runtime.muted) return undefined;
        const directlyMentioned = mentioned.has(agent.id);
        if (
          !directlyMentioned &&
          effectiveFatigue(runtime, false) >= snapshot.room.settings.fatigueThreshold
        ) {
          return undefined;
        }
        let decision: ActivationDecision;
        try {
          decision = await this.dependencies.evaluator.evaluate({
            room: snapshot,
            agent,
            eventMessage: trigger
          });
        } catch {
          decision = directlyMentioned
            ? {
                shouldRespond: true,
                urgency: 1,
                confidence: 1,
                targetMessageId: trigger.id,
                intendedMove: "answer",
                reason: "Direct mention override while activation check was unavailable"
              }
            : {
                shouldRespond: false,
                urgency: 0,
                confidence: 0,
                targetMessageId: trigger.id,
                intendedMove: "defer",
                reason: "Activation check unavailable; yielded to the room arbiter"
              };
        }
        const recentSpeakerPenalty = runtime.consecutiveTurns > 0 ? 0.15 : 0;
        const score =
          decision.urgency * 0.35 +
          decision.confidence * 0.25 +
          (directlyMentioned ? 0.35 : 0) +
          lexicalRelevance(agent, trigger) * 0.15 +
          deterministicJitter(agent.id, snapshot.room.settings.jitter) -
          effectiveFatigue(runtime, directlyMentioned) * 0.4 -
          recentSpeakerPenalty -
          pressure.thresholdBias * (
            snapshot.room.settings.conversationStyle === "hollywood" ? 0.25 : 1
          );
        this.dependencies.store.appendRoomEvent(roomId, {
          type: "activation.recorded",
          agentId: agent.id,
          decision,
          score,
          source: "participant"
        });
        return { agent, decision, score, directlyMentioned } satisfies ScoredCandidate;
      }));
      const evaluated = candidates
        .filter((candidate): candidate is ScoredCandidate => candidate !== undefined);
      let selectionPool = evaluated.filter(candidate =>
        candidate.directlyMentioned || candidate.decision.shouldRespond
      );
      if (selectionPool.length === 0 && trigger.authorType === "human") {
        const fallback = arbitrateSpeakers({
          candidates: evaluated.map(candidate => ({
            value: candidate,
            agentId: candidate.agent.id,
            directlyMentioned: candidate.directlyMentioned
          })),
          messages: snapshot.messages,
          limit: 1
        }).at(0);
        if (fallback) {
          const admitted = {
            ...fallback,
            decision: {
              ...fallback.decision,
              shouldRespond: true,
              urgency: Math.max(0.5, fallback.decision.urgency),
              targetMessageId: trigger.id,
              intendedMove: fallback.decision.intendedMove === "defer"
                ? "answer" as const
                : fallback.decision.intendedMove,
              reason: "Automatic conversation selected one response to the human event"
            }
          } satisfies ScoredCandidate;
          this.dependencies.store.appendRoomEvent(roomId, {
            type: "activation.recorded",
            agentId: admitted.agent.id,
            decision: admitted.decision,
            score: admitted.score,
            source: "scheduler"
          });
          selectionPool = [admitted];
        }
      }
      const selected = arbitrateSpeakers({
        candidates: selectionPool
          .map(candidate => ({
            value: candidate,
            agentId: candidate.agent.id,
            directlyMentioned: candidate.directlyMentioned
          })),
        messages: snapshot.messages,
        limit: Math.min(snapshot.room.settings.maxResponders, remainingReplies)
      });
      if (selected.length === 0) {
        return { waves, replies, stopReason: "silence" };
      }

      const currentAgentIds = new Set(
        this.dependencies.store.listAgents(roomId).map(agent => agent.id)
      );
      const currentSelection = selected.filter(candidate =>
        currentAgentIds.has(candidate.agent.id)
      );
      if (currentSelection.length === 0) {
        return { waves, replies, stopReason: "silence" };
      }

      const settled = await Promise.allSettled(currentSelection.map(candidate => {
        const requestedTarget = candidate.decision.targetMessageId;
        const targetMessageId = requestedTarget !== undefined && snapshot.messages.some(
          message => message.id === requestedTarget && message.lifecycle === "active"
        )
          ? requestedTarget
          : trigger.id;
        return this.dependencies.generator.generate({
          roomId,
          agentId: candidate.agent.id,
          targetMessageId
        });
      }));
      const outputs = settled.flatMap(result =>
        result.status === "fulfilled" ? [result.value] : []
      );
      if (outputs.length === 0) {
        const failure = settled.find(result => result.status === "rejected");
        throw failure?.reason ?? new Error("Every selected speaker failed");
      }
      waves += 1;
      replies += settled.length;
      this.applyWaveFatigue(roomId, outputs);
      triggerMessageId = outputs.at(-1)!.message.id;

      // A human interruption supersedes further agent-to-agent continuation.
      // Finish the in-flight wave, then return control to the outer FIFO.
      if ((this.pendingHumanMessages.get(roomId)?.length ?? 0) > 0) {
        return { waves, replies, stopReason: "interjection_queued" };
      }

      if (waves >= snapshot.room.settings.maxAutonomousWaves) {
        return { waves, replies, stopReason: "wave_cap" };
      }
      if (replies >= snapshot.room.settings.maxAutonomousReplies) {
        return { waves, replies, stopReason: "reply_cap" };
      }
      if (!snapshot.room.settings.agentContinuation) {
        return { waves, replies, stopReason: "continuation_disabled" };
      }
    }
  }

  private applyHumanRecovery(roomId: string): void {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const intervalMs = this.dependencies.store.getRoom(roomId)
      .settings.idleRecoveryIntervalMs;
    for (const agent of this.dependencies.store.listAgents(roomId)) {
      const idleRecovered = recoverIdle({
        runtime: this.dependencies.store.getRuntime(roomId, agent.id),
        nowMs,
        intervalMs
      });
      const recovered = recoverForHuman(
        idleRecovered,
        nowIso
      );
      this.dependencies.store.updateRuntime(roomId, agent.id, recovered);
    }
  }

  private applyWaveFatigue(
    roomId: string,
    outputs: Array<{ message: RoomMessage; generation: GenerationRecord }>
  ): void {
    const nowIso = new Date(this.now()).toISOString();
    const byAgent = new Map(outputs.map(output => [output.generation.agentId, output.generation]));
    for (const agent of this.dependencies.store.listAgents(roomId)) {
      const ownGeneration = byAgent.get(agent.id);
      const next = fatigueAfterWave({
        runtime: this.dependencies.store.getRuntime(roomId, agent.id),
        ...(ownGeneration === undefined ? {} : { ownGeneration }),
        otherSpeakers: outputs.length - (ownGeneration ? 1 : 0),
        nowIso
      });
      this.dependencies.store.updateRuntime(roomId, agent.id, next);
    }
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }
}
