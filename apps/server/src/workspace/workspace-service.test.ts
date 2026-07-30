import { mkdtempSync, rmSync } from "node:fs";
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
});
