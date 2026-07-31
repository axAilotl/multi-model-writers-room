import {
  Bot,
  Check,
  LoaderCircle,
  Plus,
  Save,
  Sparkles,
  Trash2
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import {
  defaultRoomToolNames,
  type DefaultModelSelection,
  type VoiceTemplate,
  type VoiceTemplateInput
} from "@writers-room/contracts";
import { api } from "./api.js";
import { ModelPicker } from "./model-picker.js";
import { providerLabels } from "./provider-labels.js";
import { VoiceGeneratorModal } from "./voice-generator-modal.js";
import {
  blankVoiceTemplate,
  voiceTemplateInput
} from "./voice-template.js";

export function VoiceTemplateEditor() {
  const [templates, setTemplates] = useState<VoiceTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [draft, setDraft] = useState<VoiceTemplateInput>(blankVoiceTemplate);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string>();
  const [defaultModel, setDefaultModel] = useState<DefaultModelSelection>();
  const [showGenerator, setShowGenerator] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const nextTemplates = await api.listVoiceTemplates();
        if (!active) return;
        setTemplates(nextTemplates);
        const savedDefault = await api.getDefaultModel();
        if (!active) return;
        setDefaultModel(savedDefault);
        if (savedDefault) {
          setDraft(current => current.modelId
            ? current
            : {
                ...current,
                provider: savedDefault.provider,
                modelId: savedDefault.modelId
              });
        }
      } catch (errorValue) {
        if (active) {
          setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  function update<Key extends keyof VoiceTemplateInput>(
    key: Key,
    value: VoiceTemplateInput[Key]
  ) {
    setSaved(false);
    setConfirmingDelete(false);
    setDraft(current => ({ ...current, [key]: value }));
  }

  function select(template: VoiceTemplate) {
    setSelectedId(template.id);
    setDraft(voiceTemplateInput(template));
    setSaved(false);
    setConfirmingDelete(false);
    setError(undefined);
  }

  function createNew() {
    setSelectedId(undefined);
    setDraft(blankVoiceTemplate(defaultModel));
    setSaved(false);
    setConfirmingDelete(false);
    setError(undefined);
  }

  const availableTools = Array.from(new Set([
    ...defaultRoomToolNames,
    ...draft.tools
  ]));

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
      setSaved(true);
      setConfirmingDelete(false);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!selectedId) return;
    setSaving(true);
    setError(undefined);
    try {
      await api.deleteVoiceTemplate(selectedId);
      setTemplates(current => current.filter(template => template.id !== selectedId));
      createNew();
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
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
        <div className="settings-heading-actions">
          <button className="secondary-button" onClick={() => setShowGenerator(true)}>
            <Sparkles size={14} /> Generate with AI
          </button>
          <button className="secondary-button" onClick={createNew}>
            <Plus size={14} /> New template
          </button>
        </div>
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
                step="any"
                value={draft.temperature}
                onChange={event => update("temperature", Number(event.target.value))}
              />
            </label>
            <label>Top P
              <input
                type="number"
                min={0}
                max={1}
                step="any"
                value={draft.topP ?? ""}
                placeholder="Provider default"
                onChange={event => update(
                  "topP",
                  event.target.value === "" ? undefined : Number(event.target.value)
                )}
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
                    ? { ...draft.reasoning, enabled: false }
                    : {
                        ...draft.reasoning,
                        enabled: true,
                        effort: effort as NonNullable<
                          VoiceTemplateInput["reasoning"]["effort"]
                        >
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
            <label>Reasoning token cap
              <input
                type="number"
                min={1}
                value={draft.reasoning.maxTokens ?? ""}
                placeholder="Provider default"
                disabled={!draft.reasoning.enabled}
                onChange={event => update("reasoning", {
                  ...draft.reasoning,
                  maxTokens: event.target.value === ""
                    ? undefined
                    : Number(event.target.value)
                })}
              />
            </label>
            <label>Reasoning display
              <select
                value={draft.reasoning.displayMode}
                disabled={!draft.reasoning.enabled}
                onChange={event => update("reasoning", {
                  ...draft.reasoning,
                  displayMode: event.target.value as
                    VoiceTemplateInput["reasoning"]["displayMode"]
                })}
              >
                <option value="full">Full</option>
                <option value="summary">Summary</option>
                <option value="hidden">Hidden</option>
              </select>
            </label>
          </div>
          <fieldset className="template-fieldset">
            <legend>Tools</legend>
            <p>Choose which safe room tools this voice may call.</p>
            <div className="tool-grid">
              {availableTools.map(tool => (
                <label key={tool}>
                  <input
                    type="checkbox"
                    checked={draft.tools.includes(tool)}
                    onChange={event => update(
                      "tools",
                      event.target.checked
                        ? [...draft.tools, tool]
                        : draft.tools.filter(current => current !== tool)
                    )}
                  />
                  <code>{tool}</code>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="template-fieldset">
            <legend>Context budget</legend>
            <p>Set how this voice divides its independent working context.</p>
            <div className="settings-grid context-fields">
              <label>Soft limit
                <input
                  type="number"
                  min={1}
                  value={draft.contextBudget.softLimitTokens}
                  onChange={event => update("contextBudget", {
                    ...draft.contextBudget,
                    softLimitTokens: Number(event.target.value)
                  })}
                />
              </label>
              <label>Hard limit
                <input
                  type="number"
                  min={1}
                  value={draft.contextBudget.hardLimitTokens}
                  onChange={event => update("contextBudget", {
                    ...draft.contextBudget,
                    hardLimitTokens: Number(event.target.value)
                  })}
                />
              </label>
              <label>Recent transcript
                <input
                  type="number"
                  min={0}
                  value={draft.contextBudget.recentTranscriptTokens}
                  onChange={event => update("contextBudget", {
                    ...draft.contextBudget,
                    recentTranscriptTokens: Number(event.target.value)
                  })}
                />
              </label>
              <label>Retrieved context
                <input
                  type="number"
                  min={0}
                  value={draft.contextBudget.retrievedContextTokens}
                  onChange={event => update("contextBudget", {
                    ...draft.contextBudget,
                    retrievedContextTokens: Number(event.target.value)
                  })}
                />
              </label>
              <label>Notebook
                <input
                  type="number"
                  min={0}
                  value={draft.contextBudget.notebookTokens}
                  onChange={event => update("contextBudget", {
                    ...draft.contextBudget,
                    notebookTokens: Number(event.target.value)
                  })}
                />
              </label>
            </div>
          </fieldset>
          {error && <div className="settings-error">{error}</div>}
          <footer>
            {selectedId && !confirmingDelete && (
              <button
                type="button"
                className="danger-button"
                disabled={saving}
                onClick={() => {
                  setSaved(false);
                  setConfirmingDelete(true);
                }}
              >
                <Trash2 size={14} /> Delete
              </button>
            )}
            {selectedId && confirmingDelete && (
              <div className="delete-confirmation">
                <span>Delete this template?</span>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={saving}
                  onClick={() => setConfirmingDelete(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="danger-button"
                  disabled={saving}
                  onClick={() => void remove()}
                >
                  <Trash2 size={14} /> Confirm delete
                </button>
              </div>
            )}
            {saved && <span className="saved-label"><Check size={13} /> Saved</span>}
            <button className="primary-button" disabled={saving || !draft.name.trim()}>
              {saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
              {selectedId ? "Save template" : "Create template"}
            </button>
          </footer>
        </form>
      </div>
      {showGenerator && (
        <VoiceGeneratorModal
          {...(defaultModel === undefined ? {} : { defaultModel })}
          onClose={() => setShowGenerator(false)}
          onGenerated={template => {
            setSelectedId(undefined);
            setDraft(template);
            setSaved(false);
            setConfirmingDelete(false);
            setError(undefined);
            setShowGenerator(false);
          }}
        />
      )}
    </section>
  );
}
