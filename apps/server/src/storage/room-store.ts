import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  agentDefinitionSchema,
  agentRuntimeStateSchema,
  artifactSchema,
  conversationEpisodeSchema,
  createDefaultVoiceConfiguration,
  defaultModelSelectionSchema,
  defaultRoomSettings,
  generationRecordSchema,
  providerConnectionConfigurationSchema,
  psfnDeliveryStateSchema,
  roomMessageSchema,
  roomSchema,
  roomSettingsSchema,
  sharedNoteSchema,
  voiceTemplateInputSchema,
  voiceTemplateLibraryItemSchema,
  voiceTemplateSchema,
  type AgentDefinition,
  type AgentRuntimeState,
  type DefaultModelSelection,
  type ConversationEpisode,
  type GenerationRecord,
  type ProviderConnectionConfiguration,
  type PsfnDeliveryState,
  type Room,
  type RoomMessage,
  type RoomSettings,
  type RoomSnapshot,
  type RoomStreamEvent,
  type RoomStreamEventInput,
  type SharedNote,
  type VoiceTemplate,
  type VoiceTemplateInput,
  type VoiceTemplateLibraryItem,
  type VoiceTemplatePatch,
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

const DEFAULT_MODEL_SETTING_KEY = "default_model" as const;
const PROVIDER_CONNECTIONS_SETTING_KEY = "provider_connections" as const;
const PSFN_TEMPLATE_DESCRIPTION =
  "Stateful PSFN companion with remotely owned persona, memory, prompt, and faculties.";

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
    this.reconcileInterruptedWork();
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

  deleteRoom(roomId: string): Room {
    const room = this.getRoom(roomId);
    this.database.transaction(() => {
      this.database.prepare(`
        DELETE FROM citations
        WHERE generation_id IN (
          SELECT id FROM generations WHERE room_id = ?
        )
      `).run(roomId);
      const result = this.database.prepare(
        "DELETE FROM rooms WHERE id = ?"
      ).run(roomId);
      if (result.changes !== 1) throw new Error(`Room not found: ${roomId}`);
      this.database.prepare(`
        DELETE FROM agents
        WHERE NOT EXISTS (
          SELECT 1 FROM room_agents WHERE room_agents.agent_id = agents.id
        )
      `).run();
    })();
    return room;
  }

  addAgent(roomId: string, definition: AgentDefinition): AgentDefinition {
    this.getRoom(roomId);
    const agent = agentDefinitionSchema.parse(definition);
    const existingAgents = this.listAgents(roomId);
    if (existingAgents.some(existing => existing.id === agent.id)) {
      throw new Error(`Participant is already in this room: ${agent.id}`);
    }
    if (existingAgents.length >= 5) {
      throw new Error("A room supports at most five model participants");
    }
    const existingRow = this.database.prepare(
      "SELECT definition_json FROM agents WHERE id = ?"
    ).get(agent.id) as { definition_json: string } | undefined;
    if (existingRow) {
      const existing = agentDefinitionSchema.parse(JSON.parse(existingRow.definition_json));
      if (JSON.stringify(existing) !== JSON.stringify(agent)) {
        throw new Error(
          `Participant ID is already used by a different voice: ${agent.id}`
        );
      }
    }
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO agents(id, definition_json, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
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

  getRoomAgent(roomId: string, agentId: string): AgentDefinition {
    this.getRoom(roomId);
    const agent = this.listAgents(roomId).find(candidate => candidate.id === agentId);
    if (!agent) throw new Error(`Agent not found in room: ${agentId}`);
    return agent;
  }

  removeAgent(roomId: string, agentId: string): AgentDefinition {
    const agent = this.getRoomAgent(roomId, agentId);
    this.database.transaction(() => {
      this.database.prepare(`
        DELETE FROM agent_runtime_state
        WHERE room_id = ? AND agent_id = ?
      `).run(roomId, agentId);
      const result = this.database.prepare(`
        DELETE FROM room_agents
        WHERE room_id = ? AND agent_id = ?
      `).run(roomId, agentId);
      if (result.changes !== 1) {
        throw new Error(`Agent not found in room: ${agentId}`);
      }
      this.database.prepare(`
        DELETE FROM agents
        WHERE id = ?
          AND NOT EXISTS (
            SELECT 1 FROM room_agents WHERE agent_id = ?
          )
      `).run(agentId, agentId);
    })();
    return agent;
  }

  getDefaultModel(): DefaultModelSelection | undefined {
    const row = this.database.prepare(
      "SELECT payload_json FROM application_settings WHERE key = ?"
    ).get(DEFAULT_MODEL_SETTING_KEY) as JsonRow | undefined;
    return row === undefined
      ? undefined
      : defaultModelSelectionSchema.parse(JSON.parse(row.payload_json));
  }

  setDefaultModel(selection: DefaultModelSelection): DefaultModelSelection {
    const parsed = defaultModelSelectionSchema.parse(selection);
    this.database.prepare(`
      INSERT INTO application_settings(key, payload_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      DEFAULT_MODEL_SETTING_KEY,
      JSON.stringify(parsed),
      new Date().toISOString()
    );
    return parsed;
  }

  listProviderConnectionConfigurations(): ProviderConnectionConfiguration[] {
    const row = this.database.prepare(
      "SELECT payload_json FROM application_settings WHERE key = ?"
    ).get(PROVIDER_CONNECTIONS_SETTING_KEY) as JsonRow | undefined;
    if (row === undefined) return [];
    return providerConnectionConfigurationSchema.array().parse(
      JSON.parse(row.payload_json)
    );
  }

  setProviderConnectionConfiguration(
    configuration: ProviderConnectionConfiguration
  ): ProviderConnectionConfiguration {
    const parsed = providerConnectionConfigurationSchema.parse(configuration);
    const configurations = this.listProviderConnectionConfigurations()
      .filter(candidate => candidate.provider !== parsed.provider);
    configurations.push(parsed);
    this.writeProviderConnectionConfigurations(configurations);
    return parsed;
  }

  getPsfnDeliveryState(
    roomId: string,
    agentId: string
  ): PsfnDeliveryState | undefined {
    const row = this.database.prepare(`
      SELECT payload_json FROM psfn_delivery_state
      WHERE room_id = ? AND agent_id = ?
    `).get(roomId, agentId) as JsonRow | undefined;
    return row === undefined
      ? undefined
      : psfnDeliveryStateSchema.parse(JSON.parse(row.payload_json));
  }

  listPsfnDeliveryStates(roomId: string): PsfnDeliveryState[] {
    this.getRoom(roomId);
    return this.database.prepare(`
      SELECT payload_json FROM psfn_delivery_state
      WHERE room_id = ? ORDER BY agent_id
    `).all(roomId).map(row =>
      psfnDeliveryStateSchema.parse(JSON.parse((row as JsonRow).payload_json))
    );
  }

  beginPsfnDelivery(input: {
    roomId: string;
    agentId: string;
    remoteCompanionId: string;
    sessionMode: "fixed" | "header";
    sessionKey: string;
    deliveryId: string;
    highSequence: number;
    envelopeDigest: string;
    envelope?: string;
    triggerMessageId?: string;
    chunkIds?: string[];
  }): PsfnDeliveryState {
    const current = this.getPsfnDeliveryState(input.roomId, input.agentId);
    if (current?.deliveryStatus === "ambiguous") {
      throw new Error("PSFN delivery is ambiguous and requires human resolution");
    }
    if (current?.deliveryStatus === "inflight") {
      throw new Error("PSFN delivery is already in flight and cannot be overwritten");
    }
    if (input.highSequence < (current?.lastDeliveredSequence ?? 0)) {
      throw new Error("PSFN delivery cursor cannot move backwards");
    }
    const now = new Date().toISOString();
    const state = psfnDeliveryStateSchema.parse({
      roomId: input.roomId,
      agentId: input.agentId,
      remoteCompanionId: input.remoteCompanionId,
      sessionMode: input.sessionMode,
      sessionVersion: current?.sessionVersion ?? 1,
      sessionKey: input.sessionKey,
      lastDeliveredSequence: current?.lastDeliveredSequence ?? 0,
      inflightDeliveryId: input.deliveryId,
      inflightHighSequence: input.highSequence,
      inflightEnvelopeDigest: input.envelopeDigest,
      inflightEnvelope: input.envelope,
      inflightTriggerMessageId: input.triggerMessageId,
      inflightChunkIds: input.chunkIds,
      deliveryStatus: "inflight",
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    });
    this.writePsfnDeliveryState(state);
    return state;
  }

  completePsfnDelivery(
    roomId: string,
    agentId: string,
    deliveryId: string
  ): PsfnDeliveryState {
    const current = this.getPsfnDeliveryState(roomId, agentId);
    if (!current || current.inflightDeliveryId !== deliveryId) {
      throw new Error("PSFN inflight delivery does not match completion");
    }
    const state = psfnDeliveryStateSchema.parse({
      ...current,
      lastDeliveredSequence: Math.max(
        current.lastDeliveredSequence,
        current.inflightHighSequence ?? current.lastDeliveredSequence
      ),
      inflightDeliveryId: undefined,
      inflightHighSequence: undefined,
      inflightEnvelopeDigest: undefined,
      inflightEnvelope: undefined,
      inflightTriggerMessageId: undefined,
      inflightChunkIds: undefined,
      deliveryStatus: "idle",
      updatedAt: new Date().toISOString()
    });
    this.writePsfnDeliveryState(state);
    return state;
  }

  clearPsfnInflight(
    roomId: string,
    agentId: string,
    deliveryId: string
  ): PsfnDeliveryState {
    const current = this.getPsfnDeliveryState(roomId, agentId);
    if (!current || current.inflightDeliveryId !== deliveryId) {
      throw new Error("PSFN inflight delivery does not match failure");
    }
    const state = psfnDeliveryStateSchema.parse({
      ...current,
      inflightDeliveryId: undefined,
      inflightHighSequence: undefined,
      inflightEnvelopeDigest: undefined,
      inflightEnvelope: undefined,
      inflightTriggerMessageId: undefined,
      inflightChunkIds: undefined,
      deliveryStatus: "idle",
      updatedAt: new Date().toISOString()
    });
    this.writePsfnDeliveryState(state);
    return state;
  }

  markPsfnDeliveryAmbiguous(
    roomId: string,
    agentId: string,
    deliveryId: string
  ): PsfnDeliveryState {
    const current = this.getPsfnDeliveryState(roomId, agentId);
    if (!current || current.inflightDeliveryId !== deliveryId) {
      throw new Error("PSFN inflight delivery does not match ambiguity");
    }
    const state = psfnDeliveryStateSchema.parse({
      ...current,
      deliveryStatus: "ambiguous",
      updatedAt: new Date().toISOString()
    });
    this.writePsfnDeliveryState(state);
    return state;
  }

  restartAmbiguousPsfnDelivery(
    roomId: string,
    agentId: string
  ): PsfnDeliveryState {
    const current = this.getPsfnDeliveryState(roomId, agentId);
    if (
      !current ||
      current.deliveryStatus !== "ambiguous" ||
      !current.inflightDeliveryId ||
      !current.inflightEnvelope ||
      !current.inflightEnvelopeDigest
    ) {
      throw new Error("No complete ambiguous PSFN delivery can be retried");
    }
    const state = psfnDeliveryStateSchema.parse({
      ...current,
      deliveryStatus: "inflight",
      updatedAt: new Date().toISOString()
    });
    this.writePsfnDeliveryState(state);
    return state;
  }

  beginPsfnResynchronization(input: {
    roomId: string;
    agentId: string;
    remoteCompanionId: string;
    sessionMode: "fixed" | "header";
    sessionKey: string;
    deliveryId: string;
    highSequence: number;
    envelopeDigest: string;
    envelope: string;
    triggerMessageId: string;
    chunkIds: string[];
  }): PsfnDeliveryState {
    const current = this.getPsfnDeliveryState(input.roomId, input.agentId);
    if (
      !current ||
      current.deliveryStatus !== "ambiguous" ||
      !current.inflightDeliveryId
    ) {
      throw new Error("No ambiguous PSFN delivery can be resynchronized");
    }
    const assumedDeliveredSequence = Math.max(
      current.lastDeliveredSequence,
      current.inflightHighSequence ?? current.lastDeliveredSequence
    );
    if (input.highSequence < assumedDeliveredSequence) {
      throw new Error("PSFN resynchronization cursor cannot move backwards");
    }
    const state = psfnDeliveryStateSchema.parse({
      ...current,
      remoteCompanionId: input.remoteCompanionId,
      sessionMode: input.sessionMode,
      sessionKey: input.sessionKey,
      lastDeliveredSequence: assumedDeliveredSequence,
      inflightDeliveryId: input.deliveryId,
      inflightHighSequence: input.highSequence,
      inflightEnvelopeDigest: input.envelopeDigest,
      inflightEnvelope: input.envelope,
      inflightTriggerMessageId: input.triggerMessageId,
      inflightChunkIds: input.chunkIds,
      deliveryStatus: "inflight",
      updatedAt: new Date().toISOString()
    });
    this.writePsfnDeliveryState(state);
    return state;
  }

  restorePsfnAmbiguity(
    previous: PsfnDeliveryState,
    replacementDeliveryId: string
  ): PsfnDeliveryState {
    const current = this.getPsfnDeliveryState(previous.roomId, previous.agentId);
    if (
      previous.deliveryStatus !== "ambiguous" ||
      !previous.inflightDeliveryId ||
      current?.deliveryStatus !== "inflight" ||
      current.inflightDeliveryId !== replacementDeliveryId
    ) {
      throw new Error("PSFN resynchronization state cannot restore the prior ambiguity");
    }
    const restored = psfnDeliveryStateSchema.parse({
      ...previous,
      updatedAt: new Date().toISOString()
    });
    this.writePsfnDeliveryState(restored);
    return restored;
  }

  resolvePsfnDelivery(
    roomId: string,
    agentId: string,
    _resolution: "assume-delivered"
  ): PsfnDeliveryState {
    const current = this.getPsfnDeliveryState(roomId, agentId);
    if (!current || current.deliveryStatus !== "ambiguous" ||
      !current.inflightDeliveryId) {
      throw new Error("No ambiguous PSFN delivery requires resolution");
    }
    return this.completePsfnDelivery(roomId, agentId, current.inflightDeliveryId);
  }

  private writePsfnDeliveryState(state: PsfnDeliveryState): void {
    const parsed = psfnDeliveryStateSchema.parse(state);
    this.database.prepare(`
      INSERT INTO psfn_delivery_state(
        room_id, agent_id, remote_companion_id, session_mode, session_key,
        last_delivered_sequence, inflight_delivery_id, inflight_high_sequence,
        inflight_envelope_digest, delivery_status, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id, agent_id) DO UPDATE SET
        remote_companion_id = excluded.remote_companion_id,
        session_mode = excluded.session_mode,
        session_key = excluded.session_key,
        last_delivered_sequence = excluded.last_delivered_sequence,
        inflight_delivery_id = excluded.inflight_delivery_id,
        inflight_high_sequence = excluded.inflight_high_sequence,
        inflight_envelope_digest = excluded.inflight_envelope_digest,
        delivery_status = excluded.delivery_status,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      parsed.roomId,
      parsed.agentId,
      parsed.remoteCompanionId,
      parsed.sessionMode,
      parsed.sessionKey,
      parsed.lastDeliveredSequence,
      parsed.inflightDeliveryId ?? null,
      parsed.inflightHighSequence ?? null,
      parsed.inflightEnvelopeDigest ?? null,
      parsed.deliveryStatus,
      JSON.stringify(parsed),
      parsed.createdAt,
      parsed.updatedAt
    );
  }

  private rotatePsfnHeaderSessionsForChatReset(roomId: string): void {
    const latestSequence = (this.database.prepare(
      "SELECT latest_sequence FROM rooms WHERE id = ?"
    ).get(roomId) as { latest_sequence: number }).latest_sequence;
    for (const current of this.listPsfnDeliveryStates(roomId)) {
      if (current.sessionMode !== "header" || current.deliveryStatus !== "idle") continue;
      const sessionVersion = current.sessionVersion + 1;
      const readable = `writers-room:${roomId}:${current.agentId}:v${sessionVersion}`;
      const sessionKey = readable.length <= 128
        ? readable
        : `writers-room:${createHash("sha256").update(readable).digest("hex")}:v${sessionVersion}`;
      this.writePsfnDeliveryState(psfnDeliveryStateSchema.parse({
        ...current,
        sessionVersion,
        sessionKey,
        lastDeliveredSequence: Math.max(current.lastDeliveredSequence, latestSequence),
        updatedAt: new Date().toISOString()
      }));
    }
  }

  deleteProviderConnectionConfiguration(
    provider: ProviderConnectionConfiguration["provider"]
  ): boolean {
    const current = this.listProviderConnectionConfigurations();
    const next = current.filter(candidate => candidate.provider !== provider);
    if (next.length === current.length) return false;
    this.writeProviderConnectionConfigurations(next);
    return true;
  }

  acceptPsfnProviderIdentityChange(
    configuration: ProviderConnectionConfiguration,
    previousCompanionId: string,
    replacementModelId: string,
    replacementCompanionName: string
  ): void {
    if (
      configuration.provider !== "psfn" ||
      !configuration.expectedCompanionId ||
      configuration.expectedCompanionId === previousCompanionId
    ) {
      throw new Error("PSFN identity acceptance requires a different pinned identity");
    }
    const matching = this.database.prepare(`
      SELECT payload_json FROM psfn_delivery_state
      WHERE remote_companion_id = ?
    `).all(previousCompanionId).map(row =>
      psfnDeliveryStateSchema.parse(JSON.parse((row as JsonRow).payload_json))
    );
    if (matching.some(state => state.deliveryStatus !== "idle")) {
      throw Object.assign(new Error(
        "Resolve every active or ambiguous delivery for the previous PSFN identity before accepting a replacement"
      ), { status: 409 });
    }
    const now = new Date().toISOString();
    const localCompanionName = replacementCompanionName.trim().slice(0, 80) ||
      "PSFN Companion";
    const psfnAgents = (this.database.prepare(`
      SELECT id, definition_json FROM agents
      WHERE json_extract(definition_json, '$.provider') = 'psfn'
    `).all() as Array<{ id: string; definition_json: string }>).map(row => ({
      id: row.id,
      definition: agentDefinitionSchema.parse(JSON.parse(row.definition_json))
    }));
    const psfnTemplates = this.listVoiceTemplates().filter(template =>
      template.provider === "psfn"
    );
    const managedTemplateIds = new Set(psfnTemplates.filter(template =>
      template.title === `PSFN — ${template.name}` &&
      template.description === PSFN_TEMPLATE_DESCRIPTION &&
      template.systemPrompt === "" &&
      (template.personaPrompt ?? "") === ""
    ).map(template => template.id));
    const affectedRoomIds = new Set<string>();
    for (const agent of psfnAgents) {
      const memberships = this.database.prepare(`
        SELECT room_id FROM room_agents WHERE agent_id = ?
      `).all(agent.id) as Array<{ room_id: string }>;
      for (const membership of memberships) affectedRoomIds.add(membership.room_id);
    }
    this.database.transaction(() => {
      this.database.prepare(`
        DELETE FROM psfn_delivery_state WHERE remote_companion_id = ?
      `).run(previousCompanionId);
      const updateAgent = this.database.prepare(`
        UPDATE agents SET definition_json = ?, updated_at = ? WHERE id = ?
      `);
      for (const agent of psfnAgents) {
        const { capabilities: _capabilities, ...withoutCapabilities } = agent.definition;
        const updated = agentDefinitionSchema.parse({
          ...withoutCapabilities,
          modelId: replacementModelId,
          ...(agent.definition.voiceTemplateId &&
            managedTemplateIds.has(agent.definition.voiceTemplateId)
            ? {
                name: localCompanionName,
                description: PSFN_TEMPLATE_DESCRIPTION
              }
            : {})
        });
        updateAgent.run(JSON.stringify(updated), now, agent.id);
      }
      const updateTemplate = this.database.prepare(`
        UPDATE voice_templates SET payload_json = ?, updated_at = ? WHERE id = ?
      `);
      for (const template of psfnTemplates) {
        const managed = managedTemplateIds.has(template.id);
        const updated = voiceTemplateSchema.parse({
          ...template,
          modelId: replacementModelId,
          ...(managed
            ? {
                title: `PSFN — ${localCompanionName}`,
                name: localCompanionName,
                description: PSFN_TEMPLATE_DESCRIPTION
              }
            : {}),
          updatedAt: now
        });
        updateTemplate.run(JSON.stringify(updated), now, template.id);
      }
      this.setProviderConnectionConfiguration(configuration);
    })();
    for (const roomId of affectedRoomIds) {
      this.appendRoomEvent(roomId, {
        type: "room.snapshot",
        room: this.getRoom(roomId)
      });
    }
  }

  private writeProviderConnectionConfigurations(
    configurations: ProviderConnectionConfiguration[]
  ): void {
    const parsed = providerConnectionConfigurationSchema.array().parse(configurations);
    this.database.prepare(`
      INSERT INTO application_settings(key, payload_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      PROVIDER_CONNECTIONS_SETTING_KEY,
      JSON.stringify(parsed),
      new Date().toISOString()
    );
  }

  createVoiceTemplate(input: VoiceTemplateInput): VoiceTemplate {
    const now = new Date().toISOString();
    const template = voiceTemplateSchema.parse({
      ...voiceTemplateInputSchema.parse(input),
      id: uuidv7(),
      createdAt: now,
      updatedAt: now
    });
    this.database.prepare(`
      INSERT INTO voice_templates(id, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(template.id, JSON.stringify(template), now, now);
    return template;
  }

  ensurePsfnVoiceTemplate(input: {
    companionName: string;
    modelId: string;
  }): VoiceTemplate {
    const localCompanionName = input.companionName.trim().slice(0, 80) ||
      "PSFN Companion";
    const existing = this.listVoiceTemplates().find(template =>
      template.provider === "psfn" && template.modelId === input.modelId
    );
    if (existing) return existing;
    return this.createVoiceTemplate({
      ...createDefaultVoiceConfiguration(),
      title: `PSFN — ${localCompanionName}`,
      name: localCompanionName,
      description: PSFN_TEMPLATE_DESCRIPTION,
      provider: "psfn",
      modelId: input.modelId,
      systemPrompt: "",
      personaPrompt: "",
      reasoning: { enabled: false, displayMode: "hidden" },
      tools: []
    });
  }

  listVoiceTemplates(): VoiceTemplate[] {
    return this.database.prepare(`
      SELECT payload_json FROM voice_templates ORDER BY updated_at DESC
    `).all().map(row =>
      voiceTemplateSchema.parse(JSON.parse((row as JsonRow).payload_json))
    );
  }

  listVoiceTemplateLibraryItems(
    templateId: string
  ): VoiceTemplateLibraryItem[] {
    this.getVoiceTemplate(templateId);
    return this.database.prepare(`
      SELECT payload_json FROM voice_template_library_items
      WHERE voice_template_id = ? ORDER BY updated_at DESC
    `).all(templateId).map(row =>
      voiceTemplateLibraryItemSchema.parse(
        JSON.parse((row as JsonRow).payload_json)
      )
    );
  }

  getVoiceTemplateLibraryItem(itemId: string): VoiceTemplateLibraryItem {
    const row = this.database.prepare(`
      SELECT payload_json FROM voice_template_library_items WHERE id = ?
    `).get(itemId) as JsonRow | undefined;
    if (!row) throw new Error(`Voice reference not found: ${itemId}`);
    return voiceTemplateLibraryItemSchema.parse(JSON.parse(row.payload_json));
  }

  createVoiceTemplateLibraryItem(input: Omit<
    VoiceTemplateLibraryItem,
    "id" | "createdAt" | "updatedAt"
  >): VoiceTemplateLibraryItem {
    this.getVoiceTemplate(input.voiceTemplateId);
    const existing = this.database.prepare(`
      SELECT payload_json FROM voice_template_library_items
      WHERE voice_template_id = ? AND sha256 = ?
    `).get(input.voiceTemplateId, input.sha256) as JsonRow | undefined;
    if (existing) {
      return voiceTemplateLibraryItemSchema.parse(JSON.parse(existing.payload_json));
    }
    const now = new Date().toISOString();
    const item = voiceTemplateLibraryItemSchema.parse({
      ...input,
      id: uuidv7(),
      createdAt: now,
      updatedAt: now
    });
    this.database.prepare(`
      INSERT INTO voice_template_library_items(
        id, voice_template_id, sha256, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      item.id,
      item.voiceTemplateId,
      item.sha256,
      JSON.stringify(item),
      item.createdAt,
      item.updatedAt
    );
    return item;
  }

  deleteVoiceTemplateLibraryItem(
    templateId: string,
    itemId: string
  ): VoiceTemplateLibraryItem {
    const item = this.getVoiceTemplateLibraryItem(itemId);
    if (item.voiceTemplateId !== templateId) {
      throw new Error("Voice reference does not belong to this template");
    }
    this.database.prepare(
      "DELETE FROM voice_template_library_items WHERE id = ?"
    ).run(itemId);
    return item;
  }

  isVoiceTemplateLibraryHashReferenced(sha256: string): boolean {
    return this.database.prepare(
      "SELECT 1 FROM voice_template_library_items WHERE sha256 = ? LIMIT 1"
    ).get(sha256) !== undefined;
  }

  listVoiceTemplateMemberships(templateId: string): Array<{
    roomId: string;
    agentId: string;
  }> {
    return (this.database.prepare(`
      SELECT ra.room_id, ra.agent_id
      FROM room_agents ra
      JOIN agents a ON a.id = ra.agent_id
      WHERE json_extract(a.definition_json, '$.voiceTemplateId') = ?
      ORDER BY ra.room_id, ra.position
    `).all(templateId) as Array<{ room_id: string; agent_id: string }>).map(row => ({
      roomId: row.room_id,
      agentId: row.agent_id
    }));
  }

  getVoiceTemplate(templateId: string): VoiceTemplate {
    const row = this.database.prepare(
      "SELECT payload_json FROM voice_templates WHERE id = ?"
    ).get(templateId) as JsonRow | undefined;
    if (!row) throw new Error(`Voice template not found: ${templateId}`);
    return voiceTemplateSchema.parse(JSON.parse(row.payload_json));
  }

  updateVoiceTemplate(
    templateId: string,
    patch: VoiceTemplatePatch,
    capabilities?: AgentDefinition["capabilities"]
  ): VoiceTemplate {
    const current = this.getVoiceTemplate(templateId);
    const updatedAt = new Date().toISOString();
    const template = voiceTemplateSchema.parse({
      ...current,
      ...voiceTemplateInputSchema.parse({
        ...current,
        ...patch
      }),
      updatedAt
    });
    const affectedRoomIds = new Set<string>();
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE voice_templates
        SET payload_json = ?, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(template), updatedAt, templateId);

      const candidates = this.database.prepare(`
        SELECT id, definition_json FROM agents
      `).all() as Array<{ id: string; definition_json: string }>;
      for (const candidate of candidates) {
        const agent = agentDefinitionSchema.parse(JSON.parse(candidate.definition_json));
        const linked = agent.voiceTemplateId === templateId;
        if (!linked) continue;
        const updatedAgent = this.applyVoiceTemplate(agent, template, capabilities);
        this.database.prepare(`
          UPDATE agents SET definition_json = ?, updated_at = ? WHERE id = ?
        `).run(JSON.stringify(updatedAgent), updatedAt, agent.id);
        const memberships = this.database.prepare(`
          SELECT room_id FROM room_agents WHERE agent_id = ?
        `).all(agent.id) as Array<{ room_id: string }>;
        for (const membership of memberships) affectedRoomIds.add(membership.room_id);
      }
    })();
    for (const roomId of affectedRoomIds) {
      const room = this.getRoom(roomId);
      this.appendRoomEvent(roomId, { type: "room.snapshot", room });
    }
    return template;
  }

  private applyVoiceTemplate(
    agent: AgentDefinition,
    template: VoiceTemplate,
    capabilities?: AgentDefinition["capabilities"]
  ): AgentDefinition {
    const modelChanged = agent.provider !== template.provider ||
      agent.modelId !== template.modelId;
    const { capabilities: _oldCapabilities, ...agentWithoutCapabilities } = agent;
    return agentDefinitionSchema.parse({
      ...(modelChanged && capabilities === undefined
        ? agentWithoutCapabilities
        : agent),
      voiceTemplateId: template.id,
      name: template.name,
      description: template.description,
      provider: template.provider,
      modelId: template.modelId,
      systemPrompt: template.systemPrompt,
      personaPrompt: template.personaPrompt,
      temperature: template.temperature,
      topP: template.topP,
      maxOutputTokens: template.maxOutputTokens,
      reasoning: template.reasoning,
      tools: template.tools,
      contextBudget: template.contextBudget,
      ...(capabilities === undefined ? {} : { capabilities })
    });
  }

  deleteVoiceTemplate(templateId: string): VoiceTemplate {
    const template = this.getVoiceTemplate(templateId);
    const affectedRoomIds = new Set<string>();
    this.database.transaction(() => {
      const linked = this.database.prepare(`
        SELECT id, definition_json FROM agents
        WHERE json_extract(definition_json, '$.voiceTemplateId') = ?
      `).all(templateId) as Array<{ id: string; definition_json: string }>;
      const update = this.database.prepare(`
        UPDATE agents SET definition_json = ?, updated_at = ? WHERE id = ?
      `);
      const now = new Date().toISOString();
      for (const row of linked) {
        const current = agentDefinitionSchema.parse(JSON.parse(row.definition_json));
        const { voiceTemplateId: _voiceTemplateId, ...detached } = current;
        update.run(JSON.stringify(detached), now, row.id);
        const memberships = this.database.prepare(`
          SELECT room_id FROM room_agents WHERE agent_id = ?
        `).all(row.id) as Array<{ room_id: string }>;
        for (const membership of memberships) affectedRoomIds.add(membership.room_id);
      }
      this.database.prepare(
        "DELETE FROM voice_templates WHERE id = ?"
      ).run(templateId);
    })();
    for (const roomId of affectedRoomIds) {
      this.appendRoomEvent(roomId, {
        type: "room.snapshot",
        room: this.getRoom(roomId)
      });
    }
    return template;
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
    patch: { text?: string; category?: string; archive?: boolean },
    roomId?: string
  ): SharedNote {
    const row = this.database.prepare(
      "SELECT payload_json FROM shared_notes WHERE id = ?"
    ).get(noteId) as JsonRow | undefined;
    if (!row) throw new Error(`Shared note not found: ${noteId}`);
    const current = sharedNoteSchema.parse(JSON.parse(row.payload_json));
    if (roomId !== undefined && current.roomId !== roomId) {
      throw new Error("Shared note does not belong to this room");
    }
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

  recordCitations(input: {
    generationId: string;
    messageId: string;
    chunkIds: string[];
  }): string[] {
    if (input.chunkIds.length === 0) return [];
    const generation = this.getGeneration(input.generationId);
    const message = this.getMessage(input.messageId);
    if (
      generation.messageId !== message.id ||
      generation.roomId !== message.roomId
    ) {
      throw new Error("Citation generation/message binding is invalid");
    }
    const insert = this.database.prepare(`
      INSERT INTO citations(id, generation_id, message_id, chunk_id, created_at)
      SELECT ?, ?, ?, c.id, ?
      FROM artifact_chunks c
      JOIN artifacts a ON a.id = c.artifact_id
      WHERE c.id = ? AND a.room_id = ?
      ON CONFLICT(generation_id, chunk_id) DO NOTHING
    `);
    return this.database.transaction(() => {
      const recordedChunkIds: string[] = [];
      for (const chunkId of new Set(input.chunkIds)) {
        const result = insert.run(
          uuidv7(),
          input.generationId,
          input.messageId,
          new Date().toISOString(),
          chunkId,
          generation.roomId
        );
        if (result.changes !== 1) {
          const stillExists = this.database.prepare(
            "SELECT 1 FROM artifact_chunks WHERE id = ?"
          ).get(chunkId) !== undefined;
          if (!stillExists) continue;
          throw new Error(`Cited chunk does not belong to the generation room: ${chunkId}`);
        }
        recordedChunkIds.push(chunkId);
      }
      return recordedChunkIds;
    })();
  }

  getGenerationInspection(generationId: string): {
    events: Array<{
      ordinal: number;
      type: string;
      payload: unknown;
      createdAt: string;
    }>;
    toolCalls: Array<{
      id: string;
      toolName: string;
      arguments: unknown;
      result: unknown;
      status: string;
      createdAt: string;
      completedAt?: string;
    }>;
    citations: Array<{
      chunkId: string;
      artifactId: string;
      filename: string;
      text: string;
      headingPath?: string;
      pageNumber?: number;
      lineStart?: number;
      lineEnd?: number;
    }>;
  } {
    this.getGeneration(generationId);
    const events = this.database.prepare(`
      SELECT ordinal, type, payload_json, created_at
      FROM generation_events
      WHERE generation_id = ?
      ORDER BY ordinal
    `).all(generationId).map(row => {
      const value = row as {
        ordinal: number;
        type: string;
        payload_json: string;
        created_at: string;
      };
      return {
        ordinal: value.ordinal,
        type: value.type,
        payload: JSON.parse(value.payload_json) as unknown,
        createdAt: value.created_at
      };
    });
    const toolCalls = this.database.prepare(`
      SELECT id, tool_name, arguments_json, result_json, status, created_at, completed_at
      FROM tool_calls
      WHERE generation_id = ?
      ORDER BY created_at
    `).all(generationId).map(row => {
      const value = row as {
        id: string;
        tool_name: string;
        arguments_json: string;
        result_json: string | null;
        status: string;
        created_at: string;
        completed_at: string | null;
      };
      return {
        id: value.id,
        toolName: value.tool_name,
        arguments: JSON.parse(value.arguments_json) as unknown,
        result: value.result_json ? JSON.parse(value.result_json) as unknown : null,
        status: value.status,
        createdAt: value.created_at,
        ...(value.completed_at ? { completedAt: value.completed_at } : {})
      };
    });
    const citations = this.database.prepare(`
      SELECT c.chunk_id, a.id AS artifact_id, a.payload_json AS artifact_json,
             ac.payload_json AS chunk_json
      FROM citations c
      JOIN artifact_chunks ac ON ac.id = c.chunk_id
      JOIN artifacts a ON a.id = ac.artifact_id
      WHERE c.generation_id = ?
      ORDER BY c.created_at
    `).all(generationId).map(row => {
      const value = row as {
        chunk_id: string;
        artifact_id: string;
        artifact_json: string;
        chunk_json: string;
      };
      const artifact = artifactSchema.parse(JSON.parse(value.artifact_json));
      const chunk = JSON.parse(value.chunk_json) as {
        text: string;
        headingPath?: string;
        pageNumber?: number;
        lineStart?: number;
        lineEnd?: number;
      };
      return {
        chunkId: value.chunk_id,
        artifactId: value.artifact_id,
        filename: artifact.filename,
        text: chunk.text,
        ...(chunk.headingPath === undefined ? {} : { headingPath: chunk.headingPath }),
        ...(chunk.pageNumber === undefined ? {} : { pageNumber: chunk.pageNumber }),
        ...(chunk.lineStart === undefined ? {} : { lineStart: chunk.lineStart }),
        ...(chunk.lineEnd === undefined ? {} : { lineEnd: chunk.lineEnd })
      };
    });
    return { events, toolCalls, citations };
  }

  appendMessage(input: MessageInput): RoomMessage {
    return this.database.transaction(() => {
      this.getRoom(input.roomId);
      if (input.replyToMessageId !== undefined) {
        const replyTarget = this.getMessage(input.replyToMessageId);
        if (replyTarget.roomId !== input.roomId) {
          throw new Error("Reply target does not belong to this room");
        }
      }
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
      reasoningConfig: input.agent.reasoning,
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

  searchMessages(roomId: string, query: string, limit: number): RoomMessage[] {
    this.getRoom(roomId);
    const terms = [...new Set(
      query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []
    )].slice(0, 24);
    if (terms.length === 0) return [];
    const ftsQuery = terms.map(term => `"${term.replaceAll('"', '""')}"`)
      .join(" OR ");
    return this.database.prepare(`
      SELECT m.payload_json
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.message_id
      WHERE messages_fts MATCH ? AND messages_fts.room_id = ?
      ORDER BY bm25(messages_fts), m.sequence DESC
      LIMIT ?
    `).all(ftsQuery, roomId, Math.max(1, Math.min(100, limit))).map(row =>
      roomMessageSchema.parse(JSON.parse((row as JsonRow).payload_json))
    );
  }

  getTailMessage(roomId: string): RoomMessage | undefined {
    return this.listMessages(roomId)
      .filter(message => message.lifecycle === "active")
      .at(-1);
  }

  resetChat(roomId: string): Room {
    const room = this.getRoom(roomId);
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.rotatePsfnHeaderSessionsForChatReset(roomId);
      this.database.prepare(
        "DELETE FROM scheduler_waves WHERE room_id = ?"
      ).run(roomId);
      this.database.prepare(
        "DELETE FROM conversation_episodes WHERE room_id = ?"
      ).run(roomId);
      // Deleting messages cascades through generations, generation events,
      // citations, and tool calls while leaving workspace artifacts untouched.
      this.database.prepare(
        "DELETE FROM messages WHERE room_id = ?"
      ).run(roomId);
      this.database.prepare(
        "DELETE FROM room_events WHERE room_id = ?"
      ).run(roomId);
      const runtimes = this.database.prepare(`
        SELECT agent_id, payload_json FROM agent_runtime_state WHERE room_id = ?
      `).all(roomId) as Array<{ agent_id: string; payload_json: string }>;
      const updateRuntime = this.database.prepare(`
        UPDATE agent_runtime_state
        SET payload_json = ?, updated_at = ?
        WHERE room_id = ? AND agent_id = ?
      `);
      for (const row of runtimes) {
        const current = agentRuntimeStateSchema.parse(JSON.parse(row.payload_json));
        const reset = agentRuntimeStateSchema.parse({
          roomId,
          agentId: row.agent_id,
          fatigue: 0,
          activation: 0,
          consecutiveTurns: 0,
          muted: current.muted
        });
        updateRuntime.run(JSON.stringify(reset), now, roomId, row.agent_id);
      }
    })();
    this.appendRoomEvent(roomId, { type: "room.snapshot", room });
    return room;
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

  listConversationEpisodes(roomId: string): ConversationEpisode[] {
    return this.listJson<ConversationEpisode>(
      `SELECT payload_json FROM conversation_episodes
       WHERE room_id = ? ORDER BY first_sequence`,
      roomId,
      value => conversationEpisodeSchema.parse(value)
    );
  }

  createConversationEpisode(input: Omit<
    ConversationEpisode,
    "id" | "createdAt"
  >): ConversationEpisode {
    this.getRoom(input.roomId);
    const episode = conversationEpisodeSchema.parse({
      ...input,
      id: uuidv7(),
      createdAt: new Date().toISOString()
    });
    this.database.prepare(`
      INSERT INTO conversation_episodes(
        id, room_id, first_sequence, last_sequence, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      episode.id,
      episode.roomId,
      episode.firstSequence,
      episode.lastSequence,
      JSON.stringify(episode),
      episode.createdAt
    );
    return episode;
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
      psfnDeliveries: this.listPsfnDeliveryStates(roomId),
      episodes: this.listConversationEpisodes(roomId),
      activations: this.database.prepare(`
        SELECT sequence, payload_json
        FROM room_events
        WHERE room_id = ? AND type = 'activation.recorded'
        ORDER BY sequence DESC
        LIMIT 100
      `).all(roomId).map(row => {
        const value = row as { sequence: number; payload_json: string };
        const event = JSON.parse(value.payload_json) as Extract<
          RoomStreamEvent,
          { type: "activation.recorded" }
        >;
        return {
          sequence: value.sequence,
          agentId: event.agentId,
          decision: event.decision,
          score: event.score,
          source: event.source ?? "participant"
        };
      }),
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
      for (const listener of this.eventListeners) {
        try {
          listener(roomId, event);
        } catch (error) {
          console.error("Room event listener failed", error);
        }
      }
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

  private reconcileInterruptedWork(): void {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      const generations = this.database.prepare(`
        SELECT id, payload_json FROM generations
        WHERE status IN ('queued', 'streaming')
      `).all() as Array<{ id: string; payload_json: string }>;
      for (const row of generations) {
        const generation = generationRecordSchema.parse(JSON.parse(row.payload_json));
        const interrupted = generationRecordSchema.parse({
          ...generation,
          status: "interrupted",
          completedAt: now,
          error: "Generation interrupted by process restart"
        });
        this.database.prepare(`
          UPDATE generations
          SET status = 'interrupted', payload_json = ?, completed_at = ?
          WHERE id = ?
        `).run(JSON.stringify(interrupted), now, row.id);
      }

      const messages = this.database.prepare(`
        SELECT id, payload_json FROM messages WHERE status = 'streaming'
      `).all() as Array<{ id: string; payload_json: string }>;
      for (const row of messages) {
        const message = roomMessageSchema.parse(JSON.parse(row.payload_json));
        const interrupted = roomMessageSchema.parse({
          ...message,
          status: "interrupted"
        });
        this.database.prepare(`
          UPDATE messages SET status = 'interrupted', payload_json = ?, updated_at = ?
          WHERE id = ?
        `).run(JSON.stringify(interrupted), now, row.id);
      }

      const psfnDeliveries = this.database.prepare(`
        SELECT payload_json FROM psfn_delivery_state
        WHERE delivery_status = 'inflight'
      `).all() as JsonRow[];
      for (const row of psfnDeliveries) {
        const current = psfnDeliveryStateSchema.parse(JSON.parse(row.payload_json));
        this.writePsfnDeliveryState(psfnDeliveryStateSchema.parse({
          ...current,
          deliveryStatus: "ambiguous",
          updatedAt: now
        }));
      }

      const artifacts = this.database.prepare(`
        SELECT id, payload_json FROM artifacts
        WHERE json_extract(payload_json, '$.ingestionStatus') IN ('queued', 'processing')
      `).all() as Array<{ id: string; payload_json: string }>;
      for (const row of artifacts) {
        const artifact = artifactSchema.parse(JSON.parse(row.payload_json));
        const failed = artifactSchema.parse({
          ...artifact,
          ingestionStatus: "failed",
          ingestionStage: "interrupted",
          error: "Ingestion interrupted by process restart; upload the artifact again.",
          updatedAt: now
        });
        this.database.prepare(`
          UPDATE artifacts SET payload_json = ?, updated_at = ? WHERE id = ?
        `).run(JSON.stringify(failed), now, row.id);
      }
    })();
  }
}
