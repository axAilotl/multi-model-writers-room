import {
  calculateRoomPressure,
  ROOM_PRESSURE_POLICY,
  type RoomMessage
} from "@writers-room/contracts";

export const ROOM_PRESSURE_HALF_LIFE_MS = ROOM_PRESSURE_POLICY.halfLifeMs;
export const ROOM_PRESSURE_HARD_THRESHOLD = ROOM_PRESSURE_POLICY.hardThreshold;

export function roomPressure(
  messages: readonly RoomMessage[],
  nowMs: number,
  halfLifeMs = ROOM_PRESSURE_HALF_LIFE_MS
): number {
  return calculateRoomPressure(messages, nowMs, halfLifeMs);
}

export function roomPressurePercent(
  messages: readonly RoomMessage[],
  nowMs: number
): number {
  return Math.min(
    100,
    Math.round((roomPressure(messages, nowMs) / ROOM_PRESSURE_HARD_THRESHOLD) * 100)
  );
}
