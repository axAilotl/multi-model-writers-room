import { describe, expect, it } from "vitest";
import {
  defaultRoomSettings,
  type AgentDefinition,
  type RoomSnapshot
} from "@writers-room/contracts";
import { assembleAgentMessages } from "./context-assembler.js";

describe("agent context assembly", () => {
  it("appends rolling episode summaries and drops their raw messages from the prompt", () => {
    const now = "2026-08-01T14:00:00.000Z";
    const agent: AgentDefinition = {
      id: "rolling-agent",
      name: "Rolling Agent",
      description: "Uses compacted continuity.",
      provider: "openrouter",
      modelId: "fixture",
      systemPrompt: "Continue from room history.",
      temperature: 0,
      maxOutputTokens: 256,
      reasoning: { enabled: false, displayMode: "hidden" },
      tools: [],
      contextBudget: {
        automatic: false,
        softLimitTokens: 4_000,
        hardLimitTokens: 6_000,
        recentTranscriptTokens: 400,
        retrievedContextTokens: 500,
        notebookTokens: 0
      }
    };
    const oldMessage = {
      id: "old-message",
      roomId: "rolling-room",
      authorType: "human" as const,
      authorId: "human",
      content: `ORIGINAL_VERBATIM_SECRET ${"older context ".repeat(100)}`,
      createdAt: now,
      mentionedAgentIds: [],
      attachmentIds: [],
      citedChunkIds: [],
      status: "complete" as const,
      visibility: "public" as const,
      lifecycle: "active" as const,
      sequence: 1
    };
    const recentMessage = {
      ...oldMessage,
      id: "recent-message",
      content: "Continue with the current design.",
      sequence: 2
    };
    const streamingMessage = {
      ...recentMessage,
      id: "streaming-message",
      authorType: "agent" as const,
      authorId: agent.id,
      content: "DO_NOT_TARGET_STREAMING_PLACEHOLDER",
      status: "streaming" as const,
      sequence: 3
    };
    const snapshot: RoomSnapshot = {
      room: {
        id: "rolling-room",
        title: "Rolling room",
        status: "running",
        settings: defaultRoomSettings,
        createdAt: now,
        updatedAt: now
      },
      agents: [agent],
      messages: [oldMessage, recentMessage, streamingMessage],
      generations: [],
      runtime: [],
      artifacts: [],
      notes: [],
      episodes: [{
        id: "episode-1",
        roomId: "rolling-room",
        firstMessageId: oldMessage.id,
        lastMessageId: oldMessage.id,
        firstSequence: 1,
        lastSequence: 1,
        title: "Earlier decision",
        summary: "The room accepted the persistent-table constraint.",
        tokenCount: 12,
        sourceTokenCount: 20,
        createdAt: now
      }],
      activations: [],
      latestSequence: 3
    };

    const messages = assembleAgentMessages({ snapshot, agent });

    expect(messages[1]?.content).toContain("Conversation episode: Earlier decision");
    expect(messages[1]?.content).toContain("persistent-table constraint");
    expect(messages[1]?.content).toContain("Continue with the current design");
    expect(messages[1]?.content).not.toContain("ORIGINAL_VERBATIM_SECRET");
    expect(messages[1]?.content).toContain("Respond to message recent-message");
    expect(messages[1]?.content).not.toContain("DO_NOT_TARGET_STREAMING_PLACEHOLDER");

    const directReply = assembleAgentMessages({
      snapshot,
      agent,
      targetMessageId: oldMessage.id
    });
    expect(directReply[1]?.content).toContain("Explicit reply target:");
    expect(directReply[1]?.content).toContain("ORIGINAL_VERBATIM_SECRET");
    expect(directReply[1]?.content).toContain("Respond to message old-message");
  });

  it("does not let a smaller participant's episode compact a larger participant early", () => {
    const now = "2026-08-01T14:00:00.000Z";
    const oldMessage = {
      id: "old-message",
      roomId: "mixed-context-room",
      authorType: "human" as const,
      authorId: "human",
      content: `KEEP_RAW_FOR_LARGER_MODEL ${"older context ".repeat(100)}`,
      createdAt: now,
      mentionedAgentIds: [],
      attachmentIds: [],
      citedChunkIds: [],
      status: "complete" as const,
      visibility: "public" as const,
      lifecycle: "active" as const,
      sequence: 1
    };
    const agent: AgentDefinition = {
      id: "large-context-agent",
      name: "Large Context Agent",
      description: "Keeps more raw conversation than a smaller peer.",
      provider: "openrouter",
      modelId: "fixture",
      systemPrompt: "Keep the raw transcript while it fits.",
      temperature: 0,
      maxOutputTokens: 256,
      reasoning: { enabled: false, displayMode: "hidden" },
      tools: [],
      contextBudget: {
        automatic: false,
        softLimitTokens: 4_000,
        hardLimitTokens: 6_000,
        recentTranscriptTokens: 2_000,
        retrievedContextTokens: 500,
        notebookTokens: 0
      }
    };
    const snapshot: RoomSnapshot = {
      room: {
        id: "mixed-context-room",
        title: "Mixed context room",
        status: "running",
        settings: defaultRoomSettings,
        createdAt: now,
        updatedAt: now
      },
      agents: [agent],
      messages: [oldMessage],
      generations: [],
      runtime: [],
      artifacts: [],
      notes: [],
      episodes: [{
        id: "small-agent-episode",
        roomId: "mixed-context-room",
        firstMessageId: oldMessage.id,
        lastMessageId: oldMessage.id,
        firstSequence: 1,
        lastSequence: 1,
        title: "Small participant compaction",
        summary: "A smaller participant already compacted this turn.",
        tokenCount: 12,
        sourceTokenCount: 300,
        createdAt: now
      }],
      activations: [],
      latestSequence: 1
    };

    const messages = assembleAgentMessages({ snapshot, agent });

    expect(messages[1]?.content).toContain("KEEP_RAW_FOR_LARGER_MODEL");
    expect(messages[1]?.content).not.toContain("Small participant compaction");
  });

  it("carries source chunk IDs forward so later speakers can verify table evidence", () => {
    const now = "2026-07-31T14:00:00.000Z";
    const agent: AgentDefinition = {
      id: "second-speaker",
      name: "Second Speaker",
      description: "Checks evidence before extending a claim.",
      provider: "openrouter",
      modelId: "fixture",
      systemPrompt: "Advance the discussion from evidence.",
      temperature: 0.5,
      maxOutputTokens: 256,
      reasoning: { enabled: true, effort: "medium", displayMode: "summary" },
      tools: ["read_artifact_chunk"],
      contextBudget: {
        softLimitTokens: 8_000,
        hardLimitTokens: 12_000,
        recentTranscriptTokens: 6_000,
        retrievedContextTokens: 1_000,
        notebookTokens: 0
      }
    };
    const snapshot: RoomSnapshot = {
      room: {
        id: "room-evidence",
        title: "Evidence room",
        status: "running",
        settings: {
          ...defaultRoomSettings,
          autoMode: true,
          maxResponders: 1,
          maxAutonomousWaves: 2,
          maxAutonomousReplies: 2,
          agentContinuation: true,
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
        id: "message-with-source",
        roomId: "room-evidence",
        authorType: "agent",
        authorId: "first-speaker",
        content: "The roadmap defers repository mutation.",
        createdAt: now,
        mentionedAgentIds: [],
        attachmentIds: [],
        citedChunkIds: ["roadmap-chunk-31"],
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

    const messages = assembleAgentMessages({
      snapshot,
      agent,
      targetMessageId: "message-with-source",
      workspaceManifest: "[roadmap.md | artifact-roadmap]\nSummary: Release plan."
    });

    expect(messages[0]?.content).toContain("shared workspace table remains available");
    expect(messages[1]?.content).toContain("Sources: roadmap-chunk-31");
    expect(messages[1]?.content).toContain("verify the cited source chunks");
  });

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
          ...defaultRoomSettings,
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

  it("caps a configured budget at the selected model context length", () => {
    const now = "2026-07-31T14:00:00.000Z";
    const agent: AgentDefinition = {
      id: "model-bounded-agent",
      name: "Model Bounded Agent",
      description: "Cannot exceed its model context.",
      provider: "openrouter",
      modelId: "fixture",
      systemPrompt: "x".repeat(6_000),
      temperature: 0.5,
      maxOutputTokens: 256,
      reasoning: { enabled: false, displayMode: "hidden" },
      tools: [],
      contextBudget: {
        softLimitTokens: 4_000,
        hardLimitTokens: 5_000,
        recentTranscriptTokens: 1_000,
        retrievedContextTokens: 0,
        notebookTokens: 0
      },
      capabilities: {
        contextLength: 1_000,
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
    const snapshot: RoomSnapshot = {
      room: {
        id: "room-2",
        title: "Model bounded room",
        status: "running",
        settings: {
          ...defaultRoomSettings,
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
      messages: [],
      generations: [],
      runtime: [],
      artifacts: [],
      notes: [],
      activations: [],
      latestSequence: 0
    };

    expect(() => assembleAgentMessages({ snapshot, agent }))
      .toThrow(/effective context limit/i);
  });
});
