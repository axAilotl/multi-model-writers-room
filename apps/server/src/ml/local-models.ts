import { mkdirSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { uuidv7 } from "../shared/id.js";
import type {
  EmbeddingModel,
  HousekeepingModel
} from "../workspace/workspace-service.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup?: () => void;
}

interface WorkerReply {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export class LocalModelWorker implements EmbeddingModel, HousekeepingModel {
  readonly dimensions = 512;
  private readonly worker: Worker;
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;

  constructor(input: {
    dataRoot: string;
    embeddingModel?: string;
    summaryModel?: string;
  }) {
    const cacheDir = join(input.dataRoot, "models");
    mkdirSync(cacheDir, { recursive: true });
    this.worker = new Worker(new URL("./local-ml-worker.js", import.meta.url), {
      workerData: {
        cacheDir,
        embeddingModel: input.embeddingModel ?? "nomic-ai/nomic-embed-text-v1.5",
        embeddingRevision: "e9b6763023c676ca8431644204f50c2b100d9aab",
        embeddingDimensions: this.dimensions,
        summaryModel: input.summaryModel ?? "onnx-community/Qwen3-0.6B-ONNX",
        summaryRevision: "da1453100cf3ff33ef56d17983fc7a8648706db6"
      }
    });
    this.worker.on("message", (reply: WorkerReply) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      pending.cleanup?.();
      if (reply.ok) pending.resolve(reply.result);
      else pending.reject(new Error(reply.error ?? "Local ML worker failed"));
    });
    this.worker.on("error", error => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        pending.cleanup?.();
        pending.reject(error);
      }
      this.pending.clear();
    });
    this.worker.on("exit", code => {
      this.closed = true;
      const error = new Error(
        code === 0
          ? "Local ML worker closed"
          : `Local ML worker exited with code ${code}`
      );
      for (const pending of this.pending.values()) {
        pending.cleanup?.();
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  async embedDocuments(
    texts: string[],
    signal?: AbortSignal
  ): Promise<Float32Array[]> {
    const rows = await this.request<number[][]>({ type: "embed", texts }, signal);
    return rows.map(row => new Float32Array(row));
  }

  async embedQuery(query: string, signal?: AbortSignal): Promise<Float32Array> {
    return (await this.embedDocuments([query], signal))[0]!;
  }

  summarize(input: {
    filename: string;
    chunks: Parameters<HousekeepingModel["summarize"]>[0]["chunks"];
  }): Promise<{ summary: string; outline?: string }> {
    return this.request({ type: "summarize", input });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.cleanup?.();
      pending.reject(new Error("Local ML worker closed"));
    }
    this.pending.clear();
    await this.worker.terminate();
  }

  private request<Result>(
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Result> {
    if (this.closed) return Promise.reject(new Error("Local ML worker is closed"));
    if (signal?.aborted) {
      return Promise.reject(new DOMException("aborted", "AbortError"));
    }
    const id = uuidv7();
    return new Promise<Result>((resolve, reject) => {
      const abort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup?.();
        try {
          this.worker.postMessage({ type: "cancel", targetId: id });
        } catch {
          // The worker is already closing.
        }
        reject(new DOMException("aborted", "AbortError"));
      };
      if (signal) signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: value => resolve(value as Result),
        reject,
        ...(signal === undefined
          ? {}
          : { cleanup: () => signal.removeEventListener("abort", abort) })
      });
      try {
        this.worker.postMessage({ id, ...payload });
      } catch (error) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.cleanup?.();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
