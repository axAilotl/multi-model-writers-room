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
    if (this.activeRooms.has(roomId)) throw new Error("Scheduler is already active for room");
    this.activeRooms.add(roomId);
    try {
      return await this.run(roomId, messageId);
    } finally {
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
      const mentioned = new Set(trigger.mentionedAgentIds);
      const pressure = assessRoomPressure(snapshot.messages, this.now());
      if (pressure.hardSuppressed && mentioned.size === 0) {
        return { waves, replies, stopReason: "pressure" };
      }
      const candidates = await Promise.all(snapshot.agents.map(async agent => {
        const runtime = recoverIdle({
          runtime: this.dependencies.store.getRuntime(roomId, agent.id),
          nowMs: this.now(),
          intervalMs: snapshot.room.settings.idleRecoveryIntervalMs
        });
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
          if (!directlyMentioned) return undefined;
          decision = {
            shouldRespond: true,
            urgency: 1,
            confidence: 1,
            targetMessageId: trigger.id,
            intendedMove: "answer",
            reason: "Direct mention override after activation failure"
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
          pressure.thresholdBias;
        this.dependencies.store.appendRoomEvent(roomId, {
          type: "activation.recorded",
          agentId: agent.id,
          decision,
          score
        });
        if (!directlyMentioned && (!decision.shouldRespond || score < 0.45)) {
          return undefined;
        }
        return { agent, decision, score, directlyMentioned } satisfies ScoredCandidate;
      }));
      const selected = candidates
        .filter((candidate): candidate is ScoredCandidate => candidate !== undefined)
        .sort((left, right) =>
          Number(right.directlyMentioned) - Number(left.directlyMentioned) ||
          right.score - left.score ||
          left.agent.id.localeCompare(right.agent.id)
        )
        .slice(0, snapshot.room.settings.maxResponders);
      if (selected.length === 0) {
        return { waves, replies, stopReason: "silence" };
      }

      const outputs = await Promise.all(selected.map(candidate =>
        this.dependencies.generator.generate({
          roomId,
          agentId: candidate.agent.id,
          targetMessageId: candidate.decision.targetMessageId ?? trigger.id
        })
      ));
      waves += 1;
      replies += outputs.length;
      this.applyWaveFatigue(roomId, outputs);
      triggerMessageId = outputs.at(-1)!.message.id;

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
    const nowIso = new Date(this.now()).toISOString();
    for (const agent of this.dependencies.store.listAgents(roomId)) {
      const recovered = recoverForHuman(
        this.dependencies.store.getRuntime(roomId, agent.id),
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
