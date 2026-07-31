import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
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

function extractiveSummary(chunks: ArtifactChunk[]): {
  summary: string;
  outline?: string;
} {
  const summary = chunks[0]!.text.replace(/\s+/g, " ").slice(0, 320);
  const outline = chunks.map(chunk => chunk.headingPath).filter(Boolean).join("; ");
  return {
    summary,
    ...(outline ? { outline } : {})
  };
}

export const extractiveHousekeepingModel: HousekeepingModel = {
  summarize: async input => extractiveSummary(input.chunks)
};

interface WorkspaceServiceOptions {
  store: RoomStore;
  dataRoot: string;
  embeddings: EmbeddingModel;
  housekeeping: HousekeepingModel;
}

export class WorkspaceService {
  private readonly repository: WorkspaceRepository;
  private readonly blobsRoot: string;
  private readonly enrichmentJobs = new Set<Promise<void>>();

  constructor(private readonly options: WorkspaceServiceOptions) {
    this.repository = new WorkspaceRepository(options.store);
    this.blobsRoot = join(options.dataRoot, "blobs");
    mkdirSync(this.blobsRoot, { recursive: true });
    this.reconcileInterruptedArtifacts();
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
    if (existing && existing.ingestionStatus !== "failed") return existing;
    if (existing) this.repository.deleteArtifact(existing.id);
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
      const summary = extractiveSummary(chunks);
      artifact = this.repository.updateArtifact(artifact.id, {
        summary: summary.summary,
        ...(summary.outline ? { outline: summary.outline } : {}),
        ingestionStatus: "ready",
        ingestionStage: "ready_lexical"
      });
      this.startEnrichment(artifact, chunks);
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

  async waitForEnrichment(): Promise<void> {
    await Promise.allSettled([...this.enrichmentJobs]);
  }

  async retryArtifact(roomId: string, artifactId: string): Promise<WorkspaceArtifact> {
    const artifact = this.getArtifactForRoom(roomId, artifactId);
    if (artifact.ingestionStatus !== "failed") {
      throw new Error("Only failed artifacts can be retried");
    }
    const path = this.blobPath(artifact.sha256);
    if (!existsSync(path)) throw new Error("The original file is no longer available");
    const bytes = readFileSync(path);
    this.repository.deleteArtifact(artifact.id);
    return this.ingest({
      roomId,
      filename: artifact.filename,
      mediaType: artifact.mediaType,
      bytes
    });
  }

  deleteArtifact(roomId: string, artifactId: string): WorkspaceArtifact {
    const artifact = this.getArtifactForRoom(roomId, artifactId);
    this.repository.deleteArtifact(artifact.id);
    this.garbageCollectBlobs([artifact.sha256]);
    this.options.store.appendRoomEvent(roomId, {
      type: "artifact.deleted",
      artifactId: artifact.id
    });
    return artifact;
  }

  garbageCollectBlobs(sha256Hashes: Iterable<string>): void {
    for (const sha256 of new Set(sha256Hashes)) {
      if (!/^[a-f0-9]{64}$/.test(sha256)) continue;
      if (this.repository.isHashReferenced(sha256)) continue;
      const path = join(this.blobsRoot, sha256.slice(0, 2), sha256);
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch (error) {
        console.error(`Failed to remove orphaned workspace blob ${sha256}`, error);
      }
    }
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
    const path = this.blobPath(sha256);
    const directory = join(this.blobsRoot, sha256.slice(0, 2));
    mkdirSync(directory, { recursive: true });
    if (!existsSync(path)) writeFileSync(path, bytes, { flag: "wx" });
  }

  private blobPath(sha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid workspace blob hash");
    return join(this.blobsRoot, sha256.slice(0, 2), sha256);
  }

  private startEnrichment(
    artifact: WorkspaceArtifact,
    chunks: ArtifactChunk[]
  ): void {
    const job = this.enrichArtifact(artifact, chunks)
      .catch(error => {
        try {
          this.repository.updateArtifact(artifact.id, {
            ingestionStage: "ready_lexical",
            error: `Semantic enrichment unavailable: ${
              error instanceof Error ? error.message : String(error)
            }`
          });
        } catch {
          // The artifact or room was deleted while enrichment was running.
        }
      })
      .finally(() => {
        this.enrichmentJobs.delete(job);
      });
    this.enrichmentJobs.add(job);
  }

  private async enrichArtifact(
    artifact: WorkspaceArtifact,
    chunks: ArtifactChunk[]
  ): Promise<void> {
    const enrichmentChunks = chunks.slice(0, 20).map(chunk => ({
      ...chunk,
      artifactId: artifact.id
    }));
    const [embeddingResult, summaryResult] = await Promise.allSettled([
      this.options.embeddings.embedDocuments(
        chunks.map(chunk => `search_document: ${chunk.text}`)
      ),
      this.options.housekeeping.summarize({
        filename: artifact.filename,
        chunks: enrichmentChunks
      })
    ]);
    try {
      this.repository.getArtifact(artifact.id);
    } catch {
      return;
    }
    if (embeddingResult.status === "fulfilled") {
      this.repository.updateEmbeddings(chunks, embeddingResult.value);
    }
    const errors = [
      ...(embeddingResult.status === "rejected"
        ? [`Semantic indexing unavailable: ${String(embeddingResult.reason)}`]
        : []),
      ...(summaryResult.status === "rejected"
        ? [`Summary enrichment unavailable: ${String(summaryResult.reason)}`]
        : [])
    ];
    this.repository.updateArtifact(artifact.id, {
      ...(summaryResult.status === "fulfilled"
        ? {
            summary: summaryResult.value.summary,
            ...(summaryResult.value.outline
              ? { outline: summaryResult.value.outline }
              : {})
          }
        : {}),
      ingestionStage: embeddingResult.status === "fulfilled"
        ? "ready"
        : "ready_lexical",
      ...(errors.length > 0 ? { error: errors.join("; ") } : { error: undefined })
    });
  }

  private reconcileInterruptedArtifacts(): void {
    for (const room of this.options.store.listRooms()) {
      for (const artifact of this.repository.listArtifacts(room.id)) {
        if (artifact.ingestionStatus !== "processing") continue;
        this.repository.updateArtifact(artifact.id, {
          ingestionStatus: "failed",
          ingestionStage: "failed",
          error: "Ingestion was interrupted. Retry to process the stored original."
        });
      }
    }
  }
}
