import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentDefinition,
  NormalizedChatRequest,
  NormalizedGenerationEvent
} from "@writers-room/contracts";
import type { ModelDescriptor, ModelProvider } from "../providers/model-provider.js";
import { RoomStore } from "../storage/room-store.js";
import { RoomToolExecutor } from "../tools/room-tools.js";
import type {
  EmbeddingModel,
  HousekeepingModel
} from "../workspace/workspace-service.js";
import { WorkspaceService } from "../workspace/workspace-service.js";
import { fitConversationToTokenLimit, RoomEngine } from "./room-engine.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("room generation tool seam", () => {
  it("clips accumulated tool results before a provider context can overflow", () => {
    const continuation = "[range continues: first_message_offset=32000]";
    const messages = [
      { role: "system" as const, content: "rules ".repeat(120) },
      { role: "user" as const, content: "recent transcript ".repeat(120) },
      {
        role: "assistant" as const,
        content: "",
        toolCalls: [{
          id: "history-call",
          name: "read_message_range",
          arguments: "{}"
        }]
      },
      {
        role: "tool" as const,
        name: "read_message_range",
        toolCallId: "history-call",
        content: `${"canonical history ".repeat(3_000)}${continuation}`
      }
    ];

    fitConversationToTokenLimit(messages, 2_000);

    const estimatedTokens = messages.reduce((sum, message) => sum + Math.ceil((
      message.content.length +
      ("toolCalls" in message ? JSON.stringify(message.toolCalls).length : 0) +
      24
    ) / 4), 0);
    expect(estimatedTokens).toBeLessThanOrEqual(2_000);
    expect(messages.at(-1)?.content).toContain(continuation);
    expect(messages.at(-1)?.content).toContain("tool result clipped");
  });

  it("moves an exact-history continuation cursor to the first clipped character", () => {
    const firstMessageId = "019-history-message";
    const lastMessageId = "019-last-message";
    const content = "x".repeat(32_000);
    const messages = [
      { role: "system" as const, content: "rules" },
      {
        role: "tool" as const,
        name: "read_message_range",
        toolCallId: "history-call",
        content: JSON.stringify({
          kind: "canonical_message_range",
          messages: [{
            messageId: firstMessageId,
            sequence: 1,
            author: "Human",
            createdAt: "now",
            lifecycle: "active",
            contentOffset: 0,
            content
          }],
          continuation: {
            first_message_id: firstMessageId,
            last_message_id: lastMessageId,
            first_message_offset: 32_000
          }
        })
      }
    ];

    fitConversationToTokenLimit(messages, 1_000);

    const clipped = messages[1]!.content;
    const parsed = JSON.parse(clipped) as {
      messages: Array<{ content: string }>;
      continuation: {
        first_message_id: string;
        last_message_id: string;
        first_message_offset: number;
      };
    };
    expect(parsed.messages[0]!.content).toBe(
      content.slice(0, parsed.continuation.first_message_offset)
    );
    expect(parsed.continuation.first_message_offset).toBeGreaterThan(0);
    expect(parsed.continuation.first_message_offset).toBeLessThan(32_000);
    expect(parsed.continuation.first_message_id).toBe(firstMessageId);
    expect(parsed.continuation.last_message_id).toBe(lastMessageId);
  });

  it("continues at an unretained message when its metadata cannot fit", () => {
    const first = {
      messageId: "first-message",
      sequence: 1,
      author: "Human",
      createdAt: "now",
      lifecycle: "active",
      contentOffset: 0,
      content: "a".repeat(600)
    };
    const second = {
      messageId: "second-message",
      sequence: 2,
      author: "Voice",
      createdAt: "now",
      lifecycle: "active",
      contentOffset: 0,
      content: "b".repeat(600)
    };
    const messages = [{
      role: "tool" as const,
      name: "read_message_range",
      toolCallId: "history-call",
      content: JSON.stringify({
        kind: "canonical_message_range",
        messages: [first, second],
        continuation: null
      })
    }];

    fitConversationToTokenLimit(messages, 250);

    const page = JSON.parse(messages[0]!.content) as {
      messages: Array<{ messageId: string; content: string }>;
      continuation: {
        first_message_id: string;
        last_message_id: string;
        first_message_offset: number;
      };
    };
    expect(page.messages.map(message => message.messageId)).toEqual(["first-message"]);
    expect(page.messages[0]!.content).toBe(first.content);
    expect(page.continuation).toEqual({
      first_message_id: "second-message",
      last_message_id: "second-message",
      first_message_offset: 0
    });
  });

  it("recovers canonical raw messages after they leave the rolling prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-history-tools-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({ title: "History room" });
    const agent: AgentDefinition = {
      id: "historian",
      name: "Historian",
      description: "Recovers exact old wording.",
      provider: "openrouter",
      modelId: "fixture",
      systemPrompt: "Use raw history when exact wording matters.",
      temperature: 0,
      maxOutputTokens: 300,
      reasoning: { enabled: false, displayMode: "hidden" },
      tools: [],
      contextBudget: {
        softLimitTokens: 4_000,
        hardLimitTokens: 8_000,
        recentTranscriptTokens: 2_000,
        retrievedContextTokens: 1_000,
        notebookTokens: 0
      }
    };
    store.addAgent(room.id, agent);
    const old = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "The fossil phrase is cobalt lighthouse."
    });
    const current = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "Recover the exact fossil phrase from the canonical transcript."
    });
    const workspace = new WorkspaceService({
      store,
      dataRoot: root,
      embeddings: {
        dimensions: 2,
        embedDocuments: async texts => texts.map(() => new Float32Array([1, 0])),
        embedQuery: async () => new Float32Array([1, 0])
      },
      housekeeping: { summarize: async () => ({ summary: "unused" }) }
    });
    let call = 0;
    const provider: ModelProvider = {
      id: "openrouter",
      listModels: async () => [],
      getCapabilities: async () => ({
        contextLength: 8_000,
        textInput: true,
        imageInput: false,
        pdfInput: false,
        toolCalling: true,
        structuredOutput: false,
        reasoningInputControl: false,
        reasoningOutput: false,
        promptCaching: false
      }),
      streamChat: async function* (request) {
        call += 1;
        if (call === 1) {
          expect(request.tools?.some(tool =>
            tool.name === "search_conversation_history"
          )).toBe(true);
          yield {
            type: "tool-call",
            id: "history-search",
            name: "search_conversation_history",
            arguments: '{"query":"fossil phrase"}'
          };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        expect(request.messages.at(-1)?.content).toContain(old.id);
        expect(request.messages.at(-1)?.content).toContain("cobalt lighthouse");
        yield { type: "text-delta", text: "The phrase was cobalt lighthouse." };
        yield { type: "done", finishReason: "stop" };
      }
    };
    const providers = new Map([["openrouter", provider]]);
    const engine = new RoomEngine(
      store,
      providers,
      new RoomToolExecutor(store, workspace, providers)
    );

    const result = await engine.generate({
      roomId: room.id,
      agentId: agent.id,
      targetMessageId: current.id
    });

    expect(result.message.content).toContain("cobalt lighthouse");
    expect(store.getGenerationInspection(result.generation.id).toolCalls)
      .toMatchObject([{ toolName: "search_conversation_history", status: "complete" }]);
    store.close();
  });

  it("paginates through a single long raw message without losing its tail", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-history-pagination-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({ title: "History pagination room" });
    const agent: AgentDefinition = {
      id: "historian",
      name: "Historian",
      description: "Reads exact pages.",
      provider: "openrouter",
      modelId: "fixture",
      systemPrompt: "Read exact history.",
      temperature: 0,
      maxOutputTokens: 256,
      reasoning: { enabled: false, displayMode: "hidden" },
      tools: [],
      contextBudget: {
        softLimitTokens: 4_000,
        hardLimitTokens: 8_000,
        recentTranscriptTokens: 2_000,
        retrievedContextTokens: 1_000,
        notebookTokens: 0
      }
    };
    store.addAgent(room.id, agent);
    const raw = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: `${"canonical ".repeat(5_000)}EXACT_LONG_MESSAGE_TAIL`
    });
    const generationMessage = store.appendMessage({
      roomId: room.id,
      authorType: "agent",
      authorId: agent.id,
      content: "",
      status: "streaming",
      generationId: "history-pagination-generation"
    });
    store.createGeneration({
      id: "history-pagination-generation",
      roomId: room.id,
      messageId: generationMessage.id,
      agent
    });
    const workspace = new WorkspaceService({
      store,
      dataRoot: root,
      embeddings: {
        dimensions: 2,
        embedDocuments: async texts => texts.map(() => new Float32Array([1, 0])),
        embedQuery: async () => new Float32Array([1, 0])
      },
      housekeeping: { summarize: async () => ({ summary: "unused" }) }
    });
    const tools = new RoomToolExecutor(store, workspace);
    const first = await tools.execute({
      roomId: room.id,
      agentId: agent.id,
      generationId: "history-pagination-generation",
      callId: "page-one",
      name: "read_message_range",
      arguments: JSON.stringify({
        first_message_id: raw.id,
        last_message_id: raw.id
      }),
      signal: new AbortController().signal
    });
    expect(first.content).not.toContain("EXACT_LONG_MESSAGE_TAIL");
    const firstPage = JSON.parse(first.content) as {
      continuation: { first_message_offset: number };
    };
    const offset = firstPage.continuation.first_message_offset;
    expect(offset).toBeGreaterThan(0);
    const second = await tools.execute({
      roomId: room.id,
      agentId: agent.id,
      generationId: "history-pagination-generation",
      callId: "page-two",
      name: "read_message_range",
      arguments: JSON.stringify({
        first_message_id: raw.id,
        last_message_id: raw.id,
        first_message_offset: offset
      }),
      signal: new AbortController().signal
    });
    expect(second.content).toContain("EXACT_LONG_MESSAGE_TAIL");
    store.close();
  });

  it("does not advertise tools to a model without tool-calling support", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-no-tools-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({ title: "No tools room" });
    const agent: AgentDefinition = {
      id: "plain-model",
      name: "Plain Model",
      description: "Cannot call tools.",
      provider: "openrouter",
      modelId: "fixture",
      systemPrompt: "Answer directly.",
      temperature: 0,
      maxOutputTokens: 256,
      reasoning: { enabled: false, displayMode: "hidden" },
      tools: ["search_workspace"],
      contextBudget: {
        softLimitTokens: 4_000,
        hardLimitTokens: 8_000,
        recentTranscriptTokens: 2_000,
        retrievedContextTokens: 1_000,
        notebookTokens: 0
      }
    };
    store.addAgent(room.id, agent);
    const target = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "Answer without tools."
    });
    const workspace = new WorkspaceService({
      store,
      dataRoot: root,
      embeddings: {
        dimensions: 2,
        embedDocuments: async texts => texts.map(() => new Float32Array([1, 0])),
        embedQuery: async () => new Float32Array([1, 0])
      },
      housekeeping: { summarize: async () => ({ summary: "unused" }) }
    });
    const provider: ModelProvider = {
      id: "openrouter",
      listModels: async () => [],
      getCapabilities: async () => ({
        contextLength: 8_000,
        textInput: true,
        imageInput: false,
        pdfInput: false,
        toolCalling: false,
        structuredOutput: false,
        reasoningInputControl: false,
        reasoningOutput: false,
        promptCaching: false
      }),
      streamChat: async function* (request) {
        expect(request.tools).toEqual([]);
        yield { type: "text-delta", text: "Answered directly." };
        yield { type: "done", finishReason: "stop" };
      }
    };
    const providers = new Map([["openrouter", provider]]);
    const engine = new RoomEngine(
      store,
      providers,
      new RoomToolExecutor(store, workspace, providers)
    );

    const result = await engine.generate({
      roomId: room.id,
      agentId: agent.id,
      targetMessageId: target.id
    });

    expect(result.message.content).toBe("Answered directly.");
    store.close();
  });

  it("runs bounded Fishbowl study passes with only the speaker's private library", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-fishbowl-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({
      title: "Fishbowl room",
      settings: {
        conversationStyle: "deep-study",
        deliberationTurns: 3,
        maxResponders: 1
      }
    });
    const agent: AgentDefinition = {
      id: "author",
      name: "Author",
      description: "Grounds answers in a private source library.",
      provider: "openrouter",
      modelId: "fixture",
      systemPrompt: "Answer from grounded evidence.",
      temperature: 0,
      maxOutputTokens: 500,
      reasoning: { enabled: true, effort: "high", displayMode: "summary" },
      tools: [],
      contextBudget: {
        softLimitTokens: 8_000,
        hardLimitTokens: 12_000,
        recentTranscriptTokens: 3_000,
        retrievedContextTokens: 2_000,
        notebookTokens: 1_000
      }
    };
    store.addAgent(room.id, agent);
    const embeddings: EmbeddingModel = {
      dimensions: 2,
      embedDocuments: async texts => texts.map(() => new Float32Array([1, 0])),
      embedQuery: async () => new Float32Array([1, 0])
    };
    const workspace = new WorkspaceService({
      store,
      dataRoot: root,
      embeddings,
      housekeeping: { summarize: async () => ({ summary: "Private interview." }) }
    });
    const memory = await workspace.ingest({
      roomId: room.id,
      filename: "interview.md",
      mediaType: "text/markdown",
      bytes: Buffer.from("# Craft\nThe author says revision discovers the real story."),
      sourceType: "persona-memory",
      ownerAgentId: agent.id
    });
    const human = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "What does the author say revision discovers in the real story?"
    });
    let call = 0;
    const provider: ModelProvider = {
      id: "openrouter",
      listModels: async () => [],
      getCapabilities: async () => ({
        contextLength: 12_000,
        textInput: true,
        imageInput: false,
        pdfInput: false,
        toolCalling: true,
        structuredOutput: true,
        reasoningInputControl: true,
        reasoningOutput: true,
        promptCaching: false
      }),
      streamChat: async function* (request) {
        call += 1;
        if (call === 1) {
          expect(request.tools).toEqual([]);
          expect(request.reasoning.displayMode).toBe("hidden");
          expect(request.messages[0]?.content).toContain("revision discovers the real story");
          yield { type: "text-delta", text: "Evidence supports a claim about revision." };
        } else if (call === 2) {
          expect(request.tools).toEqual([]);
          expect(request.messages.some(message =>
            message.content.includes("Evidence supports a claim")
          )).toBe(true);
          yield { type: "text-delta", text: "The precise claim is that revision discovers story." };
        } else {
          expect(request.messages.at(-1)?.content).toContain("public room");
          yield { type: "text-delta", text: "Revision discovers the real story." };
        }
        yield { type: "usage", inputTokens: 10, outputTokens: 5, reasoningTokens: 2 };
        yield { type: "done", finishReason: "stop" };
      }
    };
    const providers = new Map([["openrouter", provider]]);
    const tools = new RoomToolExecutor(store, workspace, providers);
    const engine = new RoomEngine(store, providers, tools);

    const result = await engine.generate({
      roomId: room.id,
      agentId: agent.id,
      targetMessageId: human.id
    });

    expect(call).toBe(3);
    expect(result.generation.deliberationPasses).toMatchObject([
      { ordinal: 1, text: expect.stringContaining("Evidence supports") },
      { ordinal: 2, text: expect.stringContaining("precise claim") }
    ]);
    expect(result.generation).toMatchObject({
      inputTokens: 30,
      outputTokens: 15,
      reasoningTokens: 6,
      retrievedChunkIds: [expect.any(String)]
    });
    expect(result.message.citedChunkIds).toEqual(result.generation.retrievedChunkIds);
    expect(workspace.manifest(room.id, agent.id)).toContain(memory.id);
    store.close();
  });

  it("executes eight bounded workspace tool rounds and exposes stable artifact IDs", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-tools-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({ title: "Tool room" });
    const embeddings: EmbeddingModel = {
      dimensions: 2,
      embedDocuments: async texts => texts.map(() => new Float32Array([1, 0])),
      embedQuery: async () => new Float32Array([1, 0])
    };
    const housekeeping: HousekeepingModel = {
      summarize: async () => ({ summary: "A roadmap about persistence." })
    };
    const workspace = new WorkspaceService({
      store,
      dataRoot: root,
      embeddings,
      housekeeping
    });
    const artifact = await workspace.ingest({
      roomId: room.id,
      filename: "roadmap.md",
      mediaType: "text/markdown",
      bytes: Buffer.from("# Persistence\nThe public transcript is canonical.")
    });
    const agent: AgentDefinition = {
      id: "researcher",
      name: "Researcher",
      description: "Retrieves exact evidence.",
      provider: "openrouter",
      modelId: "fixture",
      systemPrompt: "Use evidence.",
      temperature: 0,
      maxOutputTokens: 300,
      reasoning: { enabled: false, displayMode: "hidden" },
      tools: ["search_workspace"],
      contextBudget: {
        softLimitTokens: 4_000,
        hardLimitTokens: 8_000,
        recentTranscriptTokens: 2_000,
        retrievedContextTokens: 1_000,
        notebookTokens: 0
      }
    };
    store.addAgent(room.id, agent);
    const human = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "What is canonical?"
    });
    let round = 0;
    const provider: ModelProvider = {
      id: "openrouter",
      listModels: async (): Promise<ModelDescriptor[]> => [],
      getCapabilities: async () => ({
        contextLength: 8_000,
        textInput: true,
        imageInput: false,
        pdfInput: false,
        toolCalling: true,
        structuredOutput: true,
        reasoningInputControl: false,
        reasoningOutput: false,
        promptCaching: false
      }),
      streamChat: async function* (
        request: NormalizedChatRequest
      ): AsyncIterable<NormalizedGenerationEvent> {
        round += 1;
        if (round === 1) {
          expect(request.messages.some(message =>
            message.content.includes(`artifact_id: ${artifact.id}`)
          )).toBe(true);
        }
        if (round <= 8) {
          yield {
            type: "tool-call",
            id: `call-${round}`,
            name: "search_workspace",
            arguments: '{"query":"canonical transcript"}'
          };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        expect(request.messages.at(-1)).toMatchObject({
          role: "tool",
          name: "search_workspace"
        });
        yield { type: "text-delta", text: "The public transcript is canonical." };
        yield { type: "done", finishReason: "stop" };
      }
    };
    const tools = new RoomToolExecutor(store, workspace);
    const engine = new RoomEngine(
      store,
      new Map([["openrouter", provider]]),
      tools
    );

    const result = await engine.generate({
      roomId: room.id,
      agentId: agent.id,
      targetMessageId: human.id
    });
    const inspection = store.getGenerationInspection(result.generation.id);

    expect(result.message.citedChunkIds).toHaveLength(1);
    expect(inspection.toolCalls).toHaveLength(8);
    expect(inspection.toolCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: "search_workspace", status: "complete" })
    ]));
    expect(inspection.citations).toMatchObject([
      { filename: "roadmap.md", text: expect.stringContaining("canonical") }
    ]);
    store.close();
  });

  it("brokers repository questions through the read-only Table Researcher", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-repository-broker-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({ title: "Repository room" });
    const workspace = new WorkspaceService({
      store,
      dataRoot: root,
      embeddings: {
        dimensions: 2,
        embedDocuments: async texts => texts.map(() => new Float32Array([1, 0])),
        embedQuery: async () => new Float32Array([1, 0])
      },
      housekeeping: { summarize: async () => ({ summary: "Repository source." }) }
    });
    const agent: AgentDefinition = {
      id: "architect",
      name: "Architect",
      description: "Asks bounded repository questions.",
      provider: "openrouter",
      modelId: "fixture",
      systemPrompt: "Use the repository broker.",
      temperature: 0,
      maxOutputTokens: 300,
      reasoning: { enabled: false, displayMode: "hidden" },
      tools: [],
      contextBudget: {
        softLimitTokens: 5_000,
        hardLimitTokens: 8_000,
        recentTranscriptTokens: 2_000,
        retrievedContextTokens: 1_000,
        notebookTokens: 0
      }
    };
    store.addAgent(room.id, agent);
    await workspace.ingest({
      roomId: room.id,
      filename: "src/router.ts",
      mediaType: "text/typescript",
      bytes: Buffer.from("export function routeSpeaker() { return 'balanced'; }"),
      sourceType: "repository"
    });
    await workspace.ingest({
      roomId: room.id,
      filename: "private-routing-note.md",
      mediaType: "text/markdown",
      bytes: Buffer.from("# Secret\nrouteSpeaker uses a private unpublished method."),
      sourceType: "persona-memory",
      ownerAgentId: agent.id
    });
    const human = store.appendMessage({
      roomId: room.id,
      authorType: "human",
      authorId: "human",
      content: "How is speaker routing implemented?"
    });
    let call = 0;
    const provider: ModelProvider = {
      id: "openrouter",
      listModels: async () => [],
      getCapabilities: async () => ({
        contextLength: 8_000,
        textInput: true,
        imageInput: false,
        pdfInput: false,
        toolCalling: true,
        structuredOutput: false,
        reasoningInputControl: false,
        reasoningOutput: false,
        promptCaching: false
      }),
      streamChat: async function* (request) {
        call += 1;
        if (call === 1) {
          expect(request.messages[0]?.content).toContain("Repository corpus");
          expect(request.messages[0]?.content).not.toContain("routeSpeaker");
          expect(request.tools?.some(tool => tool.name === "ask_table_researcher"))
            .toBe(true);
          yield {
            type: "tool-call",
            id: "repo-question",
            name: "ask_table_researcher",
            arguments: JSON.stringify({
              question: "How is speaker routing implemented?",
              scope: "repository"
            })
          };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        expect(request.messages.at(-1)?.content).toContain("routeSpeaker");
        expect(request.messages.at(-1)?.content).not.toContain("private unpublished");
        yield { type: "text-delta", text: "The repository returns balanced routing." };
        yield { type: "done", finishReason: "stop" };
      }
    };
    const providers = new Map([["openrouter", provider]]);
    const tools = new RoomToolExecutor(store, workspace, providers);
    const engine = new RoomEngine(store, providers, tools);

    const result = await engine.generate({
      roomId: room.id,
      agentId: agent.id,
      targetMessageId: human.id
    });
    const inspection = store.getGenerationInspection(result.generation.id);

    expect(result.message.citedChunkIds).toHaveLength(1);
    expect(inspection.toolCalls).toMatchObject([
      { toolName: "ask_table_researcher", status: "complete" }
    ]);
    store.close();
  });

  it("collects PSFN evidence from shared table items without leaking repository or private libraries", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-psfn-evidence-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({ title: "Evidence room" });
    store.addAgent(room.id, {
      id: "remote",
      name: "Remote",
      description: "PSFN participant",
      provider: "psfn",
      modelId: "remote",
      systemPrompt: "",
      temperature: 0,
      maxOutputTokens: 256,
      reasoning: { enabled: false, displayMode: "hidden" },
      tools: [],
      contextBudget: {
        softLimitTokens: 4_000,
        hardLimitTokens: 8_000,
        recentTranscriptTokens: 2_000,
        retrievedContextTokens: 1_000,
        notebookTokens: 0
      }
    });
    const workspace = new WorkspaceService({
      store,
      dataRoot: root,
      embeddings: {
        dimensions: 2,
        embedDocuments: async texts => texts.map(() => new Float32Array([1, 0])),
        embedQuery: async () => new Float32Array([1, 0])
      },
      housekeeping: { summarize: async () => ({ summary: "Grounding source." }) }
    });
    await workspace.ingest({
      roomId: room.id,
      filename: "shared.md",
      mediaType: "text/markdown",
      bytes: Buffer.from("LANTERN shared table evidence"),
      sourceType: "upload"
    });
    await workspace.ingest({
      roomId: room.id,
      filename: "repository.ts",
      mediaType: "text/typescript",
      bytes: Buffer.from("LANTERN repository secret"),
      sourceType: "repository"
    });
    await workspace.ingest({
      roomId: room.id,
      filename: "private.md",
      mediaType: "text/markdown",
      bytes: Buffer.from("LANTERN private persona secret"),
      sourceType: "persona-memory",
      ownerAgentId: "remote"
    });
    const result = await new RoomToolExecutor(store, workspace)
      .collectParticipantEvidence({
        roomId: room.id,
        agentId: "remote",
        query: "LANTERN"
      });

    expect(result.evidence).toMatchObject([{
      artifactTitle: "shared.md",
      excerpt: expect.stringContaining("shared table evidence")
    }]);
    expect(result.content).not.toContain("repository secret");
    expect(result.content).not.toContain("private persona secret");
    store.close();
  });
});
