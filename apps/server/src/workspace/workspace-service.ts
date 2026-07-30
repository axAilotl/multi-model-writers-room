import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ArtifactChunk,
  WorkspaceArtifact,
  WorkspaceSearchResult
} from "@writers-room/contracts";
import { artifactSchema } from "@writers-room/contracts";
import { uuidv7 } from "../shared/id.js";
import { RoomStore } from "../storage/room-store.js";
import { parseMarkdown, parsePdf, parsePlainText } from "./parsers.js";
import { WorkspaceRepository } from "./workspace-repository.js";

export interface EmbeddingModel {
  readonly dimensions: number;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(query: string): Promise<Float32Array>;
}

export interface HousekeepingModel {
  summarize(input: {
    filename: string;
    chunks: ArtifactChunk[];
  }): Promise<{ summary: string; outline?: string }>;
}

interface WorkspaceServiceOptions {
  store: RoomStore;
  dataRoot: string;
  embeddings: EmbeddingModel;
  housekeeping: HousekeepingModel;
}

export class WorkspaceService {
  private readonly repository: WorkspaceRepository;
  private readonly blobsRoot: string;

  constructor(private readonly options: WorkspaceServiceOptions) {
    this.repository = new WorkspaceRepository(options.store);
    this.blobsRoot = join(options.dataRoot, "blobs");
    mkdirSync(this.blobsRoot, { recursive: true });
  }

