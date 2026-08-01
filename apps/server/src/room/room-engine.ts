import type {
  AgentDefinition,
  GenerationRecord,
  NormalizedChatMessage,
  NormalizedGenerationEvent,
  PsfnDeliveryState,
  RoomMessage
} from "@writers-room/contracts";
import { deriveContextPolicy } from "@writers-room/contracts";
import type { ModelProvider } from "../providers/model-provider.js";
import { PsfnProvider, PsfnProviderError } from "../providers/psfn.js";
import { uuidv7 } from "../shared/id.js";
import { RoomStore } from "../storage/room-store.js";
import type {
  ToolExecutionResult,
  ToolExecutor
} from "../tools/room-tools.js";
import { assembleAgentMessages } from "./context-assembler.js";
import { ensureConversationCompaction } from "./context-compactor.js";
import { assemblePsfnTurn, renderPsfnEnvelope } from "./psfn-turn-assembler.js";

const MAX_TOOL_ROUNDS = 8;
const MAX_TOOL_CALLS = 24;

function estimateConversationTokens(messages: NormalizedChatMessage[]): number {
  return messages.reduce((sum, message) => sum + Math.ceil((
    message.content.length +
    (message.toolCalls === undefined ? 0 : JSON.stringify(message.toolCalls).length) +
    24
  ) / 4), 0);
}

interface ExactHistoryPage {
  kind: "canonical_message_range";
  messages: Array<{
    messageId: string;
    sequence: number;
    author: string;
    createdAt: string;
    lifecycle: string;
    contentOffset: number;
    content: string;
  }>;
  continuation: {
    first_message_id: string;
    last_message_id: string;
    first_message_offset: number;
  } | null;
}

function clipExactHistoryResult(
  text: string,
  characterLimit: number
): string | undefined {
  let page: ExactHistoryPage;
  try {
    page = JSON.parse(text) as ExactHistoryPage;
  } catch {
    return undefined;
  }
  if (
    page.kind !== "canonical_message_range" ||
    !Array.isArray(page.messages) ||
    page.messages.some(message =>
      typeof message.messageId !== "string" ||
      typeof message.content !== "string" ||
      typeof message.contentOffset !== "number"
    )
  ) {
    return undefined;
  }
  const retained: ExactHistoryPage["messages"] = [];
  const serialize = (
    messages: ExactHistoryPage["messages"],
    continuation: ExactHistoryPage["continuation"]
  ) => JSON.stringify({
    kind: "canonical_message_range",
    messages,
    continuation
  });
  for (let index = 0; index < page.messages.length; index += 1) {
    const message = page.messages[index]!;
    const next = page.messages[index + 1];
    const afterFull = next
      ? {
          first_message_id: next.messageId,
          last_message_id: page.continuation?.last_message_id ??
            page.messages.at(-1)!.messageId,
          first_message_offset: next.contentOffset
        }
      : page.continuation;
    if (serialize([...retained, message], afterFull).length <= characterLimit) {
      retained.push(message);
      continue;
    }
    let low = 0;
    let high = message.content.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const cursor = {
        first_message_id: message.messageId,
        last_message_id: page.continuation?.last_message_id ??
          page.messages.at(-1)!.messageId,
        first_message_offset: message.contentOffset + middle
      };
      const candidate = { ...message, content: message.content.slice(0, middle) };
      if (serialize([...retained, candidate], cursor).length <= characterLimit) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    if (low === 0) {
      const cursor = {
        first_message_id: message.messageId,
        last_message_id: page.continuation?.last_message_id ??
          page.messages.at(-1)!.messageId,
        first_message_offset: message.contentOffset
      };
      const priorPage = serialize(retained, cursor);
      return priorPage.length <= characterLimit ? priorPage : undefined;
    }
    const candidate = { ...message, content: message.content.slice(0, low) };
    return serialize([...retained, candidate], {
      first_message_id: message.messageId,
      last_message_id: page.continuation?.last_message_id ??
        page.messages.at(-1)!.messageId,
      first_message_offset: message.contentOffset + low
    });
  }
  return serialize(retained, page.continuation);
}

