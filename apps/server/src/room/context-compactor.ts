import {
  deriveContextPolicy,
  type AgentDefinition,
  type ConversationEpisode,
  type RoomMessage
} from "@writers-room/contracts";
import { RoomStore } from "../storage/room-store.js";

function estimateMessageTokens(message: RoomMessage): number {
  return Math.ceil((message.content.length + 40) / 4);
}

function episodeSummary(
  messages: RoomMessage[],
  agents: AgentDefinition[]
): string {
  const lines = messages.map(message => {
    const author = message.authorType === "human"
      ? "Human"
      : agents.find(agent => agent.id === message.authorId)?.name ?? message.authorId;
    const content = message.content.replace(/\s+/g, " ").trim();
    const clipped = content.length > 700 ? `${content.slice(0, 697)}…` : content;
    const sources = message.citedChunkIds.length > 0
      ? ` [sources: ${message.citedChunkIds.join(", ")}]`
      : "";
    const reply = message.replyToMessageId === undefined
      ? ""
      : ` [reply: ${message.replyToMessageId}]`;
    return `- ${author}: ${clipped}${reply}${sources}`;
  });
  const summary = [
    "Objective rolling summary of the compacted public discussion:",
    ...lines
  ].join("\n");
  const maximumCharacters = 24_000;
  return summary.length <= maximumCharacters
    ? summary
    : `${summary.slice(0, maximumCharacters - 22).trim()}\n[…episode clipped]`;
}

export function ensureConversationCompaction(input: {
  store: RoomStore;
  roomId: string;
  agent: AgentDefinition;
}): ConversationEpisode | undefined {
  const policy = deriveContextPolicy({
    contextBudget: input.agent.contextBudget,
    modelContextLength: input.agent.capabilities?.contextLength
  });
  const episodes = input.store.listConversationEpisodes(input.roomId);
  const lastCompactedSequence = episodes.at(-1)?.lastSequence ?? -1;
  const snapshot = input.store.getSnapshot(input.roomId);
  const candidates = snapshot.messages.filter(message =>
    message.sequence > lastCompactedSequence &&
    message.lifecycle === "active" &&
    message.status !== "streaming" &&
    (message.authorType === "human" || message.authorType === "agent")
  );
  const candidateTokens = candidates.map(estimateMessageTokens);
  const totalTokens = candidateTokens.reduce((sum, tokens) => sum + tokens, 0);
  if (totalTokens < policy.compactionTriggerTokens) return undefined;

  const recentTarget = Math.max(
    1,
    Math.floor(policy.recentTranscriptTokens * 0.45)
  );
  // Keep the newest complete public turn raw. Token pressure, not an arbitrary
  // message count, decides how much else remains; a few giant pasted messages
  // must still be compactable.
  const minimumRecentMessages = Math.min(1, candidates.length);
  const maximumCompactCount = candidates.length - minimumRecentMessages;
  let compactCount = 0;
  let remainingTokens = totalTokens;
  while (
    compactCount < maximumCompactCount &&
    remainingTokens > recentTarget
  ) {
    remainingTokens -= candidateTokens[compactCount]!;
    compactCount += 1;
  }
  if (compactCount === 0) return undefined;

  const compacted = candidates.slice(0, compactCount);
  const first = compacted[0]!;
  const last = compacted.at(-1)!;
  const summary = episodeSummary(compacted, snapshot.agents);
  return input.store.createConversationEpisode({
    roomId: input.roomId,
    firstMessageId: first.id,
    lastMessageId: last.id,
    firstSequence: first.sequence,
    lastSequence: last.sequence,
    title: `Discussion ${first.sequence}–${last.sequence}`,
    summary,
    tokenCount: Math.ceil(summary.length / 4),
    sourceTokenCount: candidateTokens.slice(0, compactCount)
      .reduce((sum, tokens) => sum + tokens, 0)
  });
}
