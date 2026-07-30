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
import { RoomEngine } from "./room-engine.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("room generation tool seam", () => {
  it("executes a bounded workspace tool round and persists its cited evidence", async () => {
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
    await workspace.ingest({
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
      getCapabilities: async () => undefined,
      streamChat: async function* (
        request: NormalizedChatRequest
      ): AsyncIterable<NormalizedGenerationEvent> {
        round += 1;
        if (round === 1) {
          yield {
            type: "tool-call",
            id: "call-1",
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
    expect(inspection.toolCalls).toMatchObject([
      { toolName: "search_workspace", status: "complete" }
    ]);
    expect(inspection.citations).toMatchObject([
      { filename: "roadmap.md", text: expect.stringContaining("canonical") }
    ]);
    store.close();
  });
});