function clipToolResult(text: string, characterLimit: number): string {
  if (text.length <= characterLimit) return text;
  if (characterLimit <= 160) return text.slice(0, Math.max(0, characterLimit));
  const exactHistory = clipExactHistoryResult(text, characterLimit);
  if (exactHistory) return exactHistory;
  const tailLength = Math.min(600, Math.floor(characterLimit / 3));
  const marker = "\n[…tool result clipped to the participant context budget…]\n";
  const headLength = Math.max(0, characterLimit - tailLength - marker.length);
  return `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`;
}

export function fitConversationToTokenLimit(
  messages: NormalizedChatMessage[],
  tokenLimit: number
): void {
  let current = estimateConversationTokens(messages);
  if (current <= tokenLimit) return;
  const toolIndexes = messages.flatMap((message, index) =>
    message.role === "tool" ? [index] : []
  );
  for (const index of toolIndexes) {
    if (current <= tokenLimit) break;
    const message = messages[index]!;
    const overCharacters = (current - tokenLimit) * 4;
    const nextLength = Math.max(512, message.content.length - overCharacters - 80);
    const clipped = clipToolResult(message.content, nextLength);
    messages[index] = { ...message, content: clipped };
    current = estimateConversationTokens(messages);
  }
  if (current > tokenLimit) {
    throw new Error(
      `Tool conversation exceeds the participant context limit of ${tokenLimit} input tokens`
    );
  }
}

function clipDraftToTokens(text: string, tokenLimit: number): string {
  const characterLimit = tokenLimit * 4;
  if (text.length <= characterLimit) return text.trim();
  return `${text.slice(0, Math.max(0, characterLimit - 21)).trim()}\n[…draft clipped]`;
}

interface ActiveGeneration {
  roomId: string;
  agentId: string;
  controller: AbortController;
  completion: Promise<void>;
}

export class RoomEngine {
  private readonly active = new Map<string, ActiveGeneration>();

  constructor(
    private readonly store: RoomStore,
    private readonly providers: ReadonlyMap<string, ModelProvider>,
    private readonly tools?: ToolExecutor
  ) {}

  listActive(roomId: string): string[] {
    return [...this.active.entries()]
      .filter(([, generation]) => generation.roomId === roomId)
      .map(([generationId]) => generationId);
  }

