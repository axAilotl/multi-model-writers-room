import { describe, expect, it } from "vitest";
import type { RoomMessage } from "@writers-room/contracts";
import { arbitrateSpeakers } from "./speaker-arbiter.js";

function message(agentId: string, createdAt: string): RoomMessage {
  return {
    id: `${agentId}-${createdAt}`,
    roomId: "room",
    sequence: 1,
    authorType: "agent",
    authorId: agentId,
    content: "Contribution",
    createdAt,
    mentionedAgentIds: [],
    attachmentIds: [],
    citedChunkIds: [],
    status: "complete",
    lifecycle: "active",
    visibility: "public"
  };
}

describe("speaker arbiter", () => {
  it("selects never-spoken and least-recent willing participants first", () => {
    const selected = arbitrateSpeakers({
      candidates: ["alpha", "beta", "gamma"].map(agentId => ({
        value: agentId,
        agentId,
        directlyMentioned: false
      })),
      messages: [
        message("alpha", "2026-08-01T12:00:00.000Z"),
        message("beta", "2026-08-01T11:00:00.000Z")
      ],
      limit: 2
    });

    expect(selected).toEqual(["gamma", "beta"]);
  });

  it("prioritizes a direct human address without admitting unrelated candidates", () => {
    const selected = arbitrateSpeakers({
      candidates: [{ value: "alpha", agentId: "alpha", directlyMentioned: true }],
      messages: [message("alpha", "2026-08-01T12:00:00.000Z")],
      limit: 3
    });

    expect(selected).toEqual(["alpha"]);
  });
});
