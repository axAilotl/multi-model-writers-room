import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  agentDefinitionSchema,
  agentRuntimeStateSchema,
  artifactSchema,
  defaultRoomSettings,
  generationRecordSchema,
  roomMessageSchema,
  roomSchema,
  roomSettingsSchema,
  sharedNoteSchema,
  type AgentDefinition,
  type AgentRuntimeState,
  type GenerationRecord,
  type Room,
  type RoomMessage,
  type RoomSettings,
  type RoomSnapshot,
  type RoomStreamEvent,
  type RoomStreamEventInput,
  type SharedNote,
  type WorkspaceArtifact
} from "@writers-room/contracts";
import { uuidv7 } from "../shared/id.js";
import { migrate } from "./migrations.js";

interface MessageInput {
  roomId: string;
  authorType: RoomMessage["authorType"];
  authorId: string;
  content: string;
  status?: RoomMessage["status"];
  generationId?: string;
  replyToMessageId?: string;
  mentionedAgentIds?: string[];
  attachmentIds?: string[];
  citedChunkIds?: string[];
  revisionOfMessageId?: string;
}

interface StoredRoomRow {
  id: string;
  title: string;
  status: Room["status"];
  settings_json: string;
  latest_sequence: number;
  created_at: string;
  updated_at: string;
}

interface JsonRow {
  payload_json: string;
}

type RoomSettingsPatch = {
  [Key in keyof RoomSettings]?: RoomSettings[Key] | undefined;
};

