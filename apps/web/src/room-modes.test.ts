import { describe, expect, it } from "vitest";
import { defaultRoomSettings } from "@writers-room/contracts";
import { applyRoomMode, roomModeOptions } from "./room-modes.js";

describe("room modes", () => {
  it("exposes the four named room formats", () => {
    expect(roomModeOptions.map(option => option.label)).toEqual([
      "Workshop",
      "Writers’ Room",
      "Shark Tank",
      "Fishbowl"
    ]);
  });

  it("applies behavioral bundles while preserving independent auto controls", () => {
    const current = {
      ...defaultRoomSettings,
      autoMode: false,
      idleRecoveryIntervalMs: 1_200_000
    };

    expect(applyRoomMode(current, "hollywood")).toMatchObject({
      autoMode: false,
      conversationStyle: "hollywood",
      maxResponders: 3,
      maxAutonomousWaves: 8,
      maxAutonomousReplies: 18,
      responseLength: "short",
      idleRecoveryIntervalMs: 1_200_000
    });
    expect(applyRoomMode(current, "deep-study")).toMatchObject({
      conversationStyle: "deep-study",
      deliberationTurns: 3,
      maxResponders: 1,
      responseLength: "long"
    });
  });
});
