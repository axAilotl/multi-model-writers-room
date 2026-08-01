import { z } from "zod";

export const providerKinds = [
  "openrouter",
  "ollama",
  "openai-compatible"
] as const;
export const providerKindSchema = z.enum(providerKinds);
export type ProviderKind = z.infer<typeof providerKindSchema>;

export const providerConnectionConfigurationSchema = z.object({
  provider: providerKindSchema,
  baseUrl: z.string().trim().min(1).max(2_048).optional(),
  apiKey: z.string().min(1).max(32_768).optional()
});
export type ProviderConnectionConfiguration = z.infer<
  typeof providerConnectionConfigurationSchema
>;

export const providerConnectionUpdateSchema = z.object({
  baseUrl: z.string().trim().min(1).max(2_048).optional(),
  apiKey: z.string().min(1).max(32_768).optional()
});
export type ProviderConnectionUpdate = z.infer<
  typeof providerConnectionUpdateSchema
>;

export const providerConnectionStatusSchema = z.object({
  provider: providerKindSchema,
  configured: z.boolean(),
  baseUrl: z.string().optional(),
  hasApiKey: z.boolean(),
  endpointSource: z.enum(["settings", "environment", "built-in", "runtime", "none"]),
  credentialSource: z.enum(["settings", "environment", "runtime", "none"])
});
export type ProviderConnectionStatus = z.infer<
  typeof providerConnectionStatusSchema
>;

export const reasoningEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const reasoningConfigSchema = z.object({
  enabled: z.boolean().default(false),
  effort: reasoningEffortSchema.optional(),
  maxTokens: z.number().int().positive().optional(),
  displayMode: z.enum(["full", "summary", "hidden"]).default("summary")
});
export type ReasoningConfig = z.infer<typeof reasoningConfigSchema>;

export const modelCapabilitiesSchema = z.object({
  contextLength: z.number().int().positive(),
  textInput: z.boolean(),
  imageInput: z.boolean(),
  pdfInput: z.boolean(),
  toolCalling: z.boolean(),
  structuredOutput: z.boolean(),
  reasoningInputControl: z.boolean(),
  reasoningOutput: z.boolean(),
  promptCaching: z.boolean()
});
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

export interface ModelDescriptor {
  id: string;
  name: string;
  capabilities: ModelCapabilities;
  reasoning?: {
    supportedEfforts?: Array<ReasoningEffort | "none"> | null;
    defaultEffort?: ReasoningEffort | "none";
    defaultEnabled?: boolean;
    supportsMaxTokens?: boolean;
    mandatory?: boolean;
  };
}

export const defaultModelSelectionSchema = z.object({
  provider: providerKindSchema,
  modelId: z.string().trim().min(1)
});
export type DefaultModelSelection = z.infer<typeof defaultModelSelectionSchema>;

export const defaultRoomToolNames = [
  "list_workspace",
  "get_artifact_summary",
  "search_workspace",
  "find_exact_text",
  "read_artifact_chunk",
  "read_artifact_range",
  "ask_table_researcher",
  "search_conversation_history",
  "read_message_range",
  "read_shared_scratchpad",
  "append_shared_note",
  "update_shared_note",
  "inspect_room_state",
  "yield_turn",
  "request_another_agent"
] as const;

export const contextBudgetSchema = z.object({
  automatic: z.boolean().optional(),
  softLimitTokens: z.number().int().positive(),
  hardLimitTokens: z.number().int().positive(),
  recentTranscriptTokens: z.number().int().nonnegative(),
  retrievedContextTokens: z.number().int().nonnegative(),
  notebookTokens: z.number().int().nonnegative()
}).refine(
  value => value.softLimitTokens <= value.hardLimitTokens,
  "soft limit must not exceed hard limit"
);
export type ContextBudget = z.infer<typeof contextBudgetSchema>;

export interface EffectiveContextPolicy {
  advertisedContextTokens: number;
  workingLimitTokens: number;
  hardLimitTokens: number;
  systemPersonaTokens: number;
  retrievedContextTokens: number;
  recentTranscriptTokens: number;
  compactionTriggerTokens: number;
  automatic: boolean;
}

