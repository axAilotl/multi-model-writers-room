import type {
  AgentDefinition,
  GenerationRecord,
  NormalizedGenerationEvent,
  RoomMessage
} from "@writers-room/contracts";
import type { ModelProvider } from "../providers/model-provider.js";
import { uuidv7 } from "../shared/id.js";
import { RoomStore } from "../storage/room-store.js";
import type {
  ToolExecutionResult,
  ToolExecutor
} from "../tools/room-tools.js";
import { assembleAgentMessages } from "./context-assembler.js";

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
    const capabilities = await provider.getCapabilities(agent.modelId)
      .catch(() => undefined);
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
      const request = this.buildRequest(
        this.store.getSnapshot(input.roomId),
        effectiveAgent,
        controller.signal,
        input.targetMessageId
      );
      const conversation = [...request.messages];
      let totalToolCalls = 0;
      for (let round = 0; round < 4; round += 1) {
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
        if (totalToolCalls > 12) throw new Error("Generation exceeded the 12 tool-call limit");
        if (round === 3) throw new Error("Generation exceeded the four tool-round limit");
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

  private buildRequest(
    snapshot: ReturnType<RoomStore["getSnapshot"]>,
    agent: AgentDefinition,
    signal: AbortSignal,
    targetMessageId?: string
  ) {
    return {
      modelId: agent.modelId,
      messages: assembleAgentMessages({
        snapshot,
        agent,
        ...(targetMessageId === undefined ? {} : { targetMessageId }),
        ...(this.tools
          ? { workspaceManifest: this.tools.workspaceManifest(snapshot.room.id) }
          : {})
      }),
      temperature: agent.temperature,
      ...(agent.topP === undefined ? {} : { topP: agent.topP }),
      maxOutputTokens: agent.maxOutputTokens,
      reasoning: agent.reasoning,
      tools: this.tools?.definitions(agent.tools) ?? [],
      sessionId: `${snapshot.room.id}:${agent.id}`,
      signal
    };
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
          ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }),
          ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens }),
          ...(event.reasoningTokens === undefined
            ? {}
            : { reasoningTokens: event.reasoningTokens }),
          ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd })
        };
      case "routing":
        return {
          ...generation,
          ...(event.modelId === undefined ? {} : { actualModelId: event.modelId }),
          ...(event.provider === undefined ? {} : { actualProvider: event.provider })
        };
      case "tool-call":
      case "done":
        return generation;
    }
  }
}
