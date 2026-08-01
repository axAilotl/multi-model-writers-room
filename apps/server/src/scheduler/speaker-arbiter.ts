import type { RoomMessage } from "@writers-room/contracts";

export interface SpeakerArbiterCandidate<T> {
  value: T;
  agentId: string;
  directlyMentioned: boolean;
}

interface ParticipationStat {
  speakCount: number;
  lastSpokeAtMs: number | null;
}

function participationStats(
  messages: readonly RoomMessage[]
): Map<string, ParticipationStat> {
  const stats = new Map<string, ParticipationStat>();
  for (const message of messages) {
    if (
      message.authorType !== "agent" ||
      message.lifecycle !== "active" ||
      message.status !== "complete"
    ) {
      continue;
    }
    const current = stats.get(message.authorId) ?? {
      speakCount: 0,
      lastSpokeAtMs: null
    };
    const spokeAtMs = Date.parse(message.createdAt);
    stats.set(message.authorId, {
      speakCount: current.speakCount + 1,
      lastSpokeAtMs: Number.isFinite(spokeAtMs)
        ? Math.max(current.lastSpokeAtMs ?? spokeAtMs, spokeAtMs)
        : current.lastSpokeAtMs
    });
  }
  return stats;
}

/**
 * Balance candidates that have already chosen to speak.
 *
 * This adapts PSFN Framework's deterministic "speak-least" arbitration rule:
 * direct human addresses win first, then never-spoken participants, then the
 * least-recent and least-used participants, with a stable id tie-break. The
 * activation decision controls admission; ranking never vetoes a willing agent.
 */
export function arbitrateSpeakers<T>(input: {
  candidates: readonly SpeakerArbiterCandidate<T>[];
  messages: readonly RoomMessage[];
  limit: number;
}): T[] {
  const stats = participationStats(input.messages);
  const statOf = (agentId: string): ParticipationStat => stats.get(agentId) ?? {
    speakCount: 0,
    lastSpokeAtMs: null
  };

  return input.candidates
    .slice()
    .sort((left, right) => {
      const mentionOrder = Number(right.directlyMentioned) - Number(left.directlyMentioned);
      if (mentionOrder !== 0) return mentionOrder;

      const leftStat = statOf(left.agentId);
      const rightStat = statOf(right.agentId);
      if (leftStat.lastSpokeAtMs !== rightStat.lastSpokeAtMs) {
        if (leftStat.lastSpokeAtMs === null) return -1;
        if (rightStat.lastSpokeAtMs === null) return 1;
        return leftStat.lastSpokeAtMs - rightStat.lastSpokeAtMs;
      }
      if (leftStat.speakCount !== rightStat.speakCount) {
        return leftStat.speakCount - rightStat.speakCount;
      }
      return left.agentId.localeCompare(right.agentId);
    })
    .slice(0, Math.max(0, input.limit))
    .map(candidate => candidate.value);
}
