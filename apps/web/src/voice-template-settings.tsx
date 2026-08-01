import {
  Bot,
  Check,
  FileText,
  LoaderCircle,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Upload
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import {
  defaultRoomToolNames,
  deriveContextPolicy,
  voiceTemplateInputSchema,
  type DefaultModelSelection,
  type ModelDescriptor,
  type ProviderConnectionStatus,
  type ProviderKind,
  type VoiceTemplate,
  type VoiceTemplateLibraryItem,
  type VoiceTemplateInput
} from "@writers-room/contracts";
import { api } from "./api.js";
import { ModelPicker } from "./model-picker.js";
import { providerLabels } from "./provider-labels.js";
import { VoiceGeneratorModal } from "./voice-generator-modal.js";
import { validationMessage } from "./validation.js";
import {
  availableReasoningEfforts,
  reconcileReasoningConfig,
  type ReasoningSupport
} from "./reasoning-controls.js";
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
  const [availableProviders, setAvailableProviders] = useState<ProviderKind[]>([]);
  const [providerConnections, setProviderConnections] = useState<ProviderConnectionStatus[]>([]);
  const [showGenerator, setShowGenerator] = useState(false);
  const [reasoningSupport, setReasoningSupport] = useState<ReasoningSupport>();
  const [modelContextLength, setModelContextLength] = useState<number>();
  const [libraryItems, setLibraryItems] = useState<VoiceTemplateLibraryItem[]>([]);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [confirmingLibraryItemId, setConfirmingLibraryItemId] = useState<string>();
  const contextPolicy = deriveContextPolicy({
    contextBudget: draft.contextBudget,
    ...(modelContextLength === undefined ? {} : { modelContextLength })
  });

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [nextTemplates, connections] = await Promise.all([
          api.listVoiceTemplates(),
          api.listProviderConnections()
        ]);
        if (!active) return;
        setTemplates(nextTemplates);
        setAvailableProviders(connections.map(connection => connection.provider));
        setProviderConnections(connections);
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

  useEffect(() => {
    let active = true;
    setConfirmingLibraryItemId(undefined);
    if (!selectedId) {
      setLibraryItems([]);
      return () => {
        active = false;
      };
    }
    setLibraryBusy(true);
    void api.listVoiceTemplateLibrary(selectedId)
      .then(items => {
        if (active) setLibraryItems(items);
      })
      .catch(errorValue => {
        if (active) {
          setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
        }
      })
      .finally(() => {
        if (active) setLibraryBusy(false);
      });
    return () => {
      active = false;
    };
  }, [selectedId]);

  function update<Key extends keyof VoiceTemplateInput>(
    key: Key,
    value: VoiceTemplateInput[Key]
  ) {
    setSaved(false);
    setConfirmingDelete(false);
    setError(undefined);
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
    setLibraryItems([]);
  }

  async function uploadReferences(files: FileList | null) {
    if (!selectedId || !files || files.length === 0) return;
    setLibraryBusy(true);
    setError(undefined);
    try {
      for (const file of Array.from(files)) {
        const item = await api.uploadVoiceTemplateReference(selectedId, file);
        setLibraryItems(current => [
          item,
          ...current.filter(candidate => candidate.id !== item.id)
        ]);
      }
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      setLibraryBusy(false);
    }
  }

  async function removeReference(itemId: string) {
    if (!selectedId) return;
    setLibraryBusy(true);
    setError(undefined);
    try {
      await api.deleteVoiceTemplateReference(selectedId, itemId);
      setLibraryItems(current => current.filter(item => item.id !== itemId));
      setConfirmingLibraryItemId(undefined);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      setLibraryBusy(false);
    }
  }

  const availableTools = Array.from(new Set([
    ...defaultRoomToolNames,
    ...draft.tools
  ]));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    const missing = [
      !draft.title.trim() ? "Template title" : undefined,
      !draft.name.trim() ? "Voice name" : undefined,
      !draft.modelId.trim() ? "Model" : undefined,
      draft.provider !== "psfn" && !draft.systemPrompt.trim()
        ? "System prompt"
        : undefined
    ].filter((field): field is string => field !== undefined);
    if (missing.length > 0) {
      const fields = missing.length === 1
        ? missing[0]
        : `${missing.slice(0, -1).join(", ")}, and ${missing.at(-1)}`;
      setSaved(false);
      setError(`Cannot save template: ${fields} ${missing.length === 1 ? "is" : "are"} required.`);
      return;
    }
    const result = voiceTemplateInputSchema.safeParse(draft);
    if (!result.success) {
      setSaved(false);
      setError(validationMessage("Cannot save template", result.error));
      return;
    }
    setSaving(true);
    try {
      const saved = selectedId
        ? await api.updateVoiceTemplate(selectedId, result.data)
        : await api.createVoiceTemplate(result.data);
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
        <form className="template-form" noValidate onSubmit={submit}>
          <div className="field-row">
            <label>Template title
              <input
                name="title"
                required
                value={draft.title}
                onChange={event => update("title", event.target.value)}
              />
            </label>
            <label>Voice name
              <input
                name="name"
                required
                value={draft.name}
                onChange={event => update("name", event.target.value)}
                placeholder="Systems Engineer"
              />
            </label>
          </div>
          <label>Point of view
            <input
              name="description"
              value={draft.description}
              onChange={event => update("description", event.target.value)}
              placeholder="Finds durable seams and failure modes."
            />
          </label>
          <div className="field-row provider-model-row">
            <label>Provider
              <select
                name="provider"
                value={draft.provider}
                onChange={event => {
                  const provider = event.target.value as VoiceTemplateInput["provider"];
                  const remoteName = providerConnections.find(connection =>
                    connection.provider === provider
                  )?.remoteCompanionName;
                  setDraft(current => ({
                    ...current,
                    provider,
                    modelId: "",
                    ...(provider === "psfn" ? {
                      ...(!current.name.trim() && remoteName ? { name: remoteName } : {}),
                      systemPrompt: "",
                      personaPrompt: "",
                      reasoning: { enabled: false, displayMode: "hidden" },
                      tools: []
                    } : {})
                  }));
                  setReasoningSupport(undefined);
                  setModelContextLength(undefined);
                }}
              >
                {availableProviders.map(provider => (
                  <option value={provider} key={provider}>{providerLabels[provider]}</option>
                ))}
              </select>
            </label>
            <label>Model
              <ModelPicker
                provider={draft.provider}
                value={draft.modelId}
                onChange={modelId => update("modelId", modelId)}
                onModel={(model: ModelDescriptor | undefined) => {
                  setReasoningSupport(model?.reasoning);
                  setModelContextLength(model?.capabilities.contextLength);
                  if (model) {
                    setDraft(current => ({
                      ...current,
                      reasoning: reconcileReasoningConfig(
                        current.reasoning,
                        model.reasoning
                      )
                    }));
                  }
                }}
              />
            </label>
          </div>
          {draft.provider === "psfn" ? (
            <div className="psfn-persona-notice">
              <strong>Persona and memory live in PSFN</strong>
              <span>This template binds the room voice to the verified remote companion. Writers’ Room does not replace its system prompt, faculties, persona, or persistent memory.</span>
              {!defaultModel && (
                <span>Auto participation requires a stateless fallback model. Direct @mentions and manual Invite remain available.</span>
              )}
            </div>
          ) : (
            <>
              <label>System prompt
                <textarea
                  name="systemPrompt"
                  required
                  rows={5}
                  value={draft.systemPrompt}
                  onChange={event => update("systemPrompt", event.target.value)}
                />
              </label>
              <label>Persona prompt
                <textarea
                  name="personaPrompt"
                  rows={3}
                  value={draft.personaPrompt ?? ""}
                  onChange={event => update("personaPrompt", event.target.value)}
                  placeholder="Short stylistic voice: direct, skeptical, concise."
                />
              </label>
            </>
          )}
          {draft.provider !== "psfn" && <>
          <fieldset className="template-fieldset voice-reference-library">
            <legend>Reference library</legend>
            <p>
              Private grounding material for this voice. Saved references follow the
              voice into every room and remain hidden from other participants.
            </p>
            {!selectedId ? (
              <div className="empty-mini">
                <FileText size={18} />
                <span>Save the template before adding references.</span>
              </div>
            ) : (
              <>
                <label className={`voice-library-upload secondary-button ${libraryBusy ? "disabled" : ""}`}>
                  {libraryBusy ? <LoaderCircle size={14} className="spin" /> : <Upload size={14} />}
                  Add reference files
                  <input
                    type="file"
                    multiple
                    accept=".md,.markdown,.txt,.pdf,text/markdown,text/plain,application/pdf"
                    disabled={libraryBusy}
                    onChange={event => {
                      const input = event.currentTarget;
                      void uploadReferences(input.files).finally(() => {
                        input.value = "";
                      });
                    }}
                  />
                </label>
                {libraryItems.length === 0 && !libraryBusy && (
                  <div className="empty-mini">
                    <FileText size={18} />
                    <span>No reference files yet.</span>
                  </div>
                )}
                <div className="voice-library-items">
                  {libraryItems.map(item => (
                    <div className="voice-library-item" key={item.id}>
                      <FileText size={16} />
                      <span>
                        <strong>{item.filename}</strong>
                        <small>{Math.max(1, Math.round(item.byteSize / 1_024))} KB · {item.summary}</small>
                      </span>
                      {confirmingLibraryItemId === item.id ? (
                        <div className="delete-confirmation" role="group" aria-label={`Delete ${item.filename}?`}>
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={libraryBusy}
                            onClick={() => setConfirmingLibraryItemId(undefined)}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="danger-button"
                            disabled={libraryBusy}
                            onClick={() => void removeReference(item.id)}
                          >
                            Confirm
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="icon-button danger-icon"
                          disabled={libraryBusy}
                          aria-label={`Delete ${item.filename}`}
                          onClick={() => setConfirmingLibraryItemId(item.id)}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </fieldset>
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
                {!reasoningSupport?.mandatory && <option value="off">Off</option>}
                {availableReasoningEfforts(reasoningSupport).map(option => (
                  <option value={option.value} key={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>Reasoning token cap
              <input
                type="number"
                min={1}
                value={draft.reasoning.maxTokens ?? ""}
                placeholder="Provider default"
                disabled={!draft.reasoning.enabled || reasoningSupport?.supportsMaxTokens === false}
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
            <p>
              Auto mode uses provider model metadata, targets a 256k working window, and caps
              very-large-context models at 512k. Allocations use a normalized 1:2:3 ratio for
              system/persona, table/personal evidence, and recent chat.
            </p>
            <label className="setting-toggle">
              <span>
                <strong>Auto-scale to model context</strong>
                <small>
                  {Math.round(contextPolicy.workingLimitTokens / 1_000)}k working · {Math.round(contextPolicy.hardLimitTokens / 1_000)}k hard · compact chat at {Math.round(contextPolicy.compactionTriggerTokens / 1_000)}k
                </small>
              </span>
              <input
                type="checkbox"
                checked={draft.contextBudget.automatic === true}
                onChange={event => update("contextBudget", {
                  ...draft.contextBudget,
                  automatic: event.target.checked
                })}
              />
            </label>
            <div className="settings-grid context-fields">
              <label>Soft limit
                <input
                  type="number"
                  min={1}
                  disabled={draft.contextBudget.automatic === true}
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
                  disabled={draft.contextBudget.automatic === true}
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
                  disabled={draft.contextBudget.automatic === true}
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
                  disabled={draft.contextBudget.automatic === true}
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
                  disabled={draft.contextBudget.automatic === true}
                  value={draft.contextBudget.notebookTokens}
                  onChange={event => update("contextBudget", {
                    ...draft.contextBudget,
                    notebookTokens: Number(event.target.value)
                  })}
                />
              </label>
            </div>
          </fieldset>
          </>}
          {error && <div className="settings-error" role="alert">{error}</div>}
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
            <button className="primary-button" disabled={saving}>
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