  async generate(input: {
    roomId: string;
    agentId: string;
    targetMessageId?: string;
    retryPsfnState?: PsfnDeliveryState;
    resynchronizePsfn?: boolean;
  }): Promise<{ message: RoomMessage; generation: GenerationRecord }> {
    const snapshot = this.store.getSnapshot(input.roomId);
    if (snapshot.room.status !== "running") throw new Error("Room is paused");
    const agent = snapshot.agents.find(candidate => candidate.id === input.agentId);
    if (!agent) throw new Error(`Agent not found in room: ${input.agentId}`);
    if (this.store.getRuntime(input.roomId, agent.id).muted) {
      throw new Error(`Agent is muted: ${agent.id}`);
    }
    const provider = this.providers.get(agent.provider);
    if (!provider) throw new Error(`Provider is not configured: ${agent.provider}`);
    const psfnState = provider.execution?.semantics === "stateful-companion"
      ? this.store.getPsfnDeliveryState(input.roomId, input.agentId)
      : undefined;
    if (
      provider.execution?.semantics === "stateful-companion" &&
      input.retryPsfnState === undefined &&
      input.resynchronizePsfn !== true &&
      psfnState?.deliveryStatus === "ambiguous"
    ) {
      throw new Error("PSFN delivery is ambiguous and requires human resolution");
    }
    if (
      provider instanceof PsfnProvider &&
      !provider.pinnedCompanionId &&
      psfnState?.remoteCompanionId
    ) {
      provider.pinExpectedIdentity(psfnState.remoteCompanionId);
    }
    const capabilities = provider.execution?.semantics === "stateful-companion"
      ? await provider.getCapabilities(agent.modelId)
      : await provider.getCapabilities(agent.modelId).catch(() => undefined);
    if (capabilities === undefined) {
      throw new Error(
        `Model capabilities are unavailable: ${agent.provider}/${agent.modelId}`
      );
    }
    const currentRoom = this.store.getRoom(input.roomId);
    if (currentRoom.status !== "running") throw new Error("Room is paused");
    const currentAgent = this.store.getRoomAgent(input.roomId, input.agentId);
    if (
      currentAgent.provider !== agent.provider ||
      currentAgent.modelId !== agent.modelId
    ) {
      throw new Error(`Agent configuration changed while preparing generation: ${agent.id}`);
    }
    if (this.store.getRuntime(input.roomId, currentAgent.id).muted) {
      throw new Error(`Agent is muted: ${currentAgent.id}`);
    }
    const { capabilities: _storedCapabilities, ...definition } = currentAgent;
    const effectiveAgent: AgentDefinition = {
      ...definition,
      ...(capabilities === undefined ? {} : { capabilities })
    };
    if ([...this.active.values()].some(active =>
      active.roomId === input.roomId && active.agentId === input.agentId
    )) {
      throw new Error(`Agent is already generating: ${input.agentId}`);
    }

    const generationId = uuidv7();
    const message = this.store.appendMessage({
      roomId: input.roomId,
      authorType: "agent",
      authorId: effectiveAgent.id,
      content: "",
      status: "streaming",
      generationId,
      ...(input.targetMessageId === undefined
        ? {}
        : { replyToMessageId: input.targetMessageId })
    });
    let generation = this.store.createGeneration({
      id: generationId,
      roomId: input.roomId,
      messageId: message.id,
      agent: effectiveAgent
    });
    const controller = new AbortController();
    let markComplete!: () => void;
    const completion = new Promise<void>(resolve => {
      markComplete = resolve;
    });
    this.active.set(generationId, {
      roomId: input.roomId,
      agentId: effectiveAgent.id,
      controller,
      completion
    });
    const startedAtMs = Date.now();

    try {
      if (provider.execution?.semantics === "stateful-companion") {
        if (!(provider instanceof PsfnProvider) || !provider.streamParticipantTurn) {
          throw new Error("Stateful companion provider does not implement the PSFN participant path");
        }
        return await this.generatePsfnTurn({
          snapshot: this.store.getSnapshot(input.roomId),
          agent: effectiveAgent,
          provider,
          generation,
          generationId,
          message,
          controller,
          startedAtMs,
          ...(input.targetMessageId === undefined
            ? {}
            : { targetMessageId: input.targetMessageId }),
          ...(input.retryPsfnState === undefined
            ? {}
            : { retryState: input.retryPsfnState }),
          ...(input.resynchronizePsfn === true ? { resynchronization: true } : {})
        });
      }
      ensureConversationCompaction({
        store: this.store,
        roomId: input.roomId,
        agent: effectiveAgent
      });
      const liveSnapshot = this.store.getSnapshot(input.roomId);
      const target = input.targetMessageId === undefined
        ? [...liveSnapshot.messages].reverse().find(message =>
            message.lifecycle === "active" &&
            message.status !== "streaming" &&
            (message.authorType === "human" || message.authorType === "agent")
          )
        : liveSnapshot.messages.find(candidate => candidate.id === input.targetMessageId);
      let retrievedEvidence: ToolExecutionResult | undefined;
      if (
        liveSnapshot.room.settings.conversationStyle === "deep-study" &&
        this.tools &&
        target?.content.trim()
      ) {
        retrievedEvidence = await this.tools.collectPersonaEvidence({
          roomId: input.roomId,
          agentId: effectiveAgent.id,
          query: target.content,
          limit: 8,
          signal: controller.signal
        });
        generation = this.store.updateGeneration(generationId, {
          retrievedChunkIds: [
            ...new Set([
              ...generation.retrievedChunkIds,
              ...retrievedEvidence.citedChunkIds
            ])
          ]
        });
      }
      const deliberationCount = Math.max(
        0,
        liveSnapshot.room.settings.deliberationTurns - 1
      );
      const contextPolicy = deriveContextPolicy({
        contextBudget: effectiveAgent.contextBudget,
        modelContextLength: effectiveAgent.capabilities?.contextLength
      });
      const effectiveContextLength = contextPolicy.hardLimitTokens;
      const availablePerDraft = deliberationCount === 0
        ? 0
        : Math.floor(
            Math.max(
              0,
              effectiveContextLength - effectiveAgent.maxOutputTokens - 768
            ) / deliberationCount
          ) - 128;
      const deliberationDraftTokens = deliberationCount === 0
        ? 0
        : Math.max(128, Math.min(
            1_200,
            effectiveAgent.contextBudget.notebookTokens || 800,
            availablePerDraft
          ));
      const draftContextReserve = deliberationCount === 0
        ? 0
        : deliberationCount * (deliberationDraftTokens + 96) + 96;
      const toolContextReserve = this.tools && effectiveAgent.capabilities?.toolCalling
        ? Math.min(24_000, Math.floor(contextPolicy.workingLimitTokens * 0.12))
        : 0;
      const reservedContextTokens = draftContextReserve + toolContextReserve;
      const request = this.buildRequest(
        liveSnapshot,
        effectiveAgent,
        controller.signal,
        input.targetMessageId,
        retrievedEvidence?.content,
        reservedContextTokens
      );
      const conversation = [...request.messages];
      for (let ordinal = 1; ordinal <= deliberationCount; ordinal += 1) {
        const passConversation: NormalizedChatMessage[] = [
          ...conversation,
          {
            role: "user",
            content: ordinal === 1
              ? [
                  "Prepare a private provisional study memo before the public response.",
                  "This is application-level drafting visible to the human, not hidden chain-of-thought.",
                  "State the strongest grounded claims, citations to verify, contradictions, and open questions concisely.",
                  "Do not address the room yet and do not use tools in this pass."
                ].join("\n")
              : [
                  "Critique and improve the previous provisional memo before the public response.",
                  "Resolve weak claims against the supplied evidence and identify what the final response must say.",
                  "Return a concise application-level study memo, not step-by-step hidden reasoning."
                ].join("\n")
          }
        ];
        let draft = "";
        for await (const event of provider.streamChat({
          ...request,
          messages: passConversation,
          reasoning: {
            ...request.reasoning,
            displayMode: "hidden"
          },
          maxOutputTokens: deliberationDraftTokens,
          tools: []
        })) {
          if (event.type === "text-delta") draft += event.text;
          generation = this.applyAuxiliaryGenerationEvent(generation, event);
          if (
            event.type !== "reasoning-delta" &&
            event.type !== "reasoning-summary"
          ) {
            this.store.appendGenerationEvent(
              generationId,
              `deliberation-${ordinal}.${event.type}`,
              event
            );
          }
        }
        const pass = {
          ordinal,
          text: clipDraftToTokens(draft, deliberationDraftTokens),
          createdAt: new Date().toISOString()
        };
        generation = this.store.updateGeneration(generationId, {
          ...generation,
          deliberationPasses: [...(generation.deliberationPasses ?? []), pass]
        });
        conversation.push(
          { role: "assistant", content: pass.text },
          {
            role: "user",
            content: ordinal === deliberationCount
              ? "Now give the public room your considered response. Use table tools if precise evidence still needs verification. Do not mention the private drafting process."
              : "Use this memo as provisional input for the next private study pass."
          }
        );
      }
      let totalToolCalls = 0;
      // Permit MAX_TOOL_ROUNDS executions plus one final provider turn in which
      // the model turns the gathered evidence into its public response.
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        fitConversationToTokenLimit(
          conversation,
          (contextPolicy.automatic
            ? contextPolicy.workingLimitTokens
            : contextPolicy.hardLimitTokens) - effectiveAgent.maxOutputTokens
        );
        const calls = new Map<string, {
          id: string;
          name: string;
          arguments: string;
        }>();
        for await (const event of provider.streamChat({
          ...request,
          messages: conversation
        })) {
          generation = this.applyGenerationEvent(generation, event);
          this.store.appendGenerationEvent(generationId, event.type, event);
          if (event.type === "text-delta") {
            this.store.updateMessage(message.id, {
              content: generation.finalText
            });
          }
          if (event.type === "tool-call") {
            const current = calls.get(event.id) ?? {
              id: event.id,
              name: "",
              arguments: ""
            };
            current.name += event.name;
            current.arguments += event.arguments;
            calls.set(event.id, current);
          }
        }
        if (calls.size === 0) break;
        totalToolCalls += calls.size;
        if (!this.tools) throw new Error("Provider requested a tool but no tool executor is configured");
        if (totalToolCalls > MAX_TOOL_CALLS) {
          throw new Error(`Generation exceeded the ${MAX_TOOL_CALLS} tool-call limit`);
        }
        if (round === MAX_TOOL_ROUNDS) {
          throw new Error(`Generation exceeded the ${MAX_TOOL_ROUNDS} tool-round limit`);
        }
        const requestedCalls = [...calls.values()];
        conversation.push({
          role: "assistant",
          content: "",
          toolCalls: requestedCalls
        });
        for (const call of requestedCalls) {
          let result: ToolExecutionResult;
          try {
            result = await this.tools.execute({
              roomId: input.roomId,
              agentId: agent.id,
              generationId,
              callId: call.id,
              name: call.name,
              arguments: call.arguments,
              signal: controller.signal
            });
          } catch (error) {
            result = {
              content: JSON.stringify({
                error: error instanceof Error ? error.message : String(error)
              }),
              citedChunkIds: []
            };
          }
          generation = {
            ...generation,
            retrievedChunkIds: [
              ...new Set([
                ...generation.retrievedChunkIds,
                ...result.citedChunkIds
              ])
            ]
          };
          conversation.push({
            role: "tool",
            content: result.content,
            name: call.name,
            toolCallId: call.id
          });
        }
      }
      const completedAt = new Date().toISOString();
      const citedChunkIds = this.store.recordCitations({
        generationId,
        messageId: message.id,
        chunkIds: generation.retrievedChunkIds
      });
      generation = this.store.updateGeneration(generationId, {
        ...generation,
        retrievedChunkIds: citedChunkIds,
        disposition: generation.disposition ?? "published",
        status: "complete",
        completedAt,
        latencyMs: Date.now() - startedAtMs
      });
      const completeMessage = this.store.updateMessage(message.id, {
        content: generation.finalText,
        status: "complete",
        citedChunkIds
      });
      return { message: completeMessage, generation };
    } catch (error) {
      const interrupted = error instanceof DOMException && error.name === "AbortError";
      const status = interrupted ? "interrupted" : "failed";
      generation = this.store.updateGeneration(generationId, {
        ...generation,
        status,
        completedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAtMs,
        ...(interrupted
          ? {}
          : { error: error instanceof Error ? error.message : String(error) })
      });
      const failedMessage = this.store.updateMessage(message.id, {
        content: generation.finalText,
        status
      });
      if (interrupted) return { message: failedMessage, generation };
      throw error;
    } finally {
      this.active.delete(generationId);
      markComplete();
    }
  }

  interrupt(generationId: string): boolean {
    const active = this.active.get(generationId);
    if (!active) return false;
    active.controller.abort();
    return true;
  }

  async retryPsfnDelivery(input: {
    roomId: string;
    agentId: string;
  }): Promise<{ message: RoomMessage; generation: GenerationRecord }> {
    const state = this.store.getPsfnDeliveryState(input.roomId, input.agentId);
    if (
      !state ||
      state.deliveryStatus !== "ambiguous" ||
      !state.inflightDeliveryId ||
      !state.inflightEnvelope ||
      !state.inflightEnvelopeDigest
    ) {
      throw new Error("No complete ambiguous PSFN delivery requires retry");
    }
    return this.generate({
      ...input,
      retryPsfnState: state
    });
  }

  async resynchronizePsfnDelivery(input: {
    roomId: string;
    agentId: string;
  }): Promise<{ message: RoomMessage; generation: GenerationRecord }> {
    const state = this.store.getPsfnDeliveryState(input.roomId, input.agentId);
    const latestTarget = [...this.store.listMessages(input.roomId)].reverse().find(message =>
      message.lifecycle === "active" &&
      (message.status === "complete" || message.status === "edited") &&
      (message.authorType === "human" || message.authorType === "agent")
    );
    if (!state || state.deliveryStatus !== "ambiguous" || !latestTarget) {
      throw new Error("No ambiguous PSFN delivery can be resynchronized");
    }
    return this.generate({
      ...input,
      targetMessageId: latestTarget.id,
      resynchronizePsfn: true
    });
  }

  interruptRoom(roomId: string): number {
    let interrupted = 0;
    for (const active of this.active.values()) {
      if (active.roomId !== roomId) continue;
      active.controller.abort();
      interrupted += 1;
    }
    return interrupted;
  }

  async interruptRoomAndWait(
    roomId: string,
    timeoutMs = 5_000
  ): Promise<number> {
    const active = [...this.active.values()].filter(generation =>
      generation.roomId === roomId
    );
    for (const generation of active) generation.controller.abort();
    if (active.length > 0) {
      await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, timeoutMs);
        void Promise.all(active.map(generation => generation.completion)).then(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    if ([...this.active.values()].some(generation => generation.roomId === roomId)) {
      throw new Error("Room generation did not stop before the operation timeout");
    }
    return active.length;
  }

  interruptAgent(roomId: string, agentId: string): number {
    let interrupted = 0;
    for (const active of this.active.values()) {
      if (active.roomId !== roomId || active.agentId !== agentId) continue;
      active.controller.abort();
      interrupted += 1;
    }
    return interrupted;
  }

  async interruptAgentAndWait(
    roomId: string,
    agentId: string,
    timeoutMs = 5_000
  ): Promise<number> {
    const active = [...this.active.values()].filter(generation =>
      generation.roomId === roomId && generation.agentId === agentId
    );
    for (const generation of active) generation.controller.abort();
    if (active.length > 0) {
      await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, timeoutMs);
        void Promise.all(active.map(generation => generation.completion)).then(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    if ([...this.active.values()].some(generation =>
      generation.roomId === roomId && generation.agentId === agentId
    )) {
      throw new Error("Participant generation did not stop before removal timeout");
    }
    return active.length;
  }

  private buildRequest(
    snapshot: ReturnType<RoomStore["getSnapshot"]>,
    agent: AgentDefinition,
    signal: AbortSignal,
    targetMessageId?: string,
    retrievedEvidence?: string,
    reservedContextTokens?: number
  ) {
    return {
      modelId: agent.modelId,
      messages: assembleAgentMessages({
        snapshot,
        agent,
        ...(targetMessageId === undefined ? {} : { targetMessageId }),
        ...(retrievedEvidence === undefined ? {} : { retrievedEvidence }),
        ...(reservedContextTokens === undefined
          ? {}
          : { reservedContextTokens }),
        ...(this.tools
          ? {
              workspaceManifest: this.tools.workspaceManifest(
                snapshot.room.id,
                agent.id
              )
            }
          : {})
      }),
      temperature: agent.temperature,
      ...(agent.topP === undefined ? {} : { topP: agent.topP }),
      maxOutputTokens: agent.maxOutputTokens,
      reasoning: agent.reasoning,
      tools: this.tools && agent.capabilities?.toolCalling
        ? this.tools.definitions(agent.tools)
        : [],
      sessionId: `${snapshot.room.id}:${agent.id}`,
      signal
    };
  }

  private async generatePsfnTurn(input: {
    snapshot: ReturnType<RoomStore["getSnapshot"]>;
    agent: AgentDefinition;
    provider: PsfnProvider;
    generation: GenerationRecord;
    generationId: string;
    message: RoomMessage;
    controller: AbortController;
    startedAtMs: number;
    targetMessageId?: string;
    retryState?: PsfnDeliveryState;
    resynchronization?: boolean;
  }): Promise<{ message: RoomMessage; generation: GenerationRecord }> {
    let generation = input.generation;
    const target = input.retryState
      ? undefined
      : input.targetMessageId === undefined
      ? [...input.snapshot.messages].reverse().find(candidate =>
          candidate.lifecycle === "active" &&
          (candidate.status === "complete" || candidate.status === "edited") &&
          (candidate.authorType === "human" || candidate.authorType === "agent")
        )
      : input.snapshot.messages.find(candidate => candidate.id === input.targetMessageId);
    if (!input.retryState && !target?.content.trim()) {
      throw new Error("PSFN participant turn requires a public reply target");
    }
    let retrievedEvidence: ToolExecutionResult | undefined;
    if (this.tools && target && !input.retryState) {
      retrievedEvidence = await this.tools.collectParticipantEvidence({
        roomId: input.snapshot.room.id,
        agentId: input.agent.id,
        query: target.content,
        limit: 6,
        signal: input.controller.signal
      });
      generation = this.store.updateGeneration(input.generationId, {
        retrievedChunkIds: retrievedEvidence.citedChunkIds
      });
    }
    const existing = this.store.getPsfnDeliveryState(
      input.snapshot.room.id,
      input.agent.id
    );
    if (!input.provider.pinnedCompanionId && existing?.remoteCompanionId) {
      input.provider.pinExpectedIdentity(existing.remoteCompanionId);
    }
    const identity = await input.provider.verifyConnection(input.controller.signal);
    if (!input.provider.pinnedCompanionId) {
      input.provider.pinExpectedIdentity(identity.companionId);
    }
    if (input.resynchronization && existing?.deliveryStatus !== "ambiguous") {
      throw new Error("No ambiguous PSFN delivery can be resynchronized");
    }
    const assembled = input.retryState
      ? {
          request: {
            generationId: input.retryState.inflightDeliveryId!,
            room: {
              id: input.snapshot.room.id,
              title: input.snapshot.room.title,
              conversationStyle: input.snapshot.room.settings.conversationStyle,
              responseLength: input.snapshot.room.settings.responseLength
            },
            agent: {
              id: input.agent.id,
              name: input.agent.name,
              description: input.agent.description,
              modelId: input.agent.modelId
            },
            participants: input.snapshot.agents.map(agent => ({
              id: agent.id,
              name: agent.name,
              description: agent.description
            })),
            triggerMessageId: input.retryState.inflightTriggerMessageId ?? "ambiguous-delivery",
            pendingMessages: [],
            evidence: [],
            sessionId: input.retryState.sessionKey,
            responseStyle: input.snapshot.room.settings.responseLength === "short"
              ? "concise" as const
              : "expressive" as const,
            preRenderedEnvelope: input.retryState.inflightEnvelope!,
            signal: input.controller.signal
          },
          highSequence: input.retryState.inflightHighSequence ??
            input.retryState.lastDeliveredSequence,
          envelopeDigest: input.retryState.inflightEnvelopeDigest!
        }
      : assemblePsfnTurn({
          snapshot: input.snapshot,
          agent: input.agent,
          generationId: input.generationId,
          triggerMessageId: target!.id,
          lastDeliveredSequence: input.resynchronization
            ? 0
            : existing?.lastDeliveredSequence ?? 0,
          evidence: retrievedEvidence?.evidence ?? [],
          characterLimit: Math.min(
            1_000_000,
            Math.max(8_000, Math.floor((input.agent.capabilities?.contextLength ?? 32_768) * 3))
          ),
          resynchronization: input.resynchronization === true,
          signal: input.controller.signal
        });
    if (!input.retryState && existing?.sessionKey) {
      assembled.request.sessionId = existing.sessionKey;
    }
    const deliveryId = input.retryState?.inflightDeliveryId ?? input.generationId;
    if (input.retryState?.inflightChunkIds) {
      generation = this.store.updateGeneration(input.generationId, {
        retrievedChunkIds: input.retryState.inflightChunkIds
      });
    }
    let deliveryStarted = false;
    try {
      if (input.retryState) {
        this.store.restartAmbiguousPsfnDelivery(
          input.snapshot.room.id,
          input.agent.id
        );
      } else if (input.resynchronization) {
        this.store.beginPsfnResynchronization({
          roomId: input.snapshot.room.id,
          agentId: input.agent.id,
          remoteCompanionId: identity.companionId,
          sessionMode: input.provider.configuredSessionMode,
          sessionKey: assembled.request.sessionId,
          deliveryId,
          highSequence: assembled.highSequence,
          envelopeDigest: assembled.envelopeDigest,
          envelope: assembled.request.preRenderedEnvelope ?? renderPsfnEnvelope(assembled.request),
          triggerMessageId: assembled.request.triggerMessageId,
          chunkIds: generation.retrievedChunkIds
        });
      } else {
        this.store.beginPsfnDelivery({
          roomId: input.snapshot.room.id,
          agentId: input.agent.id,
          remoteCompanionId: identity.companionId,
          sessionMode: input.provider.configuredSessionMode,
          sessionKey: assembled.request.sessionId,
          deliveryId,
          highSequence: assembled.highSequence,
          envelopeDigest: assembled.envelopeDigest,
          envelope: assembled.request.preRenderedEnvelope ?? renderPsfnEnvelope(assembled.request),
          triggerMessageId: assembled.request.triggerMessageId,
          chunkIds: generation.retrievedChunkIds
        });
      }
      deliveryStarted = true;
      for await (const event of input.provider.streamParticipantTurn!(assembled.request)) {
        generation = this.applyGenerationEvent(generation, event);
        this.store.appendGenerationEvent(input.generationId, event.type, event);
        if (event.type === "text-delta") {
          this.store.updateMessage(input.message.id, { content: generation.finalText });
        }
      }
      this.store.completePsfnDelivery(
        input.snapshot.room.id,
        input.agent.id,
        deliveryId
      );
      deliveryStarted = false;
    } catch (error) {
      if (deliveryStarted) {
        if (
          input.resynchronization &&
          existing &&
          error instanceof PsfnProviderError &&
          error.definitivePreAdmission
        ) {
          this.store.restorePsfnAmbiguity(existing, deliveryId);
        } else if (
          !input.retryState &&
          error instanceof PsfnProviderError &&
          error.definitivePreAdmission
        ) {
          this.store.clearPsfnInflight(
            input.snapshot.room.id,
            input.agent.id,
            deliveryId
          );
        } else {
          this.store.markPsfnDeliveryAmbiguous(
            input.snapshot.room.id,
            input.agent.id,
            deliveryId
          );
        }
      }
      throw error;
    }
    const completedAt = new Date().toISOString();
    const citedChunkIds = this.store.recordCitations({
      generationId: input.generationId,
      messageId: input.message.id,
      chunkIds: generation.retrievedChunkIds
    });
    generation = this.store.updateGeneration(input.generationId, {
      ...generation,
      disposition: generation.disposition ?? (generation.finalText.trim() ? "published" : "no-reply"),
      retrievedChunkIds: citedChunkIds,
      status: "complete",
      completedAt,
      latencyMs: Date.now() - input.startedAtMs
    });
    const noReply = generation.disposition === "no-reply";
    const completeMessage = this.store.updateMessage(input.message.id, {
      content: generation.finalText,
      status: "complete",
      lifecycle: noReply ? "deleted" : "active",
      citedChunkIds
    });
    return { message: completeMessage, generation };
  }

  private applyGenerationEvent(
    generation: GenerationRecord,
    event: NormalizedGenerationEvent
  ): GenerationRecord {
    switch (event.type) {
      case "text-delta":
        return { ...generation, finalText: generation.finalText + event.text };
      case "reasoning-delta":
        return {
          ...generation,
          reasoningText: (generation.reasoningText ?? "") + event.text
        };
      case "reasoning-summary":
        return {
          ...generation,
          reasoningSummary: (generation.reasoningSummary ?? "") + event.text
        };
      case "usage":
        return {
          ...generation,
          ...(event.inputTokens === undefined
            ? {}
            : { inputTokens: (generation.inputTokens ?? 0) + event.inputTokens }),
          ...(event.outputTokens === undefined
            ? {}
            : { outputTokens: (generation.outputTokens ?? 0) + event.outputTokens }),
          ...(event.reasoningTokens === undefined
            ? {}
            : {
                reasoningTokens:
                  (generation.reasoningTokens ?? 0) + event.reasoningTokens
              }),
          ...(event.costUsd === undefined
            ? {}
            : { costUsd: (generation.costUsd ?? 0) + event.costUsd })
        };
      case "routing":
        return {
          ...generation,
          ...(event.modelId === undefined ? {} : { actualModelId: event.modelId }),
          ...(event.provider === undefined ? {} : { actualProvider: event.provider })
        };
      case "tool-call":
        return generation;
      case "done":
        return {
          ...generation,
          ...(event.disposition === undefined ? {} : { disposition: event.disposition })
        };
    }
  }

  private applyAuxiliaryGenerationEvent(
    generation: GenerationRecord,
    event: NormalizedGenerationEvent
  ): GenerationRecord {
    if (event.type === "usage" || event.type === "routing") {
      return this.applyGenerationEvent(generation, event);
    }
    return generation;
  }
}