  async ingest(input: {
    roomId: string;
    filename: string;
    mediaType: string;
    bytes: Buffer;
  }): Promise<WorkspaceArtifact> {
    if (input.bytes.byteLength > 50 * 1024 * 1024) {
      throw new Error("Artifact exceeds the 50 MB upload limit");
    }
    this.options.store.getRoom(input.roomId);
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const existing = this.repository.findByHash(input.roomId, sha256);
    if (existing) return existing;
    const now = new Date().toISOString();
    let artifact = artifactSchema.parse({
      id: uuidv7(),
      roomId: input.roomId,
      filename: input.filename,
      mediaType: input.mediaType,
      sha256,
      byteSize: input.bytes.byteLength,
      sourceType: "upload",
      summary: "Queued for ingestion.",
      ingestionStatus: "processing",
      ingestionStage: "extracting",
      createdAt: now,
      updatedAt: now
    });
    this.repository.insertArtifact(artifact);
    this.writeBlob(sha256, input.bytes);
    try {
      const chunks = await this.parse(input.mediaType, input.filename, input.bytes);
      if (chunks.length === 0) throw new Error("No text could be extracted");
      this.repository.replaceChunks(artifact.id, chunks);
      let semanticError: string | undefined;
      try {
        const embeddings = await this.options.embeddings.embedDocuments(
          chunks.map(chunk => `search_document: ${chunk.text}`)
        );
        this.repository.updateEmbeddings(chunks, embeddings);
      } catch (error) {
        semanticError = error instanceof Error ? error.message : String(error);
      }
      let summary: { summary: string; outline?: string };
      try {
        summary = await this.options.housekeeping.summarize({
          filename: input.filename,
          chunks: chunks.slice(0, 20).map(chunk => ({
            ...chunk,
            artifactId: artifact.id
          }))
        });
      } catch {
        summary = {
          summary: chunks[0]!.text.replace(/\s+/g, " ").slice(0, 320),
          outline: chunks.map(chunk => chunk.headingPath).filter(Boolean).join("; ")
        };
      }
      artifact = this.repository.updateArtifact(artifact.id, {
        summary: summary.summary,
        ...(summary.outline ? { outline: summary.outline } : {}),
        ingestionStatus: "ready",
        ingestionStage: semanticError ? "ready_lexical" : "ready",
        ...(semanticError === undefined
          ? {}
          : { error: `Semantic indexing unavailable: ${semanticError}` })
      });
      return artifact;
    } catch (error) {
      this.repository.updateArtifact(artifact.id, {
        ingestionStatus: "failed",
        ingestionStage: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  listArtifacts(roomId: string): WorkspaceArtifact[] {
    return this.repository.listArtifacts(roomId);
  }

  listChunks(artifactId: string): ArtifactChunk[] {
    return this.repository.listChunks(artifactId);
  }

  getChunk(chunkId: string): ArtifactChunk {
    return this.repository.getChunk(chunkId);
  }

  getArtifact(artifactId: string): WorkspaceArtifact {
    return this.repository.getArtifact(artifactId);
  }

  getArtifactForRoom(roomId: string, artifactId: string): WorkspaceArtifact {
    const artifact = this.repository.getArtifact(artifactId);
    if (artifact.roomId !== roomId) {
      throw new Error("Artifact does not belong to this room");
    }
    return artifact;
  }

  readRange(artifactId: string, start: number, end: number): ArtifactChunk[] {
    return this.repository.readRange(artifactId, start, end);
  }

  readRangeForRoom(
    roomId: string,
    artifactId: string,
    start: number,
    end: number
  ): ArtifactChunk[] {
    this.getArtifactForRoom(roomId, artifactId);
    return this.repository.readRange(artifactId, start, end);
  }

  getChunkForRoom(roomId: string, chunkId: string): ArtifactChunk {
    const chunk = this.repository.getChunk(chunkId);
    this.getArtifactForRoom(roomId, chunk.artifactId);
    return chunk;
  }

  findExact(input: {
    roomId: string;
    query: string;
    artifactIds?: string[];
    limit?: number;
  }): ArtifactChunk[] {
    return this.repository.findExact(
      input.roomId,
      input.query,
      input.artifactIds,
      Math.max(1, Math.min(20, input.limit ?? 8))
    );
  }

  manifest(roomId: string): string {
    return this.listArtifacts(roomId)
      .filter(artifact => artifact.ingestionStatus === "ready")
      .map(artifact => [
        `[${artifact.filename}]`,
        `Summary: ${artifact.summary}`,
        artifact.outline ? `Sections: ${artifact.outline}` : ""
      ].filter(Boolean).join("\n"))
      .join("\n\n");
  }

  health(): { vectorExtensionAvailable: boolean } {
    return {
      vectorExtensionAvailable: this.repository.vectorExtensionAvailable
    };
  }

  async search(input: {
    roomId: string;
    query: string;
    limit?: number;
  }): Promise<WorkspaceSearchResult[]> {
    const limit = Math.max(1, Math.min(20, input.limit ?? 8));
    const lexical = this.repository.lexicalCandidates(input.roomId, input.query, 50);
    let vector: ReturnType<WorkspaceRepository["vectorCandidates"]> = [];
    try {
      const queryEmbedding = await this.options.embeddings.embedQuery(
        `search_query: ${input.query}`
      );
      vector = this.repository.vectorCandidates(input.roomId, queryEmbedding, 50);
    } catch {
      vector = [];
    }
    return this.repository.fuse({ lexical, vector, limit });
  }

  private async parse(
    mediaType: string,
    filename: string,
    bytes: Buffer
  ): Promise<ArtifactChunk[]> {
    if (mediaType === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) {
      return parsePdf(bytes);
    }
    const text = bytes.toString("utf8");
    if (
      mediaType === "text/markdown" ||
      filename.toLowerCase().endsWith(".md") ||
      filename.toLowerCase().endsWith(".markdown")
    ) {
      return parseMarkdown(text);
    }
    if (mediaType.startsWith("text/") || filename.toLowerCase().endsWith(".txt")) {
      return parsePlainText(text);
    }
    throw new Error(`Unsupported artifact format: ${mediaType}`);
  }

  private writeBlob(sha256: string, bytes: Buffer): void {
    const directory = join(this.blobsRoot, sha256.slice(0, 2));
    const path = join(directory, sha256);
    mkdirSync(directory, { recursive: true });
    if (!existsSync(path)) writeFileSync(path, bytes, { flag: "wx" });
  }
}
