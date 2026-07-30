import type {
  AgentRuntimeState,
  GenerationRecord,
  RoomMessage
} from "@writers-room/contracts";

export const FATIGUE_POLICY = {
  short: 0.18,
  medium: 0.28,
  long: 0.4,
  consecutive: 0.2,
  directMentionRelief: 0.25,
  humanRecovery: 0.15,
  otherAgentRecovery: 0.08,
  idleRecovery: 0.05
} as const;

export function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function responseFatigue(generation: GenerationRecord): number {
  const tokens = generation.outputTokens ?? Math.ceil(generation.finalText.length / 4);
  if (tokens <= 250) return FATIGUE_POLICY.short;
  if (tokens <= 800) return FATIGUE_POLICY.medium;
  return FATIGUE_POLICY.long;
}

export function recoverForHuman(
  runtime: AgentRuntimeState,
  nowIso: string
): AgentRuntimeState {
  return {
    ...runtime,
    fatigue: clampUnit(runtime.fatigue - FATIGUE_POLICY.humanRecovery),
    consecutiveTurns: 0,
    lastEvaluatedAt: nowIso
  };
}

export function recoverIdle(input: {
  runtime: AgentRuntimeState;
  nowMs: number;
  intervalMs: number;
}): AgentRuntimeState {
  const last = input.runtime.lastEvaluatedAt
    ? Date.parse(input.runtime.lastEvaluatedAt)
    : input.nowMs;
  const intervals = Math.max(0, Math.floor((input.nowMs - last) / input.intervalMs));
  if (intervals === 0) return input.runtime;
  return {
    ...input.runtime,
    fatigue: clampUnit(
      input.runtime.fatigue - intervals * FATIGUE_POLICY.idleRecovery
    ),
    lastEvaluatedAt: new Date(last + intervals * input.intervalMs).toISOString()
  };
}

export function effectiveFatigue(
  runtime: AgentRuntimeState,
  directlyMentioned: boolean
): number {
  return clampUnit(
    runtime.fatigue -
      (directlyMentioned ? FATIGUE_POLICY.directMentionRelief : 0)
  );
}

export function fatigueAfterWave(input: {
  runtime: AgentRuntimeState;
  ownGeneration?: GenerationRecord;
  otherSpeakers: number;
  nowIso: string;
}): AgentRuntimeState {
  const speakingCost = input.ownGeneration
    ? responseFatigue(input.ownGeneration) +
      (input.runtime.consecutiveTurns > 0 ? FATIGUE_POLICY.consecutive : 0)
    : 0;
  return {
    ...input.runtime,
    fatigue: clampUnit(
      input.runtime.fatigue +
        speakingCost -
        input.otherSpeakers * FATIGUE_POLICY.otherAgentRecovery
    ),
    consecutiveTurns: input.ownGeneration
      ? input.runtime.consecutiveTurns + 1
      : 0,
    ...(input.ownGeneration
      ? { lastSpokeAt: input.nowIso }
      : {}),
    lastEvaluatedAt: input.nowIso
  };
}

export interface RoomPressure {
  pressure: number;
  thresholdBias: number;
  wrapUpInvited: boolean;
  hardSuppressed: boolean;
}

export function assessRoomPressure(
  messages: readonly RoomMessage[],
  nowMs: number,
  halfLifeMs = 600_000
): RoomPressure {
  let pressure = 0;
  for (const message of messages) {
    if (
      message.authorType !== "agent" ||
      message.lifecycle !== "active" ||
      message.status !== "complete"
    ) {
      continue;
    }
    const ageMs = nowMs - Date.parse(message.createdAt);
    if (ageMs < 0 || ageMs > halfLifeMs * 6) continue;
    pressure += 2 ** (-ageMs / halfLifeMs);
  }
  const elevatedThreshold = 3;
  const wrapThreshold = 5;
  const hardThreshold = 7;
  const thresholdBias = pressure <= elevatedThreshold
    ? 0
    : Math.min(0.2, ((pressure - elevatedThreshold) / (wrapThreshold - elevatedThreshold)) * 0.2);
  return {
    pressure,
    thresholdBias,
    wrapUpInvited: pressure >= wrapThreshold,
    hardSuppressed: pressure >= hardThreshold
  };
}

