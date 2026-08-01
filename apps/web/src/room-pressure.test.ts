import { describe, expect, it } from "vitest";
import type { RoomMessage } from "@writers-room/contracts";
import { roomPressure } from "./room-pressure.js";

function agentMessage(createdAt: string): RoomMessage {
  return {
    id: createdAt,
    roomId: "room-1",
    authorType: "agent",
    authorId: "agent-1",
    content: "A contribution.",
    createdAt,
    mentionedAgentIds: [],
    attachmentIds: [],
    citedChunkIds: [],
    status: "complete",
    visibility: "public",
    lifecycle: "active",
    sequence: 1
  };
}

describe("room pressure display", () => {
  it("decays completed agent-message pressure over time", () => {
    const createdAt = "2026-08-01T12:00:00.000Z";
    const messages = [agentMessage(createdAt)];

    expect(roomPressure(messages, Date.parse(createdAt))).toBeCloseTo(1);
    expect(roomPressure(messages, Date.parse(createdAt) + 600_000)).toBeCloseTo(0.5);
    expect(roomPressure(messages, Date.parse(createdAt) + 3_600_001)).toBe(0);
  });

  it("ignores deleted and failed messages", () => {
    const now = "2026-08-01T12:00:00.000Z";
    const deleted = { ...agentMessage(now), lifecycle: "deleted" as const };
    const failed = { ...agentMessage(now), status: "failed" as const };

    expect(roomPressure([deleted, failed], Date.parse(now))).toBe(0);
  });
});
