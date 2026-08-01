import {
  roomModePresets,
  type RoomSettings
} from "@writers-room/contracts";

export const roomModeOptions: Array<{
  value: RoomSettings["conversationStyle"];
  label: string;
  description: string;
}> = [
  {
    value: "conversation",
    label: "Workshop",
    description: "Normal pace with balanced speaker routing."
  },
  {
    value: "hollywood",
    label: "Writers’ Room",
    description: "Fast, interruptible crosstalk and rapid idea mutation."
  },
  {
    value: "debate",
    label: "Shark Tank",
    description: "Present, steelman, challenge, defend, and rebut."
  },
  {
    value: "deep-study",
    label: "Fishbowl",
    description: "Slow, evidence-grounded deliberation before speaking."
  }
];

export function applyRoomMode(
  current: RoomSettings,
  style: RoomSettings["conversationStyle"]
): RoomSettings {
  return {
    ...roomModePresets[style],
    autoMode: current.autoMode,
    idleRecoveryIntervalMs: current.idleRecoveryIntervalMs
  };
}

export function roomModeLabel(style: RoomSettings["conversationStyle"]): string {
  return roomModeOptions.find(option => option.value === style)?.label ?? style;
}
