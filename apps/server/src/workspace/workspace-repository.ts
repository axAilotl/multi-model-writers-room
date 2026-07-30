import type {
  ArtifactChunk,
  WorkspaceArtifact,
  WorkspaceSearchResult
} from "@writers-room/contracts";
import {
  artifactChunkSchema,
  artifactSchema
} from "@writers-room/contracts";
import * as sqliteVec from "sqlite-vec";
import { RoomStore } from "../storage/room-store.js";

interface JsonRow {
  payload_json: string;
}

interface RankedChunk {
  chunk: ArtifactChunk;
  rank: number;
}

function fromEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(
    embedding.buffer,
    embedding.byteOffset,
    embedding.byteLength
  );
}

function toEmbedding(value: Buffer): Float32Array {
  return new Float32Array(
    value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
  );
}

function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function ftsQuery(query: string): string | undefined {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu);
  if (!terms?.length) return undefined;
  return [...new Set(terms)].map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

export class WorkspaceRepository {
  readonly vectorExtensionAvailable: boolean;

  constructor(private readonly store: RoomStore) {
    let available = false;
    try {
      sqliteVec.load(this.store.database);
      this.store.database.prepare("SELECT vec_version()").get();
      available = true;
    } catch {
      available = false;
    }
    this.vectorExtensionAvailable = available;
  }

  findByHash(roomId: string, sha256: string): WorkspaceArtifact | undefined {
    const row = this.store.database.prepare(`
      SELECT payload_json FROM artifacts WHERE room_id = ? AND sha256 = ?
    `).get(roomId, sha256) as JsonRow | undefined;
    return row ? artifactSchema.parse(JSON.parse(row.payload_json)) : undefined;
  }

  insertArtifact(artifact: WorkspaceArtifact): WorkspaceArtifact {
    this.store.database.prepare(`
      INSERT INTO artifacts(id, room_id, sha256, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      artifact.id,
      artifact.roomId,
      artifact.sha256,
      JSON.stringify(artifact),
      artifact.createdAt,
      artifact.updatedAt
    );
    this.store.appendRoomEvent(artifact.roomId, {
      type: "artifact.updated",
      artifact
    });
    return artifact;
  }

  updateArtifact(
    artifactId: string,
    patch: Partial<WorkspaceArtifact>
  ): WorkspaceArtifact {
    const current = this.getArtifact(artifactId);
    const artifact = artifactSchema.parse({
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    });
    this.store.database.prepare(`
      UPDATE artifacts SET payload_json = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(artifact), artifact.updatedAt, artifactId);
    this.store.appendRoomEvent(artifact.roomId, {
      type: "artifact.updated",
      artifact
    });
    return artifact;
  }

  getArtifact(artifactId: string): WorkspaceArtifact {
    const row = this.store.database.prepare(
      "SELECT payload_json FROM artifacts WHERE id = ?"
    ).get(artifactId) as JsonRow | undefined;
    if (!row) throw new Error(`Artifact not found: ${artifactId}`);
    return artifactSchema.parse(JSON.parse(row.payload_json));
  }

  readRange(artifactId: string, start: number, end: number): ArtifactChunk[] {
    return this.store.database.prepare(`
      SELECT payload_json FROM artifact_chunks
      WHERE artifact_id = ? AND ordinal BETWEEN ? AND ?
      ORDER BY ordinal
    `).all(artifactId, start, end).map(row =>
      artifactChunkSchema.parse(JSON.parse((row as JsonRow).payload_json))
    );
  }

  findExact(
    roomId: string,
    query: string,
    artifactIds: string[] | undefined,
    limit: number
  ): ArtifactChunk[] {
    const rows = this.store.database.prepare(`
      SELECT c.payload_json
      FROM artifact_chunks c
      JOIN artifacts a ON a.id = c.artifact_id
      WHERE a.room_id = ?
        AND instr(lower(c.text), lower(?)) > 0
      ORDER BY a.updated_at DESC, c.ordinal
      LIMIT ?
    `).all(roomId, query, Math.max(limit, 50)) as JsonRow[];
    const allowed = artifactIds ? new Set(artifactIds) : undefined;
    return rows
      .map(row => artifactChunkSchema.parse(JSON.parse(row.payload_json)))
      .filter(chunk => !allowed || allowed.has(chunk.artifactId))
      .slice(0, limit);
  }

  listArtifacts(roomId: string): WorkspaceArtifact[] {
    return this.store.database.prepare(`
      SELECT payload_json FROM artifacts
      WHERE room_id = ? ORDER BY updated_at DESC
    `).all(roomId).map(row =>
      artifactSchema.parse(JSON.parse((row as JsonRow).payload_json))
    );
  }

