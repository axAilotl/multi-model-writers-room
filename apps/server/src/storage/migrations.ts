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
    database.transaction(() => {
      migration(database);
      database.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
      ).run(version, new Date().toISOString());
    })();
  });
}
