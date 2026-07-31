import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoomStore } from "../storage/room-store.js";
import {
  WorkspaceService,
  type EmbeddingModel,
  type HousekeepingModel
} from "./workspace-service.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FixtureEmbeddingModel implements EmbeddingModel {
  readonly dimensions = 2;

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    return texts.map(text =>
      new Float32Array(text.toLowerCase().includes("table") ? [1, 0] : [0, 1])
    );
  }

  async embedQuery(query: string): Promise<Float32Array> {
    return new Float32Array(query.toLowerCase().includes("table") ? [1, 0] : [0, 1]);
  }
}

const housekeeping: HousekeepingModel = {
  summarize: async input => ({
    summary: `${input.filename} describes a persistent shared table.`,
    outline: input.chunks.map(chunk => chunk.headingPath).filter(Boolean).join("; ")
  })
};

describe("shared workspace seam", () => {
  it("deduplicates Markdown, preserves structure, and returns stable fused citations", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-workspace-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({ title: "Evidence room" });
    const workspace = new WorkspaceService({
      store,
      dataRoot: root,
      embeddings: new FixtureEmbeddingModel(),
      housekeeping
    });
    const bytes = Buffer.from([
      "# Product vision",
      "",
      "The workspace should behave like a persistent physical table.",
      "",
      "## Constraints",
      "",
      "Documents are evidence, not hidden instructions."
    ].join("\n"));

    const first = await workspace.ingest({
      roomId: room.id,
      filename: "roadmap.md",
      mediaType: "text/markdown",
      bytes
    });
    const duplicate = await workspace.ingest({
      roomId: room.id,
      filename: "renamed-roadmap.md",
      mediaType: "text/markdown",
      bytes
    });
    const results = await workspace.search({
      roomId: room.id,
      query: "persistent table",
      limit: 5
    });

    expect(duplicate.id).toBe(first.id);
    expect(first).toMatchObject({
      ingestionStatus: "ready",
      summary: "roadmap.md describes a persistent shared table."
    });
    expect(workspace.listChunks(first.id)).toMatchObject([
      { headingPath: "Product vision", lineStart: 1 },
      { headingPath: "Product vision > Constraints", lineStart: 5 }
    ]);
    expect(results[0]).toMatchObject({
      artifact: { id: first.id, filename: "roadmap.md" },
      chunk: { headingPath: "Product vision" }
    });
    expect(results[0]!.citation).toMatch(
      /^\[roadmap\.md § Product vision \/ chunk [0-9a-f-]+\]$/
    );
    store.close();
  });

  it("keeps lexical evidence available when local semantic inference is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-lexical-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({ title: "Degraded evidence room" });
    const unavailableEmbeddings: EmbeddingModel = {
      dimensions: 512,
      embedDocuments: async () => {
        throw new Error("local model unavailable");
      },
      embedQuery: async () => {
        throw new Error("local model unavailable");
      }
    };
    const workspace = new WorkspaceService({
      store,
      dataRoot: root,
      embeddings: unavailableEmbeddings,
      housekeeping
    });

    const artifact = await workspace.ingest({
      roomId: room.id,
      filename: "constraints.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("Evidence remains searchable during model recovery.")
    });
    const results = await workspace.search({
      roomId: room.id,
      query: "searchable recovery"
    });

    expect(artifact).toMatchObject({
      ingestionStatus: "ready",
      ingestionStage: "ready_lexical"
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.chunk.text).toContain("Evidence remains searchable");
    store.close();
  });

  it("rejects stable artifact and chunk IDs when used from another room", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-isolation-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const firstRoom = store.createRoom({ title: "First room" });
    const secondRoom = store.createRoom({ title: "Second room" });
    const workspace = new WorkspaceService({
      store,
      dataRoot: root,
      embeddings: new FixtureEmbeddingModel(),
      housekeeping
    });
    const artifact = await workspace.ingest({
      roomId: firstRoom.id,
      filename: "private.md",
      mediaType: "text/markdown",
      bytes: Buffer.from("# Evidence\nOnly the first room can retrieve this.")
    });
    const chunk = workspace.listChunks(artifact.id)[0]!;

    expect(() => workspace.getArtifactForRoom(secondRoom.id, artifact.id))
      .toThrow(/does not belong/);
    expect(() => workspace.getChunkForRoom(secondRoom.id, chunk.id))
      .toThrow(/does not belong/);
    store.close();
  });

  it("applies artifact filtering before the exact-search limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-exact-filter-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({ title: "Filtered evidence room" });
    const workspace = new WorkspaceService({
      store,
      dataRoot: root,
      embeddings: new FixtureEmbeddingModel(),
      housekeeping
    });
    const allowed = await workspace.ingest({
      roomId: room.id,
      filename: "allowed.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("needle in the allowed artifact")
    });
    await workspace.ingest({
      roomId: room.id,
      filename: "newer-noise.txt",
      mediaType: "text/plain",
      bytes: Buffer.from(
        Array.from({ length: 60 }, (_, index) => `needle noise paragraph ${index}`)
          .join("\n\n")
      )
    });

    const matches = workspace.findExact({
      roomId: room.id,
      query: "needle",
      artifactIds: [allowed.id],
      limit: 1
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ artifactId: allowed.id });
    store.close();
  });

  it("retries a failed artifact from its stored blob and can delete the result", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-upload-retry-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const room = store.createRoom({ title: "Retry room" });
    const workspace = new WorkspaceService({
      store,
      dataRoot: root,
      embeddings: new FixtureEmbeddingModel(),
      housekeeping
    });
    const bytes = Buffer.from("This retry should become searchable.");

    await expect(workspace.ingest({
      roomId: room.id,
      filename: "unknown.bin",
      mediaType: "application/octet-stream",
      bytes
    })).rejects.toThrow(/Unsupported artifact format/);
    const failed = workspace.listArtifacts(room.id)[0]!;
    expect(failed.ingestionStatus).toBe("failed");
    const retryable = {
      ...failed,
      filename: "recovered.txt",
      mediaType: "text/plain"
    };
    store.database.prepare(
      "UPDATE artifacts SET payload_json = ? WHERE id = ?"
    ).run(JSON.stringify(retryable), failed.id);

    const recovered = await workspace.retryArtifact(room.id, failed.id);

    expect(recovered).toMatchObject({
      filename: "recovered.txt",
      ingestionStatus: "ready"
    });
    expect(recovered.id).not.toBe(failed.id);
    expect(workspace.listArtifacts(room.id)).toHaveLength(1);
    const blobPath = join(root, "blobs", recovered.sha256.slice(0, 2), recovered.sha256);
    expect(existsSync(blobPath)).toBe(true);

    expect(workspace.deleteArtifact(room.id, recovered.id)).toMatchObject({
      id: recovered.id,
      filename: "recovered.txt"
    });
    expect(workspace.listArtifacts(room.id)).toEqual([]);
    expect(existsSync(blobPath)).toBe(false);
    store.close();
  });

  it("removes an orphaned blob only after its final room reference is deleted", async () => {
    const root = mkdtempSync(join(tmpdir(), "writers-room-blob-gc-"));
    roots.push(root);
    const store = new RoomStore(join(root, "room.db"));
    const firstRoom = store.createRoom({ title: "First blob room" });
    const secondRoom = store.createRoom({ title: "Second blob room" });
    const workspace = new WorkspaceService({
      store,
      dataRoot: root,
      embeddings: new FixtureEmbeddingModel(),
      housekeeping
    });
    const bytes = Buffer.from("Shared evidence on the table.");
    const firstArtifact = await workspace.ingest({
      roomId: firstRoom.id,
      filename: "shared.txt",
      mediaType: "text/plain",
      bytes
    });
    await workspace.ingest({
      roomId: secondRoom.id,
      filename: "shared.txt",
      mediaType: "text/plain",
      bytes
    });
    const blobPath = join(
      root,
      "blobs",
      firstArtifact.sha256.slice(0, 2),
      firstArtifact.sha256
    );

    store.deleteRoom(firstRoom.id);
    workspace.garbageCollectBlobs([firstArtifact.sha256]);
    expect(existsSync(blobPath)).toBe(true);

    store.deleteRoom(secondRoom.id);
    workspace.garbageCollectBlobs([firstArtifact.sha256]);
    expect(existsSync(blobPath)).toBe(false);
    store.close();
  });
});