export function deriveContextPolicy(input: {
  contextBudget: ContextBudget;
  modelContextLength?: number | undefined;
}): EffectiveContextPolicy {
  const configured = input.contextBudget;
  const advertisedContextTokens = Math.max(
    1,
    input.modelContextLength ?? configured.hardLimitTokens
  );
  const automatic = configured.automatic === true;
  if (!automatic) {
    const hardLimitTokens = Math.min(
      configured.hardLimitTokens,
      advertisedContextTokens
    );
    const workingLimitTokens = Math.min(
      configured.softLimitTokens,
      hardLimitTokens
    );
    const recentTranscriptTokens = Math.min(
      configured.recentTranscriptTokens,
      workingLimitTokens
    );
    return {
      advertisedContextTokens,
      workingLimitTokens,
      hardLimitTokens,
      systemPersonaTokens: Math.max(256, Math.floor(workingLimitTokens / 6)),
      retrievedContextTokens: Math.min(
        configured.retrievedContextTokens,
        workingLimitTokens
      ),
      recentTranscriptTokens,
      compactionTriggerTokens: Math.max(
        1,
        Math.floor(recentTranscriptTokens * 0.7)
      ),
      automatic
    };
  }

  const isLargeContextModel = advertisedContextTokens >= 512_000;
  const workingLimitTokens = advertisedContextTokens <= 192_000
    ? Math.min(advertisedContextTokens, 128_000)
    : Math.min(advertisedContextTokens, 256_000);
  const hardLimitTokens = isLargeContextModel
    ? Math.min(advertisedContextTokens, 512_000)
    : workingLimitTokens;
  // The requested 1:2:3 weighting is normalized to a six-part window so all
  // three allocations can coexist without exceeding the model context.
  const systemPersonaTokens = Math.floor(workingLimitTokens / 6);
  const retrievedContextTokens = Math.floor(workingLimitTokens / 3);
  const recentTranscriptTokens =
    workingLimitTokens - systemPersonaTokens - retrievedContextTokens;
  return {
    advertisedContextTokens,
    workingLimitTokens,
    hardLimitTokens,
    systemPersonaTokens,
    retrievedContextTokens,
    recentTranscriptTokens,
    compactionTriggerTokens: Math.max(
      1,
      Math.floor(recentTranscriptTokens * 0.7)
    ),
    automatic
  };
}

const systemPromptSchema = z.string().trim().min(1);
const personaPromptSchema = z.string().trim();

export const agentDefinitionSchema = z.object({
  id: z.string().min(1),
  voiceTemplateId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  provider: providerKindSchema,
  modelId: z.string().trim().min(1),
  systemPrompt: systemPromptSchema,
  personaPrompt: personaPromptSchema.optional(),
  temperature: z.number().min(0).max(2).default(0.7),
  topP: z.number().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().min(64).max(32_768).default(1_200),
  reasoning: reasoningConfigSchema,
  tools: z.array(z.string()).default([]),
  contextBudget: contextBudgetSchema,
  capabilities: modelCapabilitiesSchema.optional()
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

export const voiceTemplateInputSchema = agentDefinitionSchema
  .omit({ id: true, voiceTemplateId: true, capabilities: true })
  .extend({
    title: z.string().trim().min(1).max(120)
  });
export type VoiceTemplateInput = z.infer<typeof voiceTemplateInputSchema>;

export function createDefaultVoiceConfiguration(): Pick<
  VoiceTemplateInput,
  "temperature" | "maxOutputTokens" | "reasoning" | "tools" | "contextBudget"
> {
  return {
    temperature: 0.7,
    maxOutputTokens: 2_400,
    reasoning: {
      enabled: true,
      effort: "medium",
      displayMode: "summary"
    },
    tools: [...defaultRoomToolNames],
    contextBudget: {
      automatic: true,
      softLimitTokens: 240_000,
      hardLimitTokens: 512_000,
      recentTranscriptTokens: 128_000,
      retrievedContextTokens: 85_333,
      notebookTokens: 0
    }
  };
}

export const voiceTemplateGenerationRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  sourceText: z.string().trim().min(20).max(30_000)
});
export type VoiceTemplateGenerationRequest = z.infer<
  typeof voiceTemplateGenerationRequestSchema
