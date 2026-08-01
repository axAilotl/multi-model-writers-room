import { Check, LoaderCircle, Save } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  roomSettingsSchema,
  type Room,
  type RoomSettings
} from "@writers-room/contracts";
import { api } from "./api.js";
import { validationMessage } from "./validation.js";
import { applyRoomMode, roomModeOptions } from "./room-modes.js";

export function RoomSettingsEditor({
  room,
  onRoomChanged
}: {
  room: Room;
  onRoomChanged: (room: Room) => void;
}) {
  const [settings, setSettings] = useState<RoomSettings>(room.settings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();

  function update<Key extends keyof RoomSettings>(
    key: Key,
    value: RoomSettings[Key]
  ) {
    setSaved(false);
    setSettings(current => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    const result = roomSettingsSchema.safeParse(settings);
    if (!result.success) {
      setSaved(false);
      setError(validationMessage("Cannot save room settings", result.error));
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateRoom(room.id, { settings: result.data });
      onRoomChanged(updated);
      setSaved(true);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="settings-form" noValidate onSubmit={submit}>
      <div className="settings-section-heading">
        <div>
          <span className="eyebrow">Conversation behavior</span>
          <h2>Room pacing</h2>
          <p>Control how freely models enter and continue the discussion.</p>
        </div>
      </div>
      <div className="settings-card settings-grid">
        <label>
          Room format
          <select
            value={settings.conversationStyle}
            onChange={event => setSettings(current => applyRoomMode(
              current,
              event.target.value as RoomSettings["conversationStyle"]
            ))}
          >
            {roomModeOptions.map(option => (
              <option value={option.value} key={option.value}>
                {option.label} — {option.description}
              </option>
            ))}
          </select>
        </label>
        <label>
          Deliberation passes
          <input
            type="number"
            min={1}
            max={3}
            value={settings.deliberationTurns}
            onChange={event => update("deliberationTurns", Number(event.target.value))}
          />
          <small>Fishbowl uses private application-level drafts before the public answer.</small>
        </label>
        <label className="setting-toggle">
          <span><strong>Automatic conversation</strong><small>Let the scheduler select speakers after human messages.</small></span>
          <input
            type="checkbox"
            checked={settings.autoMode}
            onChange={event => update("autoMode", event.target.checked)}
          />
        </label>
        <label className="setting-toggle">
          <span><strong>Agent continuation</strong><small>Allow models to activate from another model’s message.</small></span>
          <input
            type="checkbox"
            checked={settings.agentContinuation}
            onChange={event => update("agentContinuation", event.target.checked)}
          />
        </label>
        <label>
          Maximum responders
          <input
            type="number"
            min={1}
            max={3}
            value={settings.maxResponders}
            onChange={event => update("maxResponders", Number(event.target.value))}
          />
        </label>
        <label>
          Autonomous wave cap
          <input
            type="number"
            min={1}
            max={12}
            value={settings.maxAutonomousWaves}
            onChange={event => update("maxAutonomousWaves", Number(event.target.value))}
          />
        </label>
        <label>
          Autonomous reply cap
          <input
            type="number"
            min={1}
            max={24}
            value={settings.maxAutonomousReplies}
            onChange={event => update("maxAutonomousReplies", Number(event.target.value))}
          />
        </label>
        <label>
          Response length
          <select
            value={settings.responseLength}
            onChange={event => update(
              "responseLength",
              event.target.value as RoomSettings["responseLength"]
            )}
          >
            <option value="short">Short</option>
            <option value="medium">Medium</option>
            <option value="long">Long</option>
          </select>
        </label>
        <label>
          Fatigue threshold
          <input
            type="number"
            min={0}
            max={1}
            step="any"
            value={settings.fatigueThreshold}
            onChange={event => update("fatigueThreshold", Number(event.target.value))}
          />
        </label>
        <label>
          Activation jitter
          <input
            type="number"
            min={0}
            max={0.25}
            step="any"
            value={settings.jitter}
            onChange={event => update("jitter", Number(event.target.value))}
          />
        </label>
        <label>
          Fatigue recovery interval (minutes)
          <input
            type="number"
            min={1}
            step="any"
            value={settings.idleRecoveryIntervalMs / 60_000}
            onChange={event => update(
              "idleRecoveryIntervalMs",
              Math.round(Math.max(1, Number(event.target.value)) * 60_000)
            )}
          />
        </label>
      </div>
      {error && <div className="settings-error">{error}</div>}
      <div className="settings-actions">
        {saved && <span className="saved-label"><Check size={13} /> Saved</span>}
        <button className="primary-button" disabled={saving}>
          {saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
          Save room settings
        </button>
      </div>
    </form>
  );
}
