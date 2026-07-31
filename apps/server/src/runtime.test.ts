import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startRuntime, type WritersRoomRuntime } from "./runtime.js";

let runtime: WritersRoomRuntime | undefined;
let dataRoot: string | undefined;

afterEach(async () => {
  if (runtime) await runtime.close();
  runtime = undefined;
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
  dataRoot = undefined;
});

describe("runtime lifecycle", () => {
  it("returns JSON 404 responses for unknown API routes", async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "writers-room-runtime-api-"));
    runtime = await startRuntime({ dataRoot, host: "127.0.0.1", port: 0 });
    const address = runtime.address();
    const response = await fetch(
      `http://127.0.0.1:${address!.port}/api/v1/definitely-missing`
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ error: "API route not found" });
  });

  it("closes promptly while a room WebSocket is connected", async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "writers-room-runtime-"));
    runtime = await startRuntime({ dataRoot, host: "127.0.0.1", port: 0 });
    const room = runtime.store.createRoom({ title: "Socket lifecycle" });
    const address = runtime.address();
    expect(address).not.toBeNull();
    const socket = new WebSocket(
      `ws://127.0.0.1:${address!.port}/api/v1/rooms/${room.id}/stream?after=0`
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        runtime.close(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Runtime close timed out with an active WebSocket")),
            1_000
          );
        })
      ]);
      await expect(runtime.localModels.embedQuery("after close"))
        .rejects.toThrow(/closed/);
      runtime = undefined;
    } finally {
      if (timeout) clearTimeout(timeout);
      socket.terminate();
    }
  });
});
