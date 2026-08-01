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
  embedDocuments(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
  embedQuery(query: string, signal?: AbortSignal): Promise<Float32Array>;
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
    sourceType?: WorkspaceArtifact["sourceType"];
    ownerAgentId?: string;
    voiceTemplateLibraryItemId?: string;
  }): Promise<WorkspaceArtifact> {
    if (input.bytes.byteLength > 50 * 1024 * 1024) {
      throw new Error("Artifact exceeds the 50 MB upload limit");
    }
    this.options.store.getRoom(input.roomId);
    const sourceType = input.sourceType ?? "upload";
    if (sourceType === "persona-memory" && input.ownerAgentId === undefined) {
      throw new Error("Persona memory requires an owning participant");
    }
    if (input.ownerAgentId !== undefined) {
      this.options.store.getRoomAgent(input.roomId, input.ownerAgentId);
    }
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const existing = this.repository.findByHash(
      input.roomId,
      sha256,
      {
        sourceType,
        ...(sourceType === "repository" || sourceType === "persona-memory"
          ? { filename: input.filename }
          : {}),
        ...(input.ownerAgentId === undefined
          ? {}
          : { ownerAgentId: input.ownerAgentId }),
        ...(input.voiceTemplateLibraryItemId === undefined
          ? {}
          : { voiceTemplateLibraryItemId: input.voiceTemplateLibraryItemId })
      }
    );
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
      sourceType,
      ...(input.ownerAgentId === undefined ? {} : { ownerAgentId: input.ownerAgentId }),
      ...(input.voiceTemplateLibraryItemId === undefined
        ? {}
        : { voiceTemplateLibraryItemId: input.voiceTemplateLibraryItemId }),
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
      bytes,
      sourceType: artifact.sourceType,
      ...(artifact.ownerAgentId === undefined
        ? {}
        : { ownerAgentId: artifact.ownerAgentId }),
      ...(artifact.voiceTemplateLibraryItemId === undefined
        ? {}
        : { voiceTemplateLibraryItemId: artifact.voiceTemplateLibraryItemId })
    });
  }

  async describeReferenceSource(input: {
    filename: string;
    mediaType: string;
    bytes: Buffer;
  }): Promise<{ summary: string; outline?: string }> {
    if (input.bytes.byteLength > 50 * 1024 * 1024) {
      throw new Error("Reference source exceeds the 50 MB upload limit");
    }
    const chunks = await this.parse(input.mediaType, input.filename, input.bytes);
    if (chunks.length === 0) throw new Error("No text could be extracted");
    return extractiveSummary(chunks);
  }

  storeReferenceBlob(bytes: Buffer): string {
    if (bytes.byteLength > 50 * 1024 * 1024) {
      throw new Error("Reference source exceeds the 50 MB upload limit");
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    this.writeBlob(sha256, bytes);
    return sha256;
  }

  readReferenceBlob(sha256: string): Buffer {
    const path = this.blobPath(sha256);
    if (!existsSync(path)) throw new Error("The reference source is no longer available");
    return readFileSync(path);
  }

  deleteArtifact(
    roomId: string,
    artifactId: string,
    options?: { allowTemplateManaged?: boolean }
  ): WorkspaceArtifact {
    const artifact = this.getArtifactForRoom(roomId, artifactId);
    if (artifact.voiceTemplateLibraryItemId && !options?.allowTemplateManaged) {
      const error = new Error(
        "This reference is managed by its voice template. Remove it from Voice Settings."
      ) as Error & { status?: number };
      error.status = 409;
      throw error;
    }
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
      if (this.options.store.isVoiceTemplateLibraryHashReferenced(sha256)) continue;
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

  resolveArtifactForRoom(roomId: string, reference: string): WorkspaceArtifact {
    const artifacts = this.listArtifacts(roomId);
    const exactId = artifacts.find(artifact => artifact.id === reference);
    if (exactId) return exactId;
    const exactFilename = artifacts.filter(artifact => artifact.filename === reference);
    if (exactFilename.length === 1) return exactFilename[0]!;
    const basenameMatches = artifacts.filter(artifact =>
      artifact.filename.split("/").at(-1) === reference
    );
    if (basenameMatches.length === 1) return basenameMatches[0]!;
    throw new Error(
      exactFilename.length > 1 || basenameMatches.length > 1
        ? `Artifact reference is ambiguous: ${reference}`
        : `Artifact not found: ${reference}`
    );
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
    sourceTypes?: WorkspaceArtifact["sourceType"][];
    visibleToAgentId?: string;
    limit?: number;
  }): ArtifactChunk[] {
    return this.repository.findExact(
      input.roomId,
      input.query,
      input.artifactIds,
      input.sourceTypes,
      input.visibleToAgentId,
      Math.max(1, Math.min(20, input.limit ?? 8))
    );
  }

  manifest(roomId: string, agentId?: string): string {
    const artifacts = this.listArtifacts(roomId);
    const documents = artifacts
      .filter(artifact => artifact.ingestionStatus === "ready")
      .filter(artifact => artifact.sourceType !== "repository")
      .filter(artifact =>
        artifact.ownerAgentId === undefined || artifact.ownerAgentId === agentId
      )
      .map(artifact => [
        `[${artifact.filename} | artifact_id: ${artifact.id}${
          artifact.sourceType === "persona-memory" ? " | private persona library" : ""
        }]`,
        `Summary: ${artifact.summary}`,
        artifact.outline ? `Sections: ${artifact.outline}` : ""
      ].filter(Boolean).join("\n"))
      .join("\n\n");
    const repositoryArtifacts = artifacts.filter(artifact =>
      artifact.ingestionStatus === "ready" && artifact.sourceType === "repository"
    );
    const repositoryManifest = repositoryArtifacts.length > 0
      ? [
          `[Repository corpus | ${repositoryArtifacts.length} indexed files]`,
          "Repository contents are brokered. Ask the Table Researcher automata with ask_table_researcher; direct document search does not expose repository chunks."
        ].join("\n")
      : "";
    return [documents, repositoryManifest].filter(Boolean).join("\n\n");
  }

  health(): { vectorExtensionAvailable: boolean } {
    return {
      vectorExtensionAvailable: this.repository.vectorExtensionAvailable
    };
  }

  async search(input: {
    roomId: string;
    query: string;
    sourceTypes?: WorkspaceArtifact["sourceType"][];
    visibleToAgentId?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<WorkspaceSearchResult[]> {
    input.signal?.throwIfAborted();
    const limit = Math.max(1, Math.min(20, input.limit ?? 8));
    const lexical = this.repository.lexicalCandidates(
      input.roomId,
      input.query,
      50,
      input.sourceTypes,
      input.visibleToAgentId
    );
    let vector: ReturnType<WorkspaceRepository["vectorCandidates"]> = [];
    try {
      const queryEmbedding = await this.options.embeddings.embedQuery(
        `search_query: ${input.query}`,
        input.signal
      );
      input.signal?.throwIfAborted();
      vector = this.repository.vectorCandidates(
        input.roomId,
        queryEmbedding,
        50,
        input.sourceTypes,
        input.visibleToAgentId
      );
    } catch (error) {
      if (input.signal?.aborted) {
        throw error instanceof DOMException
          ? error
          : new DOMException("aborted", "AbortError");
      }
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
    if (text.includes("\0")) throw new Error("Binary files cannot be indexed as text");
    if (
      mediaType === "text/markdown" ||
      filename.toLowerCase().endsWith(".md") ||
      filename.toLowerCase().endsWith(".markdown")
    ) {
      return parseMarkdown(text);
    }
    if (
      mediaType.startsWith("text/") ||
      filename.toLowerCase().endsWith(".txt") ||
      isRepositoryTextFile(filename, mediaType)
    ) {
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

const repositoryTextExtensions = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html",
  ".ini", ".java", ".js", ".json", ".jsonc", ".jsx", ".kt", ".kts",
  ".mjs", ".php", ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".swift",
  ".toml", ".ts", ".tsx", ".vue", ".xml", ".yaml", ".yml"
]);

function isRepositoryTextFile(filename: string, mediaType: string): boolean {
  if (mediaType === "application/json" || mediaType === "application/xml") return true;
  const basename = filename.toLowerCase().split("/").at(-1) ?? "";
  if (["dockerfile", "makefile", "procfile", ".gitignore", ".npmrc"].includes(basename)) {
    return true;
  }
  const dot = basename.lastIndexOf(".");
  return dot >= 0 && repositoryTextExtensions.has(basename.slice(dot));
}
