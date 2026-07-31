import {
  Bot,
  BrainCircuit,
  Check,
  Database,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Settings,
  SlidersHorizontal,
  Trash2,
  Users,
  X
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent
} from "react";
import type {
  AgentDefinition,
  ModelCapabilities,
  ModelDescriptor,
  Room,
  RoomSettings,
  VoiceTemplate,
  VoiceTemplateInput
} from "@writers-room/contracts";
import { api } from "./api.js";
import {
  blankVoiceTemplate,
  voiceTemplateInput
} from "./voice-template.js";

const providerLabels: Record<AgentDefinition["provider"], string> = {
  openrouter: "OpenRouter",
  ollama: "Ollama",
  "openai-compatible": "OpenAI-compatible"
};

export function ModelPicker({
  provider,
  value,
  onChange,
  onCapabilities,
  name = "modelId"
}: {
  provider: AgentDefinition["provider"];
  value: string;
  onChange: (modelId: string) => void;
  onCapabilities?: (capabilities: ModelCapabilities | undefined) => void;
  name?: string;
}) {
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setModels([]);
    void api.listProviderModels(provider)
      .then(nextModels => {
        if (cancelled) return;
        setModels(nextModels);
      })
      .catch(errorValue => {
        if (!cancelled) {
          setModels([]);
          setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, reload]);

  useEffect(() => {
    if (models.length > 0 && !models.some(model => model.id === value)) {
      onChange(models[0]!.id);
    }
  }, [models, value, onChange]);

  const selected = models.find(model => model.id === value);
  useEffect(() => {
    onCapabilities?.(selected?.capabilities);
  }, [selected, onCapabilities]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return models;
    return models.filter(model =>
      `${model.name} ${model.id}`.toLowerCase().includes(needle)
    );
  }, [models, query]);
  const visible = selected && !filtered.some(model => model.id === selected.id)
    ? [selected, ...filtered]
    : filtered;

  return (
    <div className="model-picker">
      <div className="model-filter">
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={loading ? "Loading provider models…" : "Filter models…"}
          aria-label="Filter models"
        />
        <button
          type="button"
          onClick={() => setReload(value => value + 1)}
          title="Refresh provider models"
          aria-label="Refresh provider models"
        >
          {loading
            ? <LoaderCircle size={13} className="spin" />
            : <RefreshCw size={13} />}
        </button>
      </div>
      {models.length > 0 ? (
        <select
          name={name}
          required
          value={value}
          onChange={event => onChange(event.target.value)}
        >
          {visible.map(model => (
            <option value={model.id} key={model.id}>
              {model.name} · {model.id}
            </option>
          ))}
        </select>
      ) : (
        <input
          name={name}
          required
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder="provider/model-id"
        />
      )}
      {error && <small className="field-error">{error}</small>}
      {selected && (
        <div className="capability-pills">
          <span>{Math.round(selected.capabilities.contextLength / 1_000)}k context</span>
          {selected.capabilities.imageInput && <span>vision</span>}
          {selected.capabilities.toolCalling && <span>tools</span>}
          {selected.capabilities.reasoningOutput && <span>reasoning</span>}
        </div>
      )}
    </div>
  );
}

