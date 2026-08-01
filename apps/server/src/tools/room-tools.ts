import type {
  NormalizedToolDefinition,
  WorkspaceArtifact,
  WorkspaceSearchResult
} from "@writers-room/contracts";
import { z } from "zod";
import { uuidv7 } from "../shared/id.js";
import { RoomStore } from "../storage/room-store.js";
import {
  formatCitation
} from "../workspace/workspace-repository.js";
import { WorkspaceService } from "../workspace/workspace-service.js";
import type { ModelProvider } from "../providers/model-provider.js";

export interface ToolExecutionResult {
  content: string;
  citedChunkIds: string[];
}

export interface ToolExecutor {
  definitions(names: readonly string[]): NormalizedToolDefinition[];
  workspaceManifest(roomId: string, agentId: string): string;
  collectPersonaEvidence(input: {
    roomId: string;
    agentId: string;
    query: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<ToolExecutionResult>;
  execute(input: {
    roomId: string;
    agentId: string;
    generationId: string;
    callId: string;
    name: string;
    arguments: string;
    signal: AbortSignal;
  }): Promise<ToolExecutionResult>;
}

function withAbort<Result>(
  operation: Promise<Result>,
  signal: AbortSignal
): Promise<Result> {
  if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  return new Promise<Result>((resolve, reject) => {
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
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
  ask_table_researcher: z.object({
    question: z.string().trim().min(3).max(4_000),
    scope: z.enum(["repository", "documents", "all"]).optional(),
    limit: z.number().int().min(1).max(12).optional()
  }),
  search_conversation_history: z.object({
    query: z.string().trim().min(2).max(4_000),
    limit: z.number().int().min(1).max(20).optional()
  }),
  read_message_range: z.object({
    first_message_id: z.string().min(1),
    last_message_id: z.string().min(1),
    first_message_offset: z.number().int().nonnegative().optional()
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
  inspect_room_state: z.object({}),
  yield_turn: z.object({
    reason: z.string().max(500).optional()
  }),
  request_another_agent: z.object({
    agent_id: z.string(),
    reason: z.string().min(1).max(500)
  })
} as const;

type ToolName = keyof typeof schemas;

const descriptions: Record<ToolName, string> = {
  list_workspace: "List ready workspace artifacts and their summaries.",
  get_artifact_summary: "Read one artifact's summary, outline, and metadata. Pass the stable artifact_id shown in the workspace manifest or returned by list_workspace, not its filename.",
  search_workspace: "Hybrid lexical and semantic search over workspace chunks.",
  find_exact_text: "Find exact text fragments in workspace chunks.",
  read_artifact_chunk: "Read one cited workspace chunk by stable ID.",
  read_artifact_range: "Read a contiguous ordinal range from one artifact. Pass the stable artifact_id shown in the workspace manifest or returned by list_workspace, not its filename.",
  ask_table_researcher: "Delegate a bounded evidence question to the always-available Table Researcher utility. It searches shared table documents or the repository corpus, never private persona libraries, and returns a concise provenance-bearing answer; use this instead of direct repository search.",
  search_conversation_history: "Search the canonical raw room transcript, including messages compacted out of the current prompt. Returns stable message IDs and excerpts.",
  read_message_range: "Read a structured JSON page of the canonical raw transcript between two stable message IDs. When continuation is present, pass that object directly as the next call's arguments; first_message_offset resumes inside a long message without losing text.",
  read_shared_scratchpad: "Read current non-archived shared room notes.",
  append_shared_note: "Append a concise shared note with attribution.",
  update_shared_note: "Update a shared note.",
  inspect_room_state: "Inspect room controls and participant runtime state.",
  yield_turn: "Explicitly end the current intervention without further tool work.",
  request_another_agent: "Request that another named room participant examine a question."
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
    private readonly workspace: WorkspaceService,
    private readonly providers: ReadonlyMap<string, ModelProvider> = new Map()
  ) {}

  definitions(names: readonly string[]): NormalizedToolDefinition[] {
    const allowed = new Set([
      ...names,
      "ask_table_researcher",
      "search_conversation_history",
      "read_message_range"
    ]);
    return safeRoomToolDefinitions.filter(tool => allowed.has(tool.name));
  }

  workspaceManifest(roomId: string, agentId: string): string {
    return this.workspace.manifest(roomId, agentId);
  }

  async collectPersonaEvidence(input: {
    roomId: string;
    agentId: string;
    query: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<ToolExecutionResult> {
    const operation = this.workspace.search({
      roomId: input.roomId,
      query: input.query,
      sourceTypes: ["persona-memory"],
      visibleToAgentId: input.agentId,
      limit: input.limit ?? 6,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    const results = input.signal === undefined
      ? await operation
      : await withAbort(operation, input.signal);
    return {
      content: renderResearchEvidence(results),
      citedChunkIds: results.map(result => result.chunk.id)
    };
  }

  async execute(input: {
    roomId: string;
    agentId: string;
    generationId: string;
    callId: string;
    name: string;
    arguments: string;
    signal: AbortSignal;
  }): Promise<ToolExecutionResult> {
    input.signal.throwIfAborted();
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
    const args = schema.parse(
      normalizeToolArgumentAliases(input.name, parsedJson)
    ) as Record<string, unknown>;
    const recordId = uuidv7();
    this.store.recordToolCall({
      id: recordId,
      generationId: input.generationId,
      toolName: input.name,
      arguments: args
    });
    try {
      const result = await withAbort(this.dispatch(input, args), input.signal);
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
    input: {
      roomId: string;
      agentId: string;
      name: string;
      signal: AbortSignal;
    },
    args: Record<string, unknown>
  ): Promise<ToolExecutionResult> {
    switch (input.name as ToolName) {
      case "list_workspace":
        return {
          content: JSON.stringify(this.workspace.listArtifacts(input.roomId).filter(
            artifact => artifact.sourceType !== "repository" &&
              (artifact.ownerAgentId === undefined || artifact.ownerAgentId === input.agentId)
          )),
          citedChunkIds: []
        };
      case "get_artifact_summary": {
        const artifact = this.resolveDirectArtifact(
          input.roomId,
          args.artifact_id as string,
          input.agentId
        );
        return {
          content: JSON.stringify(artifact),
          citedChunkIds: []
        };
      }
      case "search_workspace": {
        const results = await this.workspace.search({
          roomId: input.roomId,
          query: args.query as string,
          sourceTypes: directDocumentSourceTypes,
          visibleToAgentId: input.agentId,
          signal: input.signal,
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
          sourceTypes: directDocumentSourceTypes,
          visibleToAgentId: input.agentId,
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
        const chunk = this.workspace.getChunkForRoom(
          input.roomId,
          args.chunk_id as string
        );
        const artifact = this.workspace.getArtifactForRoom(
          input.roomId,
          chunk.artifactId
        );
        this.assertDirectArtifact(artifact, input.agentId);
        return {
          content: `${formatCitation(artifact, chunk)}\n${chunk.text}`,
          citedChunkIds: [chunk.id]
        };
      }
      case "read_artifact_range": {
        const artifact = this.resolveDirectArtifact(
          input.roomId,
          args.artifact_id as string,
          input.agentId
        );
        const chunks = this.workspace.readRangeForRoom(
          input.roomId,
          artifact.id,
          args.start as number,
          args.end as number
        );
        return {
          content: chunks.map(chunk => chunk.text).join("\n\n"),
          citedChunkIds: chunks.map(chunk => chunk.id)
        };
      }
      case "ask_table_researcher":
        return this.askTableResearcher({
          roomId: input.roomId,
          agentId: input.agentId,
          question: args.question as string,
          scope: (args.scope as "repository" | "documents" | "all" | undefined) ?? "all",
          limit: (args.limit as number | undefined) ?? 8,
          signal: input.signal
        });
      case "search_conversation_history":
        return {
          content: this.searchConversationHistory(
            input.roomId,
            args.query as string,
            (args.limit as number | undefined) ?? 8
          ),
          citedChunkIds: []
        };
      case "read_message_range":
        return {
          content: this.readMessageRange(
            input.roomId,
            args.first_message_id as string,
            args.last_message_id as string,
            (args.first_message_offset as number | undefined) ?? 0
          ),
          citedChunkIds: []
        };
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
        const note = this.store.updateNote(
          args.note_id as string,
          { text: args.text as string },
          input.roomId
        );
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
      case "yield_turn":
        return {
          content: JSON.stringify({ yielded: true, reason: args.reason ?? null }),
          citedChunkIds: []
        };
      case "request_another_agent": {
        const requested = this.store.listAgents(input.roomId)
          .find(agent => agent.id === args.agent_id);
        if (!requested) throw new Error(`Requested agent is not in the room: ${String(args.agent_id)}`);
        const note = this.store.appendNote({
          roomId: input.roomId,
          authorType: "agent",
          authorId: input.agentId,
          category: "agent-request",
          text: `Request for ${requested.name}: ${String(args.reason)}`
        });
        return {
          content: JSON.stringify({
            requestedAgentId: requested.id,
            noteId: note.id,
            queued: false
          }),
          citedChunkIds: []
        };
      }
    }
  }

  private searchConversationHistory(
    roomId: string,
    query: string,
    limit: number
  ): string {
    const normalizedQuery = query.toLowerCase();
    const terms = [...new Set(
      normalizedQuery.match(/[\p{L}\p{N}]{2,}/gu) ?? []
    )];
    const matches = this.store.searchMessages(roomId, query, Math.max(limit * 4, 20))
      .filter(message => message.status !== "streaming")
      .map(message => {
        const content = message.content.toLowerCase();
        const score = (content.includes(normalizedQuery) ? 10 : 0) +
          terms.reduce((sum, term) => sum + (content.includes(term) ? 1 : 0), 0);
        return { message, score };
      })
      .filter(result => result.score > 0)
      .sort((left, right) =>
        right.score - left.score || right.message.sequence - left.message.sequence
      )
      .slice(0, limit);
    if (matches.length === 0) {
      return "No matching raw transcript messages were found.";
    }
    return matches.map(({ message }) =>
      this.renderHistoryExcerpt(message)
    ).join("\n\n");
  }

  private readMessageRange(
    roomId: string,
    firstMessageId: string,
    lastMessageId: string,
    firstMessageOffset: number
  ): string {
    const messages = this.store.listMessages(roomId);
    const first = messages.find(message => message.id === firstMessageId);
    const last = messages.find(message => message.id === lastMessageId);
    if (!first || !last) {
      throw new Error("Message range does not belong to this room");
    }
    if (first.sequence > last.sequence) {
      throw new Error("Message range must be ordered from first to last");
    }
    const start = first.sequence;
    const end = last.sequence;
    const selected = messages.filter(message =>
      message.sequence >= start && message.sequence <= end
    );
    if (firstMessageOffset > first.content.length) {
      throw new Error("Message offset exceeds the first message length");
    }
    const maximumCharacters = 32_000;
    type PageMessage = {
      messageId: string;
      sequence: number;
      author: string;
      createdAt: string;
      lifecycle: string;
      contentOffset: number;
      content: string;
    };
    type PageCursor = {
      first_message_id: string;
      last_message_id: string;
      first_message_offset: number;
    };
    const pageMessages: PageMessage[] = [];
    let continuation: PageCursor | undefined;
    const serialize = (
      items: PageMessage[],
      cursor: PageCursor | undefined
    ) => JSON.stringify({
      kind: "canonical_message_range",
      messages: items,
      continuation: cursor ?? null
    });
    for (let index = 0; index < selected.length; index += 1) {
      const message = selected[index]!;
      const offset = index === 0 ? firstMessageOffset : 0;
      const content = message.content.slice(offset);
      const base: Omit<PageMessage, "content"> = {
        messageId: message.id,
        sequence: message.sequence,
        author: this.historyAuthor(message),
        createdAt: message.createdAt,
        lifecycle: message.lifecycle,
        contentOffset: offset
      };
      if (pageMessages.length >= 100) {
        continuation = {
          first_message_id: message.id,
          last_message_id: last.id,
          first_message_offset: offset
        };
        break;
      }
      const next = selected[index + 1];
      const afterFull = next
        ? {
            first_message_id: next.id,
            last_message_id: last.id,
            first_message_offset: 0
          }
        : undefined;
      const full = { ...base, content };
      if (serialize([...pageMessages, full], afterFull).length <= maximumCharacters) {
        pageMessages.push(full);
        continuation = afterFull;
        continue;
      }
      let low = 0;
      let high = content.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const cursor = {
          first_message_id: message.id,
          last_message_id: last.id,
          first_message_offset: offset + middle
        };
        const candidate = { ...base, content: content.slice(0, middle) };
        if (serialize([...pageMessages, candidate], cursor).length <= maximumCharacters) {
          low = middle;
        } else {
          high = middle - 1;
        }
      }
      if (low === 0) {
        throw new Error("Message metadata exceeds the history page limit");
      }
      pageMessages.push({ ...base, content: content.slice(0, low) });
      continuation = {
        first_message_id: message.id,
        last_message_id: last.id,
        first_message_offset: offset + low
      };
      break;
    }
    return serialize(pageMessages, continuation);
  }

  private historyAuthor(
    message: ReturnType<RoomStore["listMessages"]>[number]
  ): string {
    return message.authorType === "human"
      ? "Human"
      : this.store.listAgents(message.roomId).find(agent =>
          agent.id === message.authorId
        )?.name ?? message.authorId;
  }

  private historyMessageHeader(
    message: ReturnType<RoomStore["listMessages"]>[number],
    contentOffset = 0
  ): string {
    const author = this.historyAuthor(message);
    return `[message_id: ${message.id} · sequence: ${message.sequence} · ${author} · ${message.createdAt} · ${message.lifecycle} · content_offset: ${contentOffset}]`;
  }

  private renderHistoryExcerpt(
    message: ReturnType<RoomStore["listMessages"]>[number]
  ): string {
    const content = message.content.length > 6_000
      ? `${message.content.slice(0, 5_978)}\n[…message excerpt clipped; use read_message_range for exact pagination]`
      : message.content;
    return [
      this.historyMessageHeader(message),
      content
    ].join("\n");
  }

  private resolveDirectArtifact(
    roomId: string,
    reference: string,
    agentId: string
  ): WorkspaceArtifact {
    const artifact = this.workspace.resolveArtifactForRoom(roomId, reference);
    this.assertDirectArtifact(artifact, agentId);
    return artifact;
  }

  private assertDirectArtifact(artifact: WorkspaceArtifact, agentId: string): void {
    if (artifact.sourceType === "repository") {
      throw new Error(
        "Repository contents are brokered; ask the Table Researcher automata instead"
      );
    }
    if (artifact.ownerAgentId !== undefined && artifact.ownerAgentId !== agentId) {
      throw new Error("Persona library artifact belongs to another participant");
    }
  }

  private async askTableResearcher(input: {
    roomId: string;
    agentId: string;
    question: string;
    scope: "repository" | "documents" | "all";
    limit: number;
    signal: AbortSignal;
  }): Promise<ToolExecutionResult> {
    const sourceTypes = input.scope === "repository"
      ? ["repository" as const]
      : input.scope === "documents"
        ? sharedDocumentSourceTypes
        : [...sharedDocumentSourceTypes, "repository" as const];
    const results = await withAbort(
      this.workspace.search({
        roomId: input.roomId,
        query: input.question,
        sourceTypes: [...sourceTypes],
        visibleToAgentId: input.agentId,
        limit: input.limit,
        signal: input.signal
      }),
      input.signal
    );
    if (results.length === 0) {
      return {
        content: "Table Researcher automata completed: no relevant indexed evidence was found.",
        citedChunkIds: []
      };
    }
    const evidence = renderResearchEvidence(results);
    const defaultModel = this.store.getDefaultModel();
    const provider = defaultModel
      ? this.providers.get(defaultModel.provider)
      : undefined;
    let answer = "";
    let synthesisError: string | undefined;
    if (defaultModel && provider) {
      try {
        for await (const event of provider.streamChat({
          modelId: defaultModel.modelId,
          messages: [
            {
              role: "system",
              content: [
                "You are the Table Researcher automata, a bounded read-only evidence worker.",
                "Answer only from the supplied excerpts. Preserve bracketed citations exactly.",
                "Distinguish direct evidence from inference. If evidence is insufficient, say so.",
                "Return a compact research handoff, not hidden reasoning or a conversational preamble."
              ].join("\n")
            },
            {
              role: "user",
              content: `Question from ${input.agentId}:\n${input.question}\n\nIndexed evidence:\n${evidence}`
            }
          ],
          temperature: 0.1,
          maxOutputTokens: 1_200,
          reasoning: { enabled: true, effort: "low", displayMode: "hidden" },
          tools: [],
          sessionId: `${input.roomId}:table-researcher`,
          signal: input.signal
        })) {
          if (event.type === "text-delta") answer += event.text;
        }
      } catch (error) {
        synthesisError = error instanceof Error ? error.message : String(error);
      }
    }
    const sources = results.map(result => result.citation).join("\n");
    const handoff = answer.trim()
      ? `Table Researcher automata completed:\n${answer.trim()}\n\nSources:\n${sources}`
      : [
          "Table Researcher automata returned a provenance-bearing extractive handoff.",
          synthesisError
            ? `Model synthesis was blocked: ${synthesisError}`
            : "No fallback model is configured; showing retrieved evidence directly.",
          "",
          evidence
        ].join("\n");
    return {
      content: handoff,
      citedChunkIds: results.map(result => result.chunk.id)
    };
  }
}

const directDocumentSourceTypes: WorkspaceArtifact["sourceType"][] = [
  "upload", "paste", "generated", "persona-memory", "url"
];

const sharedDocumentSourceTypes: WorkspaceArtifact["sourceType"][] = [
  "upload", "paste", "generated", "url"
];

function normalizeToolArgumentAliases(name: string, value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const args = { ...(value as Record<string, unknown>) };
  const aliases: Record<string, string> = {
    artifactId: "artifact_id",
    artifactIds: "artifact_ids",
    chunkId: "chunk_id",
    noteId: "note_id",
    agentId: "agent_id",
    firstMessageId: "first_message_id",
    lastMessageId: "last_message_id",
    firstMessageOffset: "first_message_offset"
  };
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (args[canonical] === undefined && args[alias] !== undefined) {
      args[canonical] = args[alias];
      delete args[alias];
    }
  }
  if (name === "ask_table_researcher" && args.question === undefined && args.query !== undefined) {
    args.question = args.query;
    delete args.query;
  }
  return args;
}

function renderResearchEvidence(results: WorkspaceSearchResult[]): string {
  return results.map(result => [
    result.citation,
    result.chunk.text.slice(0, 3_000)
  ].join("\n")).join("\n\n");
}