>;

// Keep PATCH parsing separate from `voiceTemplateInputSchema.partial()`.
// Zod retains field defaults through `partial()`, which would turn omitted
// properties into destructive resets during a partial update.
export const voiceTemplatePatchSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  provider: providerKindSchema.optional(),
  modelId: z.string().trim().min(1).optional(),
  systemPrompt: systemPromptSchema.optional(),
  personaPrompt: personaPromptSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().min(64).max(32_768).optional(),
  reasoning: reasoningConfigSchema.optional(),
  tools: z.array(z.string()).optional(),
  contextBudget: contextBudgetSchema.optional()
}).refine(
  value => Object.keys(value).length > 0,
  "At least one field is required"
);
export type VoiceTemplatePatch = z.infer<typeof voiceTemplatePatchSchema>;

export const voiceTemplateSchema = voiceTemplateInputSchema.extend({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type VoiceTemplate = z.infer<typeof voiceTemplateSchema>;

export const voiceTemplateLibraryItemSchema = z.object({
  id: z.string().min(1),
  voiceTemplateId: z.string().min(1),
  filename: z.string().trim().min(1).max(500),
  mediaType: z.string().trim().min(1).max(200),
  sha256: z.string().length(64),
  byteSize: z.number().int().nonnegative(),
  summary: z.string(),
  outline: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type VoiceTemplateLibraryItem = z.infer<
  typeof voiceTemplateLibraryItemSchema
>;

export const roomSettingsSchema = z.object({
  autoMode: z.boolean().default(true),
  conversationStyle: z.enum([
    "conversation", "hollywood", "debate", "deep-study"
  ]).default("conversation"),
  deliberationTurns: z.number().int().min(1).max(3).default(1),
  maxResponders: z.number().int().min(1).max(3).default(2),
  maxAutonomousWaves: z.number().int().min(1).max(12).default(3),
  maxAutonomousReplies: z.number().int().min(1).max(24).default(6),
  agentContinuation: z.boolean().default(true),
  jitter: z.number().min(0).max(0.25).default(0.06),
  responseLength: z.enum(["short", "medium", "long"]).default("medium"),
  fatigueThreshold: z.number().min(0).max(1).default(0.72),
  idleRecoveryIntervalMs: z.number().int().min(60_000).default(600_000)
});
export type RoomSettings = z.infer<typeof roomSettingsSchema>;

export const defaultRoomSettings: RoomSettings = roomSettingsSchema.parse({});

export const roomModePresets = {
  conversation: roomSettingsSchema.parse({
    conversationStyle: "conversation",
    deliberationTurns: 1,
    maxResponders: 2,
    maxAutonomousWaves: 3,
    maxAutonomousReplies: 6,
    agentContinuation: true,
    jitter: 0.04,
    responseLength: "medium",
    fatigueThreshold: 0.72
  }),
  hollywood: roomSettingsSchema.parse({
    conversationStyle: "hollywood",
    deliberationTurns: 1,
    maxResponders: 3,
    maxAutonomousWaves: 8,
    maxAutonomousReplies: 18,
    agentContinuation: true,
    jitter: 0.12,
    responseLength: "short",
    fatigueThreshold: 0.82
  }),
  debate: roomSettingsSchema.parse({
    conversationStyle: "debate",
    deliberationTurns: 1,
    maxResponders: 2,
    maxAutonomousWaves: 6,
    maxAutonomousReplies: 12,
    agentContinuation: true,
    jitter: 0.02,
    responseLength: "medium",
    fatigueThreshold: 0.78
  }),
  "deep-study": roomSettingsSchema.parse({
    conversationStyle: "deep-study",
    deliberationTurns: 3,
    maxResponders: 1,
    maxAutonomousWaves: 3,
    maxAutonomousReplies: 3,
    agentContinuation: true,
    jitter: 0,
    responseLength: "long",
    fatigueThreshold: 0.72
  })
} satisfies Record<RoomSettings["conversationStyle"], RoomSettings>;

export const roomSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(160),
  status: z.enum(["running", "paused"]),
  settings: roomSettingsSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type Room = z.infer<typeof roomSchema>;

export const messageStatusSchema = z.enum([
  "streaming",
  "complete",
  "interrupted",
  "failed",
  "edited"
]);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const roomMessageSchema = z.object({
  id: z.string().min(1),
  roomId: z.string().min(1),
  authorType: z.enum(["human", "agent", "system", "tool"]),
  authorId: z.string().min(1),
  content: z.string(),
  createdAt: z.string().datetime(),
  replyToMessageId: z.string().optional(),
  mentionedAgentIds: z.array(z.string()).default([]),
  attachmentIds: z.array(z.string()).default([]),
  citedChunkIds: z.array(z.string()).default([]),
  generationId: z.string().optional(),
  status: messageStatusSchema,
  visibility: z.literal("public"),
  lifecycle: z.enum(["active", "deleted", "superseded"]).default("active"),
  revisionOfMessageId: z.string().optional(),
  sequence: z.number().int().nonnegative()
});
export type RoomMessage = z.infer<typeof roomMessageSchema>;

export const conversationEpisodeSchema = z.object({
  id: z.string().min(1),
  roomId: z.string().min(1),
  firstMessageId: z.string().min(1),
  lastMessageId: z.string().min(1),
  firstSequence: z.number().int().nonnegative(),
  lastSequence: z.number().int().nonnegative(),
  title: z.string().min(1),
  summary: z.string(),
  tokenCount: z.number().int().nonnegative(),
  sourceTokenCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime()
});
export type ConversationEpisode = z.infer<typeof conversationEpisodeSchema>;

export const ROOM_PRESSURE_POLICY = {
  halfLifeMs: 600_000,
  elevatedThreshold: 3,
  wrapThreshold: 5,
  hardThreshold: 7,
  maximumAgeHalfLives: 6
} as const;

export function calculateRoomPressure(
  messages: readonly RoomMessage[],
  nowMs: number,
  halfLifeMs: number = ROOM_PRESSURE_POLICY.halfLifeMs
): number {
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
    if (
      !Number.isFinite(ageMs) ||
      ageMs < 0 ||
      ageMs > halfLifeMs * ROOM_PRESSURE_POLICY.maximumAgeHalfLives
    ) {
      continue;
    }
    pressure += 2 ** (-ageMs / halfLifeMs);
  }
  return pressure;
}

export const intendedMoveSchema = z.enum([
  "answer",
  "challenge",
  "extend",
  "clarify",
  "connect",
  "summarize",
  "retrieve",
  "defer"
]);

export const activationDecisionSchema = z.object({
  shouldRespond: z.boolean(),
  urgency: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  targetMessageId: z.string().optional(),
  intendedMove: intendedMoveSchema.optional(),
  reason: z.string().max(500).optional()
});
export type ActivationDecision = z.infer<typeof activationDecisionSchema>;

export const agentRuntimeStateSchema = z.object({
  agentId: z.string(),
  roomId: z.string(),
  fatigue: z.number().min(0).max(1),
  activation: z.number().min(0).max(1),
  consecutiveTurns: z.number().int().nonnegative(),
  muted: z.boolean(),
  lastSpokeAt: z.string().datetime().optional(),
  lastEvaluatedAt: z.string().datetime().optional(),
  pendingIntent: activationDecisionSchema.optional()
});
export type AgentRuntimeState = z.infer<typeof agentRuntimeStateSchema>;

export const generationRecordSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  messageId: z.string(),
  agentId: z.string(),
  provider: providerKindSchema,
  requestedModelId: z.string(),
  actualModelId: z.string().optional(),
  actualProvider: z.string().optional(),
  status: z.enum(["queued", "streaming", "complete", "interrupted", "failed"]),
  finalText: z.string().default(""),
  reasoningText: z.string().optional(),
  reasoningSummary: z.string().optional(),
  reasoningConfig: reasoningConfigSchema.optional(),
  deliberationPasses: z.array(z.object({
    ordinal: z.number().int().positive(),
    text: z.string(),
    createdAt: z.string().datetime()
  })).optional(),
  retrievedChunkIds: z.array(z.string()).default([]),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  latencyMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional()
});
export type GenerationRecord = z.infer<typeof generationRecordSchema>;

const normalizedToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string()
});

