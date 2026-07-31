import { z } from "zod";

export const providerKindSchema = z.enum([
  "openrouter",
  "ollama",
  "openai-compatible"
]);
export type ProviderKind = z.infer<typeof providerKindSchema>;

export const reasoningEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
]);

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
  "read_shared_scratchpad",
  "append_shared_note",
  "update_shared_note",
  "inspect_room_state",
  "yield_turn",
  "request_another_agent"
] as const;

export const contextBudgetSchema = z.object({
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

const systemPromptSchema = z.string().trim().min(1);
const personaPromptSchema = z.string().trim();

export const agentDefinitionSchema = z.object({
  id: z.string().min(1),
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
  .omit({ id: true, capabilities: true })
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
    maxOutputTokens: 1_200,
    reasoning: {
      enabled: true,
      effort: "medium",
      displayMode: "summary"
    },
    tools: [...defaultRoomToolNames],
    contextBudget: {
      softLimitTokens: 120_000,
      hardLimitTokens: 160_000,
      recentTranscriptTokens: 70_000,
      retrievedContextTokens: 24_000,
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

export const roomSettingsSchema = z.object({
  autoMode: z.boolean().default(true),
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
  sourceType: z.enum(["upload", "paste", "generated", "repository", "url"]),
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
  | { sequence: number; type: "activation.recorded"; agentId: string; decision: ActivationDecision; score: number }
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
  activations: Array<{
    sequence: number;
    agentId: string;
    decision: ActivationDecision;
    score: number;
  }>;
  latestSequence: number;
}