function RoomSettingsEditor({
  room,
  onRoomChanged
}: {
  room: Room;
  onRoomChanged: (room: Room) => void;
}) {
  const [settings, setSettings] = useState<RoomSettings>(room.settings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function update<Key extends keyof RoomSettings>(
    key: Key,
    value: RoomSettings[Key]
  ) {
    setSaved(false);
    setSettings(current => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const updated = await api.updateRoom(room.id, { settings });
      onRoomChanged(updated);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={submit}>
      <div className="settings-section-heading">
        <div>
          <span className="eyebrow">Conversation behavior</span>
          <h2>Room pacing</h2>
          <p>Control how freely models enter and continue the discussion.</p>
        </div>
      </div>
      <div className="settings-card settings-grid">
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
            step={0.05}
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
            step={0.01}
            value={settings.jitter}
            onChange={event => update("jitter", Number(event.target.value))}
          />
        </label>
      </div>
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

function ProviderSettings() {
  const [providers, setProviders] = useState<AgentDefinition["provider"][]>([]);
  const [selected, setSelected] =
    useState<AgentDefinition["provider"]>("openrouter");
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    void api.health().then(health => {
      setProviders(health.providers);
      if (!health.providers.includes(selected) && health.providers[0]) {
        setSelected(health.providers[0]);
      }
    });
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(undefined);
    void api.listProviderModels(selected)
      .then(setModels)
      .catch(errorValue => {
        setModels([]);
        setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
      })
      .finally(() => setLoading(false));
  }, [selected]);

  const visible = models.filter(model =>
    `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <section>
      <div className="settings-section-heading">
        <div>
          <span className="eyebrow">Server-side connections</span>
          <h2>Providers & models</h2>
          <p>Credentials remain in the local environment and are never sent to the browser.</p>
        </div>
      </div>
      <div className="provider-strip">
        {(["openrouter", "ollama", "openai-compatible"] as const).map(provider => (
          <button
            key={provider}
            className={selected === provider ? "active" : ""}
            onClick={() => setSelected(provider)}
          >
            <span className={providers.includes(provider) ? "connected-dot" : "offline-dot"} />
            <strong>{providerLabels[provider]}</strong>
            <small>{providers.includes(provider) ? "Configured" : "Not configured"}</small>
          </button>
        ))}
      </div>
      <div className="model-catalog">
        <header>
          <div>
            <strong>{providerLabels[selected]}</strong>
            <span>{loading ? "Loading…" : `${models.length} models available`}</span>
          </div>
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search the catalog…"
          />
        </header>
        {error && <div className="settings-error">{error}</div>}
        <div className="catalog-list">
          {visible.slice(0, 100).map(model => (
            <div key={model.id}>
              <div><strong>{model.name}</strong><code>{model.id}</code></div>
              <span>{Math.round(model.capabilities.contextLength / 1_000)}k</span>
              <span>{model.capabilities.toolCalling ? "tools" : "text"}</span>
              <span>{model.capabilities.reasoningOutput ? "reasoning" : "—"}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function VoiceTemplateEditor() {
  const [templates, setTemplates] = useState<VoiceTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<VoiceTemplateInput>(blankVoiceTemplate);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void api.listVoiceTemplates()
      .then(setTemplates)
      .catch(errorValue => setError(
        errorValue instanceof Error ? errorValue.message : String(errorValue)
      ));
  }, []);

  function update<Key extends keyof VoiceTemplateInput>(
    key: Key,
    value: VoiceTemplateInput[Key]
  ) {
    setDraft(current => ({ ...current, [key]: value }));
  }

  function select(template: VoiceTemplate) {
    setSelectedId(template.id);
    setDraft(voiceTemplateInput(template));
    setError(undefined);
  }

  function createNew() {
    setSelectedId(undefined);
    setDraft(blankVoiceTemplate());
    setError(undefined);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const saved = selectedId
        ? await api.updateVoiceTemplate(selectedId, draft)
        : await api.createVoiceTemplate(draft);
      setTemplates(current => [
        saved,
        ...current.filter(template => template.id !== saved.id)
      ]);
      setSelectedId(saved.id);
      setDraft(voiceTemplateInput(saved));
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!selectedId || !window.confirm("Delete this voice template?")) return;
    setSaving(true);
    try {
      await api.deleteVoiceTemplate(selectedId);
      setTemplates(current => current.filter(template => template.id !== selectedId));
      createNew();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <div className="settings-section-heading">
        <div>
          <span className="eyebrow">Reusable participants</span>
          <h2>Voice templates</h2>
          <p>Save a point of view once, then bring it into any room with its model and behavior intact.</p>
        </div>
        <button className="secondary-button" onClick={createNew}>
          <Plus size={14} /> New template
        </button>
      </div>
      <div className="template-workbench">
        <aside className="template-list">
          {templates.length === 0 && (
            <div className="empty-mini"><Bot size={22} /><span>No saved voices yet.</span></div>
          )}
          {templates.map(template => (
            <button
              key={template.id}
              className={selectedId === template.id ? "active" : ""}
              onClick={() => select(template)}
            >
              <div className="template-avatar">{template.name.slice(0, 2).toUpperCase()}</div>
              <span><strong>{template.title}</strong><small>{template.name}</small></span>
            </button>
          ))}
        </aside>
        <form className="template-form" onSubmit={submit}>
          <div className="field-row">
            <label>Template title
              <input
                required
                value={draft.title}
                onChange={event => update("title", event.target.value)}
              />
            </label>
            <label>Voice name
              <input
                required
                value={draft.name}
                onChange={event => update("name", event.target.value)}
                placeholder="Systems Engineer"
              />
            </label>
          </div>
          <label>Point of view
            <input
              value={draft.description}
              onChange={event => update("description", event.target.value)}
              placeholder="Finds durable seams and failure modes."
            />
          </label>
          <div className="field-row provider-model-row">
            <label>Provider
              <select
                value={draft.provider}
                onChange={event => update(
                  "provider",
                  event.target.value as VoiceTemplateInput["provider"]
                )}
              >
                {Object.entries(providerLabels).map(([value, label]) => (
                  <option value={value} key={value}>{label}</option>
                ))}
              </select>
            </label>
            <label>Model
              <ModelPicker
                provider={draft.provider}
                value={draft.modelId}
                onChange={modelId => update("modelId", modelId)}
              />
            </label>
          </div>
          <label>System prompt
            <textarea
              required
              rows={5}
              value={draft.systemPrompt}
              onChange={event => update("systemPrompt", event.target.value)}
            />
          </label>
          <label>Persona prompt
            <textarea
              rows={3}
              value={draft.personaPrompt ?? ""}
              onChange={event => update("personaPrompt", event.target.value)}
              placeholder="Short stylistic voice: direct, skeptical, concise."
            />
          </label>
          <div className="settings-grid compact-fields">
            <label>Temperature
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={draft.temperature}
                onChange={event => update("temperature", Number(event.target.value))}
              />
            </label>
            <label>Max output tokens
              <input
                type="number"
                min={64}
                max={32_768}
                value={draft.maxOutputTokens}
                onChange={event => update("maxOutputTokens", Number(event.target.value))}
              />
            </label>
            <label>Reasoning
              <select
                value={draft.reasoning.enabled ? draft.reasoning.effort ?? "medium" : "off"}
                onChange={event => {
                  const effort = event.target.value;
                  update("reasoning", effort === "off"
                    ? { enabled: false, displayMode: "hidden" }
                    : {
                        enabled: true,
                        effort: effort as NonNullable<
                          VoiceTemplateInput["reasoning"]["effort"]
                        >,
                        displayMode: "summary"
                      });
                }}
              >
                <option value="off">Off</option>
                <option value="minimal">Minimal</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Extra high</option>
              </select>
            </label>
          </div>
          {error && <div className="settings-error">{error}</div>}
          <footer>
            {selectedId && (
              <button type="button" className="danger-button" onClick={() => void remove()}>
                <Trash2 size={14} /> Delete
              </button>
            )}
            <button className="primary-button" disabled={saving || !draft.name.trim()}>
              {saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
              {selectedId ? "Save template" : "Create template"}
            </button>
          </footer>
        </form>
      </div>
    </section>
  );
}

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
  return (
    <div className="settings-page">
      <header className="settings-header">
        <div><Settings size={19} /><strong>Settings</strong><span>{room.title}</span></div>
        <button className="icon-button" onClick={onClose} aria-label="Close settings">
          <X size={16} />
        </button>
      </header>
      <div className="settings-layout">
        <nav>
          <span>Workspace</span>
          <button className={section === "voices" ? "active" : ""} onClick={() => setSection("voices")}>
            <Users size={15} /> Voice templates
          </button>
          <button className={section === "providers" ? "active" : ""} onClick={() => setSection("providers")}>
            <Database size={15} /> Providers & models
          </button>
          <span>Current room</span>
          <button className={section === "room" ? "active" : ""} onClick={() => setSection("room")}>
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