export const normalizedChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
  toolCalls: z.array(normalizedToolCallSchema).optional()
});
export type NormalizedChatMessage = z.infer<typeof normalizedChatMessageSchema>;

export interface NormalizedToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface NormalizedChatRequest {
  modelId: string;
  messages: NormalizedChatMessage[];
  temperature: number;
  topP?: number;
  maxOutputTokens: number;
  reasoning: ReasoningConfig;
  tools: NormalizedToolDefinition[];
  sessionId: string;
  signal?: AbortSignal;
  structuredOutput?: Record<string, unknown>;
}

export type NormalizedGenerationEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "reasoning-summary"; text: string }
  | { type: "tool-call"; id: string; name: string; arguments: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; reasoningTokens?: number; costUsd?: number }
  | { type: "routing"; modelId?: string; provider?: string }
  | { type: "done"; finishReason?: string };

export const artifactSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  filename: z.string(),
  mediaType: z.string(),
  sha256: z.string().length(64),
  byteSize: z.number().int().nonnegative(),
  sourceType: z.enum([
    "upload", "paste", "generated", "repository", "persona-memory", "url"
  ]),
  ownerAgentId: z.string().min(1).optional(),
  voiceTemplateLibraryItemId: z.string().min(1).optional(),
  title: z.string().optional(),
  summary: z.string(),
  outline: z.string().optional(),
  ingestionStatus: z.enum(["queued", "processing", "ready", "failed"]),
  ingestionStage: z.string(),
  error: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type WorkspaceArtifact = z.infer<typeof artifactSchema>;