export class RoomStore {
  readonly databasePath: string;
  readonly database: Database.Database;
  private readonly eventListeners = new Set<(
    roomId: string,
    event: RoomStreamEvent
  ) => void>();

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    migrate(this.database);
  }

  close(): void {
    if (!this.database.open) return;
    this.database.pragma("wal_checkpoint(TRUNCATE)");
    this.database.close();
  }

  subscribeEvents(
    listener: (roomId: string, event: RoomStreamEvent) => void
  ): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  createRoom(input: { title: string; settings?: RoomSettingsPatch | undefined }): Room {
    const now = new Date().toISOString();
    const settings = roomSettingsSchema.parse({
      ...defaultRoomSettings,
      ...input.settings
    });
    const room = roomSchema.parse({
      id: uuidv7(),
      title: input.title,
      status: "running",
      settings,
      createdAt: now,
      updatedAt: now
    });
    this.database.prepare(`
      INSERT INTO rooms(id, title, status, settings_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      room.id,
      room.title,
      room.status,
      JSON.stringify(room.settings),
      room.createdAt,
      room.updatedAt
    );
    return room;
  }

  listRooms(): Room[] {
    return this.database.prepare(
      "SELECT * FROM rooms ORDER BY updated_at DESC"
    ).all().map(row => this.parseRoom(row as StoredRoomRow));
  }

  getRoom(roomId: string): Room {
    const row = this.database.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
    if (!row) throw new Error(`Room not found: ${roomId}`);
    return this.parseRoom(row as StoredRoomRow);
  }

  updateRoom(
    roomId: string,
    patch: {
      title?: string | undefined;
      status?: Room["status"] | undefined;
      settings?: RoomSettingsPatch | undefined;
    }
  ): Room {
    const current = this.getRoom(roomId);
    const next = roomSchema.parse({
      ...current,
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      settings: roomSettingsSchema.parse({
        ...current.settings,
        ...patch.settings
      }),
      updatedAt: new Date().toISOString()
    });
    this.database.prepare(`
      UPDATE rooms
      SET title = ?, status = ?, settings_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.title,
      next.status,
      JSON.stringify(next.settings),
      next.updatedAt,
      roomId
    );
    return next;
  }

  addAgent(roomId: string, definition: AgentDefinition): AgentDefinition {
    this.getRoom(roomId);
    const agent = agentDefinitionSchema.parse(definition);
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO agents(id, definition_json, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          definition_json = excluded.definition_json,
          updated_at = excluded.updated_at
      `).run(agent.id, JSON.stringify(agent), now, now);
      const position = (this.database.prepare(
        "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM room_agents WHERE room_id = ?"
      ).get(roomId) as { position: number }).position;
      this.database.prepare(`
        INSERT INTO room_agents(room_id, agent_id, position)
        VALUES (?, ?, ?)
        ON CONFLICT(room_id, agent_id) DO NOTHING
      `).run(roomId, agent.id, position);
      const runtime = agentRuntimeStateSchema.parse({
        roomId,
        agentId: agent.id,
        fatigue: 0,
        activation: 0,
        consecutiveTurns: 0,
        muted: false
      });
      this.database.prepare(`
        INSERT INTO agent_runtime_state(room_id, agent_id, payload_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(room_id, agent_id) DO NOTHING
      `).run(roomId, agent.id, JSON.stringify(runtime), now);
    })();
    return agent;
  }

  listAgents(roomId: string): AgentDefinition[] {
    return this.database.prepare(`
      SELECT a.definition_json AS payload_json
      FROM room_agents ra
      JOIN agents a ON a.id = ra.agent_id
      WHERE ra.room_id = ?
      ORDER BY ra.position
    `).all(roomId).map(row =>
      agentDefinitionSchema.parse(JSON.parse((row as JsonRow).payload_json))
    );
  }

  getRuntime(roomId: string, agentId: string): AgentRuntimeState {
    const row = this.database.prepare(`
      SELECT payload_json FROM agent_runtime_state
      WHERE room_id = ? AND agent_id = ?
    `).get(roomId, agentId) as JsonRow | undefined;
    if (!row) throw new Error(`Runtime state not found: ${roomId}/${agentId}`);
    return agentRuntimeStateSchema.parse(JSON.parse(row.payload_json));
  }

  updateRuntime(
    roomId: string,
    agentId: string,
    patch: Partial<AgentRuntimeState>
  ): AgentRuntimeState {
    const current = this.getRuntime(roomId, agentId);
    const runtime = agentRuntimeStateSchema.parse({ ...current, ...patch });
    this.database.prepare(`
      UPDATE agent_runtime_state
      SET payload_json = ?, updated_at = ?
      WHERE room_id = ? AND agent_id = ?
    `).run(JSON.stringify(runtime), new Date().toISOString(), roomId, agentId);
    this.appendRoomEvent(roomId, { type: "runtime.updated", runtime });
    return runtime;
  }

  listNotes(roomId: string): SharedNote[] {
    return this.listJson<SharedNote>(
      "SELECT payload_json FROM shared_notes WHERE room_id = ? ORDER BY created_at",
      roomId,
      value => sharedNoteSchema.parse(value)
    );
  }

  appendNote(input: {
    roomId: string;
    authorType: SharedNote["authorType"];
    authorId: string;
    text: string;
    category?: string;
  }): SharedNote {
    this.getRoom(input.roomId);
    const now = new Date().toISOString();
    const note = sharedNoteSchema.parse({
      id: uuidv7(),
      roomId: input.roomId,
      authorType: input.authorType,
      authorId: input.authorId,
      text: input.text,
      ...(input.category === undefined ? {} : { category: input.category }),
      createdAt: now,
      updatedAt: now
    });
    this.database.prepare(`
      INSERT INTO shared_notes(id, room_id, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(note.id, note.roomId, JSON.stringify(note), now, now);
    this.appendRoomEvent(note.roomId, { type: "scratchpad.updated", note });
    return note;
  }

  updateNote(
    noteId: string,
    patch: { text?: string; category?: string; archive?: boolean }
  ): SharedNote {
    const row = this.database.prepare(
      "SELECT payload_json FROM shared_notes WHERE id = ?"
    ).get(noteId) as JsonRow | undefined;
    if (!row) throw new Error(`Shared note not found: ${noteId}`);
    const current = sharedNoteSchema.parse(JSON.parse(row.payload_json));
    const now = new Date().toISOString();
    const note = sharedNoteSchema.parse({
      ...current,
      ...(patch.text === undefined ? {} : { text: patch.text }),
      ...(patch.category === undefined ? {} : { category: patch.category }),
      ...(patch.archive ? { archivedAt: now } : {}),
      updatedAt: now
    });
    this.database.prepare(`
      UPDATE shared_notes SET payload_json = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(note), now, noteId);
    this.appendRoomEvent(note.roomId, { type: "scratchpad.updated", note });
    return note;
  }

  recordToolCall(input: {
    id: string;
    generationId: string;
    toolName: string;
    arguments: unknown;
  }): void {
    this.database.prepare(`
      INSERT INTO tool_calls(
        id, generation_id, tool_name, arguments_json, status, created_at
      ) VALUES (?, ?, ?, ?, 'running', ?)
    `).run(
      input.id,
      input.generationId,
      input.toolName,
      JSON.stringify(input.arguments),
      new Date().toISOString()
    );
  }

  completeToolCall(input: {
    id: string;
    result?: unknown;
    error?: string;
  }): void {
    this.database.prepare(`
      UPDATE tool_calls
      SET result_json = ?, status = ?, completed_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(input.error ? { error: input.error } : input.result ?? null),
      input.error ? "failed" : "complete",
      new Date().toISOString(),
      input.id
    );
  }

  appendMessage(input: MessageInput): RoomMessage {
    return this.database.transaction(() => {
      this.getRoom(input.roomId);
      const sequence = this.nextSequence(input.roomId);
      const now = new Date().toISOString();
      const raw = {
        id: uuidv7(),
        roomId: input.roomId,
        authorType: input.authorType,
        authorId: input.authorId,
        content: input.content,
        createdAt: now,
        mentionedAgentIds: input.mentionedAgentIds ?? [],
        attachmentIds: input.attachmentIds ?? [],
        citedChunkIds: input.citedChunkIds ?? [],
        status: input.status ?? "complete",
        visibility: "public",
        lifecycle: "active",
        sequence,
        ...(input.generationId === undefined ? {} : { generationId: input.generationId }),
        ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId }),
        ...(input.revisionOfMessageId === undefined
          ? {}
          : { revisionOfMessageId: input.revisionOfMessageId })
      };
      const message = roomMessageSchema.parse(raw);
      this.database.prepare(`
        INSERT INTO messages(
          id, room_id, sequence, author_type, author_id, status, lifecycle,
          generation_id, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        message.id,
        message.roomId,
        message.sequence,
        message.authorType,
        message.authorId,
        message.status,
        message.lifecycle,
        message.generationId ?? null,
        JSON.stringify(message),
        message.createdAt,
        message.createdAt
      );
      this.insertEvent(
        input.roomId,
        sequence,
        "message.created",
        { sequence, type: "message.created", message }
      );
      return message;
    })();
  }

  createGeneration(input: {
    id: string;
    roomId: string;
    messageId: string;
    agent: AgentDefinition;
  }): GenerationRecord {
    const startedAt = new Date().toISOString();
    const generation = generationRecordSchema.parse({
      id: input.id,
      roomId: input.roomId,
      messageId: input.messageId,
      agentId: input.agent.id,
      provider: input.agent.provider,
      requestedModelId: input.agent.modelId,
      status: "streaming",
      finalText: "",
      retrievedChunkIds: [],
      startedAt
    });
    this.database.prepare(`
      INSERT INTO generations(
        id, room_id, message_id, agent_id, status, payload_json, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      generation.id,
      generation.roomId,
      generation.messageId,
      generation.agentId,
      generation.status,
      JSON.stringify(generation),
      generation.startedAt
    );
    this.appendRoomEvent(input.roomId, {
      type: "generation.updated",
      generation
    });
    return generation;
  }

  getGeneration(generationId: string): GenerationRecord {
    const row = this.database.prepare(
      "SELECT payload_json FROM generations WHERE id = ?"
    ).get(generationId) as JsonRow | undefined;
    if (!row) throw new Error(`Generation not found: ${generationId}`);
    return generationRecordSchema.parse(JSON.parse(row.payload_json));
  }

  updateGeneration(
    generationId: string,
    patch: Partial<GenerationRecord>
  ): GenerationRecord {
    const current = this.getGeneration(generationId);
    const generation = generationRecordSchema.parse({ ...current, ...patch });
    this.database.prepare(`
      UPDATE generations
      SET status = ?, payload_json = ?, completed_at = ?
      WHERE id = ?
    `).run(
      generation.status,
      JSON.stringify(generation),
      generation.completedAt ?? null,
      generationId
    );
    this.appendRoomEvent(generation.roomId, {
      type: "generation.updated",
      generation
    });
    return generation;
  }

  appendGenerationEvent(
    generationId: string,
    type: string,
    payload: unknown
  ): void {
    const ordinal = (this.database.prepare(`
      SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal
      FROM generation_events WHERE generation_id = ?
    `).get(generationId) as { ordinal: number }).ordinal;
    this.database.prepare(`
      INSERT INTO generation_events(
        generation_id, ordinal, type, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      generationId,
      ordinal,
      type,
      JSON.stringify(payload),
      new Date().toISOString()
    );
  }

  updateMessage(
    messageId: string,
    patch: Partial<Pick<RoomMessage, "content" | "status" | "lifecycle" | "citedChunkIds">>
  ): RoomMessage {
    return this.database.transaction(() => {
      const current = this.getMessage(messageId);
      const next = roomMessageSchema.parse({ ...current, ...patch });
      this.database.prepare(`
        UPDATE messages
        SET status = ?, lifecycle = ?, payload_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        next.status,
        next.lifecycle,
        JSON.stringify(next),
        new Date().toISOString(),
        messageId
      );
      const sequence = this.nextSequence(current.roomId);
      this.insertEvent(current.roomId, sequence, "message.updated", {
        sequence,
        type: "message.updated",
        message: next
      });
      return next;
    })();
  }

  getMessage(messageId: string): RoomMessage {
    const row = this.database.prepare(
      "SELECT payload_json FROM messages WHERE id = ?"
    ).get(messageId) as JsonRow | undefined;
    if (!row) throw new Error(`Message not found: ${messageId}`);
    return roomMessageSchema.parse(JSON.parse(row.payload_json));
  }

  listMessages(roomId: string): RoomMessage[] {
    return this.database.prepare(`
      SELECT payload_json FROM messages
      WHERE room_id = ?
      ORDER BY sequence
    `).all(roomId).map(row =>
      roomMessageSchema.parse(JSON.parse((row as JsonRow).payload_json))
    );
  }

  getTailMessage(roomId: string): RoomMessage | undefined {
    return this.listMessages(roomId)
      .filter(message => message.lifecycle === "active")
      .at(-1);
  }

  getEvents(roomId: string, afterSequence: number): RoomStreamEvent[] {
    return this.database.prepare(`
      SELECT payload_json FROM room_events
      WHERE room_id = ? AND sequence > ?
      ORDER BY sequence
    `).all(roomId, afterSequence).map(row =>
      JSON.parse((row as JsonRow).payload_json) as RoomStreamEvent
    );
  }

  getSnapshot(roomId: string): RoomSnapshot {
    const roomRow = this.database.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
    if (!roomRow) throw new Error(`Room not found: ${roomId}`);
    const room = this.parseRoom(roomRow as StoredRoomRow);
    return {
      room,
      agents: this.listAgents(roomId),
      messages: this.listMessages(roomId),
      generations: this.listJson<GenerationRecord>(
        "SELECT payload_json FROM generations WHERE room_id = ? ORDER BY started_at",
        roomId,
        value => generationRecordSchema.parse(value)
      ),
      runtime: this.listJson<AgentRuntimeState>(
        "SELECT payload_json FROM agent_runtime_state WHERE room_id = ?",
        roomId,
        value => agentRuntimeStateSchema.parse(value)
      ),
      artifacts: this.listJson<WorkspaceArtifact>(
        "SELECT payload_json FROM artifacts WHERE room_id = ? ORDER BY updated_at DESC",
        roomId,
        value => artifactSchema.parse(value)
      ),
      notes: this.listJson<SharedNote>(
        "SELECT payload_json FROM shared_notes WHERE room_id = ? ORDER BY created_at",
        roomId,
        value => sharedNoteSchema.parse(value)
      ),
      latestSequence: (roomRow as StoredRoomRow).latest_sequence
    };
  }

  appendRoomEvent(
    roomId: string,
    event: RoomStreamEventInput
  ): RoomStreamEvent {
    return this.database.transaction(() => {
      const sequence = this.nextSequence(roomId);
      const complete = { ...event, sequence } as RoomStreamEvent;
      this.insertEvent(roomId, sequence, event.type, complete);
      return complete;
    })();
  }

  private parseRoom(row: StoredRoomRow): Room {
    return roomSchema.parse({
      id: row.id,
      title: row.title,
      status: row.status,
      settings: JSON.parse(row.settings_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  private nextSequence(roomId: string): number {
    const result = this.database.prepare(`
      UPDATE rooms
      SET latest_sequence = latest_sequence + 1, updated_at = ?
      WHERE id = ?
      RETURNING latest_sequence
    `).get(new Date().toISOString(), roomId) as { latest_sequence: number } | undefined;
    if (!result) throw new Error(`Room not found: ${roomId}`);
    return result.latest_sequence;
  }

  private insertEvent(
    roomId: string,
    sequence: number,
    type: string,
    event: RoomStreamEvent
  ): void {
    this.database.prepare(`
      INSERT INTO room_events(room_id, sequence, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(roomId, sequence, type, JSON.stringify(event), new Date().toISOString());
    queueMicrotask(() => {
      for (const listener of this.eventListeners) listener(roomId, event);
    });
  }

  private listJson<T>(
    sql: string,
    parameter: string,
    parse: (value: unknown) => T
  ): T[] {
    return this.database.prepare(sql).all(parameter).map(row =>
      parse(JSON.parse((row as JsonRow).payload_json))
    );
  }
}
