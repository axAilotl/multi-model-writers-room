import type { NormalizedToolDefinition } from "@writers-room/contracts";
import { z } from "zod";
import { uuidv7 } from "../shared/id.js";
import { RoomStore } from "../storage/room-store.js";
import {
  formatCitation
} from "../workspace/workspace-repository.js";
import { WorkspaceService } from "../workspace/workspace-service.js";

export interface ToolExecutionResult {
  content: string;
  citedChunkIds: string[];
}

export interface ToolExecutor {
  definitions(names: readonly string[]): NormalizedToolDefinition[];
  workspaceManifest(roomId: string): string;
  execute(input: {
    roomId: string;
    agentId: string;
    generationId: string;
    callId: string;
    name: string;
    arguments: string;
  }): Promise<ToolExecutionResult>;
}

const schemas = {
  list_workspace: z.object({}),
  get_artifact_summary: z.object({ artifact_id: z.string() }),
  search_workspace: z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(20).optional()
  }),
  find_exact_text: z.object({
    query: z.string().min(1),
    artifact_ids: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(20).optional()
  }),
  read_artifact_chunk: z.object({ chunk_id: z.string() }),
  read_artifact_range: z.object({
    artifact_id: z.string(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative()
  }),
  read_shared_scratchpad: z.object({}),
  append_shared_note: z.object({
    text: z.string().min(1).max(4_000),
    category: z.string().max(80).optional()
  }),
  update_shared_note: z.object({
    note_id: z.string(),
    text: z.string().min(1).max(4_000)
  }),
  inspect_room_state: z.object({})
} as const;

type ToolName = keyof typeof schemas;

const descriptions: Record<ToolName, string> = {
  list_workspace: "List ready workspace artifacts and their summaries.",
  get_artifact_summary: "Read one artifact's summary, outline, and metadata.",
  search_workspace: "Hybrid lexical and semantic search over workspace chunks.",
  find_exact_text: "Find exact text fragments in workspace chunks.",
  read_artifact_chunk: "Read one cited workspace chunk by stable ID.",
  read_artifact_range: "Read a contiguous ordinal range from one artifact.",
  read_shared_scratchpad: "Read current non-archived shared room notes.",
  append_shared_note: "Append a concise shared note with attribution.",
  update_shared_note: "Update a shared note.",
  inspect_room_state: "Inspect room controls and participant runtime state."
};

function definition(name: ToolName): NormalizedToolDefinition {
  return {
    name,
    description: descriptions[name],
    inputSchema: z.toJSONSchema(schemas[name]) as Record<string, unknown>
  };
}

export const safeRoomToolDefinitions = (Object.keys(schemas) as ToolName[])
  .map(definition);

export class RoomToolExecutor implements ToolExecutor {
  constructor(
    private readonly store: RoomStore,
    private readonly workspace: WorkspaceService
  ) {}

  definitions(names: readonly string[]): NormalizedToolDefinition[] {
    const allowed = new Set(names);
    return safeRoomToolDefinitions.filter(tool => allowed.has(tool.name));
  }

  workspaceManifest(roomId: string): string {
    return this.workspace.manifest(roomId);
  }

  async execute(input: {
    roomId: string;
    agentId: string;
    generationId: string;
    callId: string;
    name: string;
    arguments: string;
  }): Promise<ToolExecutionResult> {
    const schema = schemas[input.name as ToolName];
    if (!schema) throw new Error(`Unknown or unauthorized room tool: ${input.name}`);
    const definitionAllowed = this.definitions(
      this.store.listAgents(input.roomId)
        .find(agent => agent.id === input.agentId)?.tools ?? []
    ).some(tool => tool.name === input.name);
    if (!definitionAllowed) throw new Error(`Agent is not allowed to use ${input.name}`);
    const parsedJson: unknown = input.arguments.trim()
      ? JSON.parse(input.arguments)
      : {};
    const args = schema.parse(parsedJson) as Record<string, unknown>;
    const recordId = uuidv7();
    this.store.recordToolCall({
      id: recordId,
      generationId: input.generationId,
      toolName: input.name,
      arguments: args
    });
    try {
      const result = await this.dispatch(input, args);
      this.store.completeToolCall({ id: recordId, result });
      return result;
    } catch (error) {
      this.store.completeToolCall({
        id: recordId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private async dispatch(
    input: { roomId: string; agentId: string; name: string },
    args: Record<string, unknown>
  ): Promise<ToolExecutionResult> {
    switch (input.name as ToolName) {
      case "list_workspace":
        return {
          content: JSON.stringify(this.workspace.listArtifacts(input.roomId)),
          citedChunkIds: []
        };
      case "get_artifact_summary":
        return {
          content: JSON.stringify(this.workspace.getArtifact(args.artifact_id as string)),
          citedChunkIds: []
        };
      case "search_workspace": {
        const results = await this.workspace.search({
          roomId: input.roomId,
          query: args.query as string,
          ...(args.limit === undefined ? {} : { limit: args.limit as number })
        });
        return {
          content: results.map(result =>
            `${result.citation}\n${result.chunk.text}`
          ).join("\n\n"),
          citedChunkIds: results.map(result => result.chunk.id)
        };
      }
      case "find_exact_text": {
        const chunks = this.workspace.findExact({
          roomId: input.roomId,
          query: args.query as string,
          ...(args.artifact_ids === undefined
            ? {}
            : { artifactIds: args.artifact_ids as string[] }),
          ...(args.limit === undefined ? {} : { limit: args.limit as number })
        });
        return {
          content: chunks.map(chunk => {
            const artifact = this.workspace.getArtifact(chunk.artifactId);
            return `${formatCitation(artifact, chunk)}\n${chunk.text}`;
          }).join("\n\n"),
          citedChunkIds: chunks.map(chunk => chunk.id)
        };
      }
      case "read_artifact_chunk": {
        const chunk = this.workspace.getChunk(args.chunk_id as string);
        const artifact = this.workspace.getArtifact(chunk.artifactId);
        return {
          content: `${formatCitation(artifact, chunk)}\n${chunk.text}`,
          citedChunkIds: [chunk.id]
        };
      }
      case "read_artifact_range": {
        const chunks = this.workspace.readRange(
          args.artifact_id as string,
          args.start as number,
          args.end as number
        );
        return {
          content: chunks.map(chunk => chunk.text).join("\n\n"),
          citedChunkIds: chunks.map(chunk => chunk.id)
        };
      }
      case "read_shared_scratchpad":
        return {
          content: JSON.stringify(
            this.store.listNotes(input.roomId).filter(note => !note.archivedAt)
          ),
          citedChunkIds: []
        };
      case "append_shared_note": {
        const note = this.store.appendNote({
          roomId: input.roomId,
          authorType: "agent",
          authorId: input.agentId,
          text: args.text as string,
          ...(args.category === undefined
            ? {}
            : { category: args.category as string })
        });
        return { content: JSON.stringify(note), citedChunkIds: [] };
      }
      case "update_shared_note": {
        const note = this.store.updateNote(args.note_id as string, {
          text: args.text as string
        });
        return { content: JSON.stringify(note), citedChunkIds: [] };
      }
      case "inspect_room_state": {
        const snapshot = this.store.getSnapshot(input.roomId);
        return {
          content: JSON.stringify({
            room: snapshot.room,
            agents: snapshot.agents.map(agent => ({
              id: agent.id,
              name: agent.name
            })),
            runtime: snapshot.runtime
          }),
          citedChunkIds: []
        };
      }
    }
  }
}