export const artifactChunkSchema = z.object({
  id: z.string(),
  artifactId: z.string(),
  ordinal: z.number().int().nonnegative(),
  text: z.string(),
  tokenCount: z.number().int().nonnegative(),
  pageNumber: z.number().int().positive().optional(),
  headingPath: z.string().optional(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional()
});
export type ArtifactChunk = z.infer<typeof artifactChunkSchema>;

export const searchResultSchema = z.object({
  chunk: artifactChunkSchema,
  artifact: artifactSchema,
  score: z.number(),
  lexicalRank: z.number().int().positive().optional(),
  vectorRank: z.number().int().positive().optional(),
  citation: z.string()
});
export type WorkspaceSearchResult = z.infer<typeof searchResultSchema>;

export const sharedNoteSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  authorType: z.enum(["human", "agent"]),
  authorId: z.string(),
  category: z.string().optional(),
  text: z.string(),
  archivedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type SharedNote = z.infer<typeof sharedNoteSchema>;

export type RoomStreamEvent =
  | { sequence: number; type: "room.snapshot"; room: Room }
  | { sequence: number; type: "message.created" | "message.updated"; message: RoomMessage }
  | { sequence: number; type: "generation.updated"; generation: GenerationRecord }
  | { sequence: number; type: "runtime.updated"; runtime: AgentRuntimeState }
  | { sequence: number; type: "artifact.updated"; artifact: WorkspaceArtifact }
  | { sequence: number; type: "artifact.deleted"; artifactId: string }
  | { sequence: number; type: "scratchpad.updated"; note: SharedNote }
  | {
      sequence: number;
      type: "activation.recorded";
      agentId: string;
      decision: ActivationDecision;
      score: number;
      source: "participant" | "scheduler";
    }
  | { sequence: number; type: "system.error"; message: string };

export type RoomStreamEventInput =
  RoomStreamEvent extends infer Event
    ? Event extends { sequence: number }
      ? Omit<Event, "sequence">
      : never
    : never;

export interface RoomSnapshot {
  room: Room;
  agents: AgentDefinition[];
  messages: RoomMessage[];
  generations: GenerationRecord[];
  runtime: AgentRuntimeState[];
  artifacts: WorkspaceArtifact[];
  notes: SharedNote[];
  episodes?: ConversationEpisode[];
  activations: Array<{
    sequence: number;
    agentId: string;
    decision: ActivationDecision;
    score: number;
    source: "participant" | "scheduler";
  }>;
  latestSequence: number;
}
