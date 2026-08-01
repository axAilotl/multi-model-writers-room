import { describe, expect, it } from "vitest";
import type { GenerationRecord } from "@writers-room/contracts";
import { reasoningTraceLabel } from "./App.js";

function generation(
  patch: Partial<GenerationRecord> = {}
): GenerationRecord {
  return {
    id: "generation-1",
    roomId: "room-1",
    messageId: "message-1",
    agentId: "agent-1",
    provider: "openrouter",
    requestedModelId: "fixture",
    status: "complete",
    finalText: "Public answer",
    retrievedChunkIds: [],
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T00:00:01.000Z",
    ...patch
  };
}

describe("reasoning display policy", () => {
  it("never falls back to a raw trace when summary display was configured", () => {
    const record = generation({
      reasoningText: "raw private trace",
      reasoningConfig: {
        enabled: true,
        effort: "high",
        displayMode: "summary"
      }
    });

    expect(reasoningTraceLabel(record, undefined)).not.toContain("raw private trace");
    expect(reasoningTraceLabel(record, undefined)).toMatch(/no visible trace/i);
  });

  it("retains hidden policy after the participant is removed", () => {
    const record = generation({
      reasoningText: "raw private trace",
      reasoningConfig: { enabled: true, displayMode: "hidden" }
    });

    expect(reasoningTraceLabel(record, undefined)).toMatch(/hidden/i);
  });

  it("defaults legacy generations without a policy snapshot to hidden", () => {
    const record = generation({ reasoningText: "legacy raw trace" });

    expect(reasoningTraceLabel(record, {
      enabled: true,
      effort: "high",
      displayMode: "full"
    })).toMatch(/hidden/i);
    expect(reasoningTraceLabel(record, undefined)).not.toContain("legacy raw trace");
  });
});
