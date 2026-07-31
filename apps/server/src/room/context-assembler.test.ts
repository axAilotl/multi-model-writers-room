import { describe, expect, it } from "vitest";
import type { AgentDefinition, RoomSnapshot } from "@writers-room/contracts";
import { assembleAgentMessages } from "./context-assembler.js";

describe("agent context assembly", () => {
  it("clips a single oversized recent message instead of rejecting the generation", () => {
    const now = "2026-07-31T14:00:00.000Z";
    const agent: AgentDefinition = {
      id: "bounded-agent",
      name: "Bounded Agent",
      description: "Works inside a small context.",
      provider: "openrouter",
      modelId: "fixture",
      systemPrompt: "Respond to the useful portion of the message.",
      temperature: 0.5,
      maxOutputTokens: 256,
      reasoning: { enabled: false, displayMode: "hidden" },
      tools: [],
      contextBudget: {
        softLimitTokens: 1_500,
        hardLimitTokens: 2_000,
        recentTranscriptTokens: 1_000,
        retrievedContextTokens: 0,
        notebookTokens: 0
      }
    };
    const snapshot: RoomSnapshot = {
      room: {
        id: "room-1",
        title: "Large message room",
        status: "running",
        settings: {
          autoMode: true,
          maxResponders: 1,
          maxAutonomousWaves: 1,
          maxAutonomousReplies: 1,
          agentContinuation: false,
          jitter: 0,
          responseLength: "short",
          fatigueThreshold: 0.72,
          idleRecoveryIntervalMs: 600_000
        },
        createdAt: now,
        updatedAt: now
      },
      agents: [agent],
      messages: [{
        id: "message-1",
        roomId: "room-1",
        authorType: "human",
        authorId: "human",
        content: "large ".repeat(20_000),
        createdAt: now,
        mentionedAgentIds: [],
        attachmentIds: [],
        citedChunkIds: [],
        status: "complete",
        visibility: "public",
        lifecycle: "active",
        sequence: 1
      }],
      generations: [],
      runtime: [],
      artifacts: [],
      notes: [],
      activations: [],
      latestSequence: 1
    };

    const messages = assembleAgentMessages({ snapshot, agent });

    expect(messages[0]?.content).toContain("under 250 words");
    expect(messages[1]?.content).toContain("[…context clipped]");
    expect(messages.reduce((total, message) => total + Math.ceil(message.content.length / 4), 0))
      .toBeLessThanOrEqual(agent.contextBudget.hardLimitTokens - agent.maxOutputTokens);
  });
});