  replaceChunks(
    artifactId: string,
    chunks: ArtifactChunk[],
    embeddings: Float32Array[]
  ): void {
    if (chunks.length !== embeddings.length) {
      throw new Error("Every chunk requires exactly one embedding");
    }
    this.store.database.transaction(() => {
      this.store.database.prepare(
        "DELETE FROM artifact_chunks WHERE artifact_id = ?"
      ).run(artifactId);
      const insert = this.store.database.prepare(`
        INSERT INTO artifact_chunks(
          id, artifact_id, ordinal, text, payload_json, embedding
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      chunks.forEach((chunk, index) => {
        const complete = artifactChunkSchema.parse({ ...chunk, artifactId });
        insert.run(
          complete.id,
          artifactId,
          complete.ordinal,
          complete.text,
          JSON.stringify(complete),
          fromEmbedding(embeddings[index]!)
        );
      });
    })();
  }

  listChunks(artifactId: string): ArtifactChunk[] {
    return this.store.database.prepare(`
      SELECT payload_json FROM artifact_chunks
      WHERE artifact_id = ? ORDER BY ordinal
    `).all(artifactId).map(row =>
      artifactChunkSchema.parse(JSON.parse((row as JsonRow).payload_json))
    );
  }

  getChunk(chunkId: string): ArtifactChunk {
    const row = this.store.database.prepare(
      "SELECT payload_json FROM artifact_chunks WHERE id = ?"
    ).get(chunkId) as JsonRow | undefined;
    if (!row) throw new Error(`Artifact chunk not found: ${chunkId}`);
    return artifactChunkSchema.parse(JSON.parse(row.payload_json));
  }

  lexicalCandidates(roomId: string, query: string, limit: number): RankedChunk[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const rows = this.store.database.prepare(`
      SELECT c.payload_json
      FROM artifact_chunks_fts f
      JOIN artifact_chunks c ON c.rowid = f.rowid
      JOIN artifacts a ON a.id = c.artifact_id
      WHERE artifact_chunks_fts MATCH ? AND a.room_id = ?
      ORDER BY f.rank
      LIMIT ?
    `).all(match, roomId, limit) as JsonRow[];
    return rows.map((row, index) => ({
      chunk: artifactChunkSchema.parse(JSON.parse(row.payload_json)),
      rank: index + 1
    }));
  }

  vectorCandidates(
    roomId: string,
    query: Float32Array,
    limit: number
  ): RankedChunk[] {
    if (this.vectorExtensionAvailable) {
      try {
        const rows = this.store.database.prepare(`
          SELECT c.payload_json,
                 vec_distance_cosine(c.embedding, ?) AS distance
          FROM artifact_chunks c
          JOIN artifacts a ON a.id = c.artifact_id
          WHERE a.room_id = ? AND c.embedding IS NOT NULL
          ORDER BY distance
          LIMIT ?
        `).all(fromEmbedding(query), roomId, limit) as JsonRow[];
        return rows.map((row, index) => ({
          chunk: artifactChunkSchema.parse(JSON.parse(row.payload_json)),
          rank: index + 1
        }));
      } catch {
        // A malformed or legacy vector row must not take lexical search down.
      }
    }
    const rows = this.store.database.prepare(`
      SELECT c.payload_json, c.embedding
      FROM artifact_chunks c
      JOIN artifacts a ON a.id = c.artifact_id
      WHERE a.room_id = ? AND c.embedding IS NOT NULL
    `).all(roomId) as Array<JsonRow & { embedding: Buffer }>;
    return rows
      .map(row => ({
        chunk: artifactChunkSchema.parse(JSON.parse(row.payload_json)),
        similarity: cosine(query, toEmbedding(row.embedding))
      }))
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, limit)
      .map((result, index) => ({ chunk: result.chunk, rank: index + 1 }));
  }

  fuse(input: {
    lexical: RankedChunk[];
    vector: RankedChunk[];
    limit: number;
  }): WorkspaceSearchResult[] {
    const scores = new Map<string, {
      chunk: ArtifactChunk;
      score: number;
      lexicalRank?: number;
      vectorRank?: number;
    }>();
    for (const result of input.lexical) {
      scores.set(result.chunk.id, {
        chunk: result.chunk,
        score: 1 / (60 + result.rank),
        lexicalRank: result.rank
      });
    }
    for (const result of input.vector) {
      const current = scores.get(result.chunk.id);
      if (current) {
        current.score += 1 / (60 + result.rank);
        current.vectorRank = result.rank;
      } else {
        scores.set(result.chunk.id, {
          chunk: result.chunk,
          score: 1 / (60 + result.rank),
          vectorRank: result.rank
        });
      }
    }
    return [...scores.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, input.limit)
      .map(result => {
        const artifact = this.getArtifact(result.chunk.artifactId);
        return {
          chunk: result.chunk,
          artifact,
          score: result.score,
          ...(result.lexicalRank === undefined
            ? {}
            : { lexicalRank: result.lexicalRank }),
          ...(result.vectorRank === undefined
            ? {}
            : { vectorRank: result.vectorRank }),
          citation: formatCitation(artifact, result.chunk)
        };
      });
  }
}

export function formatCitation(
  artifact: WorkspaceArtifact,
  chunk: ArtifactChunk
): string {
  const location = chunk.pageNumber
    ? `page ${chunk.pageNumber}`
    : chunk.headingPath
      ? `§ ${chunk.headingPath}`
      : chunk.lineStart
        ? `lines ${chunk.lineStart}–${chunk.lineEnd ?? chunk.lineStart}`
        : "document";
  return `[${artifact.filename} ${location} / chunk ${chunk.id}]`;
}
