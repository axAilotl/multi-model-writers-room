import {
  BrainCircuit,
  Database,
  Settings,
  SlidersHorizontal,
  Users,
  X
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Room } from "@writers-room/contracts";
import { ProviderSettings } from "./provider-settings.js";
import { RoomSettingsEditor } from "./room-settings.js";
import { VoiceTemplateEditor } from "./voice-template-settings.js";

export { ModelPicker } from "./model-picker.js";

export function SettingsPage({
  room,
  onClose,
  onRoomChanged
}: {
  room: Room;
  onClose: () => void;
  onRoomChanged: (room: Room) => void;
}) {
  const [section, setSection] = useState<"room" | "voices" | "providers">("voices");
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    closeButtonRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="settings-page"
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      <header className="settings-header">
        <div>
          <Settings size={19} />
          <strong id="settings-title">Settings</strong>
          <span>{room.title}</span>
        </div>
        <button
          ref={closeButtonRef}
          className="icon-button"
          onClick={onClose}
          aria-label="Close settings"
        >
          <X size={16} />
        </button>
      </header>
      <div className="settings-layout">
        <nav>
          <span>Workspace</span>
          <button
            className={section === "voices" ? "active" : ""}
            onClick={() => setSection("voices")}
          >
            <Users size={15} /> Voice templates
          </button>
          <button
            className={section === "providers" ? "active" : ""}
            onClick={() => setSection("providers")}
          >
            <Database size={15} /> Providers & models
          </button>
          <span>Current room</span>
          <button
            className={section === "room" ? "active" : ""}
            onClick={() => setSection("room")}
          >
            <SlidersHorizontal size={15} /> Conversation
          </button>
          <div className="settings-nav-note">
            <BrainCircuit size={15} />
            <p>Templates are shared across rooms. Conversation controls apply only to this room.</p>
          </div>
        </nav>
        <main>
          {section === "voices" && <VoiceTemplateEditor />}
          {section === "providers" && <ProviderSettings />}
          {section === "room" && (
            <RoomSettingsEditor room={room} onRoomChanged={onRoomChanged} />
          )}
        </main>
      </div>
    </div>
  );
}
