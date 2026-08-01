import type Database from "better-sqlite3";

const migrations: ReadonlyArray<(database: Database.Database) => void> = [
  database => {
    database.exec(`
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'paused')),
        settings_json TEXT NOT NULL,
        latest_sequence INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        definition_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE room_agents (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY (room_id, agent_id),
        UNIQUE (room_id, position)
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        author_type TEXT NOT NULL,
        author_id TEXT NOT NULL,
        status TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        generation_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (room_id, sequence)
      );
      CREATE INDEX messages_room_sequence ON messages(room_id, sequence);

      CREATE TABLE generations (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX generations_room_started ON generations(room_id, started_at);

      CREATE TABLE generation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (generation_id, ordinal)
      );

      CREATE TABLE agent_runtime_state (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (room_id, agent_id)
      );

      CREATE TABLE room_events (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (room_id, sequence)
      );

      CREATE TABLE scheduler_waves (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        triggering_message_id TEXT,
        status TEXT NOT NULL,
        selected_agent_ids_json TEXT NOT NULL,
        autonomous INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (room_id, sha256)
      );
      CREATE INDEX artifacts_room_updated ON artifacts(room_id, updated_at);

      CREATE TABLE artifact_chunks (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        text TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        embedding BLOB,
        UNIQUE (artifact_id, ordinal)
      );

      CREATE VIRTUAL TABLE artifact_chunks_fts USING fts5(
        text,
        content='artifact_chunks',
        content_rowid='rowid',
        tokenize='unicode61'
      );

      CREATE TRIGGER artifact_chunks_ai AFTER INSERT ON artifact_chunks BEGIN
        INSERT INTO artifact_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER artifact_chunks_ad AFTER DELETE ON artifact_chunks BEGIN
        INSERT INTO artifact_chunks_fts(artifact_chunks_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
      END;
      CREATE TRIGGER artifact_chunks_au AFTER UPDATE OF text ON artifact_chunks BEGIN
        INSERT INTO artifact_chunks_fts(artifact_chunks_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
        INSERT INTO artifact_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
      END;

      CREATE TABLE shared_notes (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE citations (
        id TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        chunk_id TEXT NOT NULL REFERENCES artifact_chunks(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        UNIQUE (generation_id, chunk_id)
      );

      CREATE TABLE tool_calls (
        id TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        result_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE ingestion_jobs (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
  database => {
    database.exec(`
      CREATE TABLE voice_templates (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX voice_templates_updated ON voice_templates(updated_at DESC);
    `);
  },
  database => {
    database.exec(`
      CREATE TABLE application_settings (
        key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
  database => {
    // Artifact identity is no longer the same thing as blob identity. Two
    // persona libraries may independently own the same bytes while the blob
    // store still deduplicates those bytes by SHA-256.
    database.exec(`
      CREATE TABLE artifacts_without_blob_identity (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO artifacts_without_blob_identity(
        id, room_id, sha256, payload_json, created_at, updated_at
      )
      SELECT id, room_id, sha256, payload_json, created_at, updated_at
      FROM artifacts;
      DROP TABLE artifacts;
      ALTER TABLE artifacts_without_blob_identity RENAME TO artifacts;
      CREATE INDEX artifacts_room_updated ON artifacts(room_id, updated_at);
      CREATE INDEX artifacts_room_sha ON artifacts(room_id, sha256);
    `);
  },
  database => {
    database.exec(`
      CREATE TABLE conversation_episodes (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        first_sequence INTEGER NOT NULL,
        last_sequence INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(room_id, first_sequence, last_sequence)
      );
      CREATE INDEX conversation_episodes_room_sequence
      ON conversation_episodes(room_id, last_sequence);
    `);
  },
  database => {
    database.exec(`
      CREATE TABLE voice_template_library_items (
        id TEXT PRIMARY KEY,
        voice_template_id TEXT NOT NULL REFERENCES voice_templates(id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(voice_template_id, sha256)
      );
      CREATE INDEX voice_template_library_template
      ON voice_template_library_items(voice_template_id, updated_at DESC);
      CREATE INDEX voice_template_library_sha
      ON voice_template_library_items(sha256);
    `);
  },
  database => {
    database.exec(`
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        message_id UNINDEXED,
        room_id UNINDEXED,
        text,
        tokenize='unicode61'
      );
      INSERT INTO messages_fts(message_id, room_id, text)
      SELECT id, room_id, json_extract(payload_json, '$.content') FROM messages
      WHERE json_extract(payload_json, '$.status') <> 'streaming';
      CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages
      WHEN json_extract(new.payload_json, '$.status') <> 'streaming' BEGIN
        INSERT INTO messages_fts(message_id, room_id, text)
        VALUES (new.id, new.room_id, json_extract(new.payload_json, '$.content'));
      END;
      CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE message_id = old.id;
      END;
      CREATE TRIGGER messages_fts_au AFTER UPDATE OF payload_json ON messages BEGIN
        DELETE FROM messages_fts WHERE message_id = old.id;
        INSERT INTO messages_fts(message_id, room_id, text)
        SELECT new.id, new.room_id, json_extract(new.payload_json, '$.content')
        WHERE json_extract(new.payload_json, '$.status') <> 'streaming';
      END;
    `);
  },
  database => {
    // Version 8 replaces the first FTS triggers for databases that briefly ran
    // version 7 during development. Streaming deltas must not rebuild the FTS
    // row on every token.
    database.exec(`
      DROP TRIGGER IF EXISTS messages_fts_ai;
      DROP TRIGGER IF EXISTS messages_fts_ad;
      DROP TRIGGER IF EXISTS messages_fts_au;
      CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages
      WHEN json_extract(new.payload_json, '$.status') <> 'streaming' BEGIN
        INSERT INTO messages_fts(message_id, room_id, text)
        VALUES (new.id, new.room_id, json_extract(new.payload_json, '$.content'));
      END;
      CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE message_id = old.id;
      END;
      CREATE TRIGGER messages_fts_au AFTER UPDATE OF payload_json ON messages BEGIN
        DELETE FROM messages_fts WHERE message_id = old.id;
        INSERT INTO messages_fts(message_id, room_id, text)
        SELECT new.id, new.room_id, json_extract(new.payload_json, '$.content')
        WHERE json_extract(new.payload_json, '$.status') <> 'streaming';
      END;
    `);
  },
  database => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS psfn_delivery_state (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        remote_companion_id TEXT NOT NULL,
        session_mode TEXT NOT NULL CHECK(session_mode IN ('fixed', 'header')),
        session_key TEXT NOT NULL,
        last_delivered_sequence INTEGER NOT NULL DEFAULT 0,
        inflight_delivery_id TEXT,
        inflight_high_sequence INTEGER,
        inflight_envelope_digest TEXT,
        delivery_status TEXT NOT NULL CHECK(delivery_status IN ('idle', 'inflight', 'ambiguous')),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(room_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS psfn_delivery_ambiguous
      ON psfn_delivery_state(delivery_status, updated_at)
      WHERE delivery_status = 'ambiguous';
    `);
  }
];

export function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(
    database.prepare("SELECT version FROM schema_migrations").all()
      .map(row => (row as { version: number }).version)
  );
  migrations.forEach((migration, index) => {
    const version = index + 1;
    if (applied.has(version)) return;
    const rebuildsReferencedTable = version === 4;
    if (rebuildsReferencedTable) database.pragma("foreign_keys = OFF");
    try {
      database.transaction(() => {
        migration(database);
        if (rebuildsReferencedTable) {
          const violations = database.pragma("foreign_key_check") as unknown[];
          if (violations.length > 0) {
            throw new Error("Artifact identity migration broke foreign keys");
          }
        }
        database.prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
        ).run(version, new Date().toISOString());
      })();
    } finally {
      if (rebuildsReferencedTable) database.pragma("foreign_keys = ON");
    }
  });
}
