import {
  Bot,
  BrainCircuit,
  ChevronDown,
  CirclePause,
  CirclePlay,
  FileText,
  Gauge,
  LoaderCircle,
  MessageSquareText,
  Mic2,
  PanelLeft,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
  Upload,
  Users,
  Volume2,
  VolumeX,
  Wrench,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent
} from "react";
import type {
  AgentDefinition,
  GenerationRecord,
  ModelCapabilities,
  Room,
  RoomMessage,
  RoomSnapshot,
  VoiceTemplate,
  VoiceTemplateInput,
  WorkspaceSearchResult
} from "@writers-room/contracts";
import { agentDefinitionSchema } from "@writers-room/contracts";
import { api } from "./api.js";
import {
  ModelPicker,
  SettingsPage
} from "./voice-settings.js";
import {
  blankVoiceTemplate,
  voiceTemplateInput
} from "./voice-template.js";
import { validationMessage } from "./validation.js";

const participantColors = ["#c96c47", "#637d68", "#7566a3", "#b08a3f", "#477b8f"];

function agentColor(snapshot: RoomSnapshot, agentId: string): string {
  const index = snapshot.agents.findIndex(agent => agent.id === agentId);
  return participantColors[Math.max(0, index) % participantColors.length]!;
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function generationFor(
  snapshot: RoomSnapshot,
  message: RoomMessage
): GenerationRecord | undefined {
  return snapshot.generations.find(generation => generation.id === message.generationId);
}

function MessageDetails({ generation, workspaceRevision }: {
  generation: GenerationRecord;
  workspaceRevision: string;
}) {
  const [open, setOpen] = useState(false);
  const [inspectionError, setInspectionError] = useState<string>();
  const [inspection, setInspection] = useState<Awaited<
    ReturnType<typeof api.inspectGeneration>
  >>();
  useEffect(() => {
    setInspection(undefined);
  }, [workspaceRevision]);
  useEffect(() => {
    if (!open || inspection) return;
    let active = true;
    setInspectionError(undefined);
    void (async () => {
      try {
        const result = await api.inspectGeneration(generation.id);
        if (active) setInspection(result);
      } catch (errorValue) {
        if (active) {
          setInspectionError(
            errorValue instanceof Error ? errorValue.message : String(errorValue)
          );
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [open, generation.id, inspection, workspaceRevision]);
  return (
    <div className="message-details">
      <button className="detail-toggle" onClick={() => setOpen(value => !value)}>
        <BrainCircuit size={13} />
        Inspect
        <ChevronDown size={13} className={open ? "turn" : ""} />
      </button>
      {open && (
        <div className="detail-panel">
          {inspectionError && <div className="settings-error">{inspectionError}</div>}
          <section>
            <span className="detail-label">Reasoning</span>
            <p>
              {generation.reasoningSummary ??
                generation.reasoningText ??
                "Reasoning unavailable from this model/provider."}
            </p>
          </section>
          <section className="detail-grid">
            <div>
              <span className="detail-label">Model</span>
              <strong>{generation.actualModelId ?? generation.requestedModelId}</strong>
            </div>
            <div>
              <span className="detail-label">Usage</span>
              <strong>{generation.inputTokens ?? "—"} in · {generation.outputTokens ?? "—"} out</strong>
            </div>
            <div>
              <span className="detail-label">Latency</span>
              <strong>{generation.latencyMs ? `${(generation.latencyMs / 1_000).toFixed(1)}s` : "—"}</strong>
            </div>
            <div>
              <span className="detail-label">Cost</span>
              <strong>{generation.costUsd === undefined || generation.costUsd === null
                ? "—"
                : `$${generation.costUsd.toFixed(4)}`}</strong>
            </div>
          </section>
          {inspection && inspection.citations.length > 0 && (
            <section>
              <span className="detail-label">Retrieved sources</span>
              <div className="evidence-list">
                {inspection.citations.map(citation => (
                  <div key={citation.chunkId}>
                    <strong>
                      {citation.filename}
                      {citation.headingPath
                        ? ` § ${citation.headingPath}`
                        : citation.pageNumber
                          ? ` · page ${citation.pageNumber}`
                          : ""}
                    </strong>
                    <span>{citation.text.slice(0, 180)}</span>
                    <code>{citation.chunkId}</code>
                  </div>
                ))}
              </div>
            </section>
          )}
          {inspection && inspection.toolCalls.length > 0 && (
            <section>
              <span className="detail-label">Tools</span>
              <div className="tool-list">
                {inspection.toolCalls.map(call => (
                  <div key={call.id}>
                    <Wrench size={11} />
                    <strong>{call.toolName}</strong>
                    <span>{call.status}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function Conversation({ snapshot, busy, onDeleteTail, onRegenerateTail }: {
  snapshot: RoomSnapshot;
  busy: boolean;
  onDeleteTail: () => void;
  onRegenerateTail: () => void;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  const messages = snapshot.messages.filter(message => message.lifecycle === "active");
  const workspaceRevision = snapshot.artifacts
    .map(artifact => `${artifact.id}:${artifact.updatedAt}`)
    .join("|");
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);
  return (
    <div className="conversation-scroll">
      <div className="day-divider"><span>Today</span></div>
      {messages.map((message, index) => {
        const isHuman = message.authorType === "human";
        const agent = snapshot.agents.find(candidate => candidate.id === message.authorId);
        const generation = generationFor(snapshot, message);
        const isTail = index === messages.length - 1 && !isHuman && message.status !== "streaming";
        return (
          <article
            className={`message ${isHuman ? "human-message" : "agent-message"}`}
            key={message.id}
          >
            <div
              className={`avatar ${isHuman ? "human-avatar" : ""}`}
              style={isHuman ? undefined : { background: agentColor(snapshot, message.authorId) }}
            >
              {isHuman ? "You" : initials(agent?.name ?? message.authorId)}
            </div>
            <div className="message-body">
              <header>
                <strong>{isHuman ? "You" : agent?.name ?? message.authorId}</strong>
                <span>{formatTime(message.createdAt)}</span>
                {message.replyToMessageId && <span className="reply-label">reply</span>}
                {message.status === "streaming" && <LoaderCircle size={13} className="spin" />}
              </header>
              <div className="message-copy">
                {message.content || <span className="thinking">Gathering a thought…</span>}
              </div>
              {generation && (
                <MessageDetails
                  generation={generation}
                  workspaceRevision={workspaceRevision}
                />
              )}
              {isTail && (
                <div className="tail-actions">
                  <button onClick={onRegenerateTail} disabled={busy}>
                    <RotateCcw size={12} /> Regenerate
                  </button>
                  <button onClick={onDeleteTail} disabled={busy}>
                    <X size={12} /> Remove
                  </button>
                </div>
              )}
            </div>
          </article>
        );
      })}
      <div ref={bottom} />
    </div>
  );
}

function WorkspacePanel({ snapshot, onChanged }: {
  snapshot: RoomSnapshot;
  onChanged: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkspaceSearchResult[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [retryingId, setRetryingId] = useState<string>();
  const [deletingId, setDeletingId] = useState<string>();
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string>();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const dragDepth = useRef(0);

  function showError(errorValue: unknown) {
    setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
  }

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    setError(undefined);
    try {
      for (const file of files) {
        await api.upload(snapshot.room.id, file);
      }
      await onChanged();
    } catch (errorValue) {
      showError(errorValue);
    } finally {
      setUploading(false);
    }
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setError(undefined);
    try {
      setResults(await api.search(snapshot.room.id, query.trim()));
    } catch (errorValue) {
      showError(errorValue);
    }
  }

  async function retryArtifact(artifactId: string) {
    setRetryingId(artifactId);
    setError(undefined);
    try {
      await api.retryArtifact(snapshot.room.id, artifactId);
    } catch (errorValue) {
      showError(errorValue);
    } finally {
      await onChanged().catch(showError);
      setRetryingId(undefined);
    }
  }

  async function deleteArtifact(artifactId: string) {
    setDeletingId(artifactId);
    setError(undefined);
    try {
      await api.deleteArtifact(snapshot.room.id, artifactId);
      setResults(current => current.filter(result =>
        result.artifact.id !== artifactId
      ));
      setConfirmingDeleteId(undefined);
      await onChanged();
    } catch (errorValue) {
      showError(errorValue);
    } finally {
      setDeletingId(undefined);
    }
  }

  async function addNote(event: FormEvent) {
    event.preventDefault();
    if (!note.trim()) return;
    setError(undefined);
    try {
      await api.addNote(snapshot.room.id, note.trim(), "working");
      setNote("");
      await onChanged();
    } catch (errorValue) {
      showError(errorValue);
    }
  }

  return (
    <aside
      className={`left-panel ${dragActive ? "drag-active" : ""}`}
      onDragEnter={event => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragActive(true);
      }}
      onDragOver={event => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={event => {
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragActive(false);
      }}
      onDrop={event => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragActive(false);
        void uploadFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {dragActive && (
        <div className="table-drop-overlay" role="status">
          <Upload size={24} />
          <strong>Drop files on the table</strong>
          <span>Markdown, text, and PDF</span>
        </div>
      )}
      <div className="panel-title">
        <span><PanelLeft size={16} /> The table</span>
        <label className="icon-button upload-button" title="Upload document">
          {uploading ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}
          <input
            type="file"
            accept=".md,.markdown,.txt,.pdf,text/plain,text/markdown,application/pdf"
            disabled={uploading}
            onChange={event => {
              const input = event.currentTarget;
              const file = input.files?.[0];
              if (file) void uploadFiles([file]).finally(() => {
                input.value = "";
              });
            }}
          />
        </label>
      </div>
      <form className="workspace-search" onSubmit={search}>
        <Search size={14} />
        <input
          placeholder="Search the table"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
      </form>
      {error && <div className="settings-error" role="alert">{error}</div>}
      {results.length > 0 && (
        <div className="search-results">
          <div className="section-label">Search results</div>
          {results.slice(0, 4).map(result => (
            <div className="search-result" key={result.chunk.id}>
              <strong>{result.artifact.filename}</strong>
              <span>{result.chunk.text.slice(0, 110)}…</span>
              <code>{result.citation}</code>
            </div>
          ))}
        </div>
      )}
      <div className="section-label">Documents · {snapshot.artifacts.length}</div>
      <div className="artifact-list">
        {snapshot.artifacts.length === 0 && (
          <div className="empty-mini">
            <FileText size={22} />
            <span>Drop the first document on the table.</span>
          </div>
        )}
        {snapshot.artifacts.map(artifact => {
          const retrying = retryingId === artifact.id;
          const deleting = deletingId === artifact.id;
          const busy = retryingId !== undefined || deletingId !== undefined;
          const confirming = confirmingDeleteId === artifact.id;
          return (
            <div className="artifact" key={artifact.id}>
              <div className="file-icon"><FileText size={16} /></div>
              <div className="artifact-copy">
                <strong>{artifact.filename}</strong>
                <span>{artifact.error ?? artifact.summary}</span>
                <small className={`status-${artifact.ingestionStatus}`}>
                  {artifact.ingestionStatus}
                </small>
              </div>
              {!confirming && (
                <div className="artifact-actions">
                  {artifact.ingestionStatus === "failed" && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Retry ${artifact.filename}`}
                      title="Retry ingestion"
                      disabled={busy}
                      onClick={() => void retryArtifact(artifact.id)}
                    >
                      {retrying
                        ? <LoaderCircle size={13} className="spin" />
                        : <RotateCcw size={13} />}
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button danger-icon"
                    aria-label={`Delete ${artifact.filename}`}
                    title="Delete file"
                    disabled={busy}
                    onClick={() => setConfirmingDeleteId(artifact.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
              {confirming && (
                <div
                  className="artifact-delete-confirmation"
                  role="group"
                  aria-label={`Delete ${artifact.filename}?`}
                >
                  <span>Remove this file, its index, and its citations?</span>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={deleting}
                    onClick={() => setConfirmingDeleteId(undefined)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    disabled={deleting}
                    onClick={() => void deleteArtifact(artifact.id)}
                  >
                    {deleting
                      ? <LoaderCircle size={13} className="spin" />
                      : <Trash2 size={13} />}
                    Confirm
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="scratchpad">
        <div className="section-label">
          Shared scratchpad · {snapshot.notes.filter(item => !item.archivedAt).length}
        </div>
        {snapshot.notes.filter(item => !item.archivedAt).map(item => (
          <div className="note" key={item.id}>
            <Sparkles size={13} />
            <span>{item.text}</span>
          </div>
        ))}
        <form onSubmit={addNote}>
          <input
            value={note}
            onChange={event => setNote(event.target.value)}
            placeholder="Pin a constraint or question…"
          />
          <button disabled={!note.trim()}><Plus size={14} /></button>
        </form>
      </div>
    </aside>
  );
}

function AddAgent({ roomId, onAdded, onClose }: {
  roomId: string;
  onAdded: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<VoiceTemplateInput>(blankVoiceTemplate);
  const [templates, setTemplates] = useState<VoiceTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [capabilities, setCapabilities] = useState<ModelCapabilities>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const nextTemplates = await api.listVoiceTemplates();
        if (cancelled) return;
        setTemplates(nextTemplates);
        const defaultModel = await api.getDefaultModel();
        if (cancelled) return;
        if (defaultModel) {
          setDraft(current => current.modelId
            ? current
            : {
                ...current,
                provider: defaultModel.provider,
                modelId: defaultModel.modelId
              });
        }
      } catch (errorValue) {
        if (!cancelled) {
          setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function update<Key extends keyof VoiceTemplateInput>(
    key: Key,
    value: VoiceTemplateInput[Key]
  ) {
    setDraft(current => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    const id = `${draft.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${Date.now().toString(36)}`;
    const result = agentDefinitionSchema.safeParse({
      id,
      ...(templateId ? { voiceTemplateId: templateId } : {}),
      name: draft.name,
      description: draft.description,
      provider: draft.provider,
      modelId: draft.modelId,
      systemPrompt: draft.systemPrompt,
      ...(draft.personaPrompt ? { personaPrompt: draft.personaPrompt } : {}),
      temperature: draft.temperature,
      ...(draft.topP === undefined ? {} : { topP: draft.topP }),
      maxOutputTokens: draft.maxOutputTokens,
      reasoning: draft.reasoning,
      tools: [...draft.tools],
      contextBudget: { ...draft.contextBudget },
      ...(capabilities === undefined ? {} : { capabilities })
    });
    if (!result.success) {
      setError(validationMessage("Cannot add participant", result.error));
      return;
    }
    setSaving(true);
    try {
      await api.addAgent(roomId, result.data);
      onAdded();
      onClose();
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <form className="agent-modal agent-modal-wide" noValidate onSubmit={submit}>
        <header>
          <div><Bot size={18} /> Add a voice</div>
          <button type="button" className="icon-button" onClick={onClose}><X size={16} /></button>
        </header>
        <label>Voice template
          <select
            name="voiceTemplate"
            value={templateId}
            onChange={event => {
              const nextId = event.target.value;
              setTemplateId(nextId);
              const template = templates.find(item => item.id === nextId);
              if (template) setDraft(voiceTemplateInput(template));
            }}
          >
            <option value="">Start with a blank voice</option>
            {templates.map(template => (
              <option value={template.id} key={template.id}>
                {template.title} · {template.name}
              </option>
            ))}
          </select>
        </label>
        <label>Name
          <input
            name="voiceName"
            required
            value={draft.name}
            onChange={event => update("name", event.target.value)}
            placeholder="Systems Engineer"
          />
        </label>
        <label>Point of view
          <input
            value={draft.description}
            onChange={event => update("description", event.target.value)}
            placeholder="Finds durable seams and failure modes."
          />
        </label>
        <div className="field-row">
          <label>Provider
            <select
              value={draft.provider}
              onChange={event => {
                update(
                  "provider",
                  event.target.value as AgentDefinition["provider"]
                );
                update("modelId", "");
                setCapabilities(undefined);
              }}
            >
              <option value="openrouter">OpenRouter</option>
              <option value="ollama">Ollama</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
          </label>
          <label>Model
            <ModelPicker
              provider={draft.provider}
              value={draft.modelId}
              onChange={modelId => update("modelId", modelId)}
              onCapabilities={setCapabilities}
            />
          </label>
        </div>
        <label>System prompt
          <textarea
            name="systemPrompt"
            value={draft.systemPrompt}
            onChange={event => update("systemPrompt", event.target.value)}
            rows={4}
          />
        </label>
        <label>Persona prompt
          <textarea
            value={draft.personaPrompt ?? ""}
            onChange={event => update("personaPrompt", event.target.value)}
            rows={2}
            placeholder="Short stylistic direction for this voice."
          />
        </label>
        {error && <div className="settings-error" role="alert">{error}</div>}
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
          <button
            className="primary-button"
            disabled={saving}
          >
            {saving ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}
            Add participant
          </button>
        </footer>
      </form>
    </div>
  );
}

function ParticipantsPanel({ snapshot, busy, onAction, onAdd, onRemove }: {
  snapshot: RoomSnapshot;
  busy: boolean;
  onAction: (action: () => Promise<unknown>) => void;
  onAdd: () => void;
  onRemove: (agentId: string) => Promise<boolean>;
}) {
  const [confirmingRemovalId, setConfirmingRemovalId] = useState<string>();
  const [removingId, setRemovingId] = useState<string>();
  return (
    <aside className="right-panel">
      <div className="panel-title">
        <span><Users size={16} /> In the room</span>
        <button className="icon-button" onClick={onAdd} disabled={busy} aria-label="Add voice">
          <Plus size={15} />
        </button>
      </div>
      <div className="participant-list">
        {snapshot.agents.length === 0 && (
          <div className="empty-mini"><Users size={22} /><span>Add three to five distinct voices.</span></div>
        )}
        {snapshot.agents.map((agent, index) => {
          const runtime = snapshot.runtime.find(state => state.agentId === agent.id);
          const generating = snapshot.generations.some(
            generation => generation.agentId === agent.id && generation.status === "streaming"
          );
          const activation = snapshot.activations.find(item => item.agentId === agent.id);
          return (
            <div className="participant" key={agent.id}>
              <div className="participant-head">
                <div className="avatar small" style={{ background: participantColors[index % participantColors.length] }}>
                  {initials(agent.name)}
                </div>
                <div>
                  <strong>{agent.name}</strong>
                  <span>{agent.modelId.split("/").at(-1)}</span>
                </div>
                <span className={`presence ${generating ? "speaking" : ""}`} />
              </div>
              <p>{agent.description || "A distinct room participant."}</p>
              {activation?.decision.reason && (
                <div className="activation-reason" title={`Activation score ${activation.score.toFixed(2)}`}>
                  <BrainCircuit size={11} />
                  <span>{activation.decision.reason}</span>
                </div>
              )}
              <div className="fatigue-row">
                <Gauge size={12} />
                <span>Fatigue</span>
                <div className="fatigue-track">
                  <i style={{ width: `${Math.round((runtime?.fatigue ?? 0) * 100)}%` }} />
                </div>
                <b>{Math.round((runtime?.fatigue ?? 0) * 100)}%</b>
              </div>
              <div className="participant-actions">
                <button
                  className="participant-remove"
                  title={`Remove ${agent.name} from room`}
                  aria-label={`Remove ${agent.name} from room`}
                  disabled={removingId !== undefined}
                  onClick={() => setConfirmingRemovalId(agent.id)}
                >
                  <Trash2 size={13} /> Remove
                </button>
                <button
                  disabled={busy}
                  title={runtime?.muted ? "Unmute" : "Mute"}
                  onClick={() => onAction(() =>
                    api.mute(snapshot.room.id, agent.id, !(runtime?.muted ?? false))
                  )}
                >
                  {runtime?.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                </button>
                <button
                  disabled={busy || generating || runtime?.muted}
                  onClick={() => onAction(() =>
                    api.selectSpeaker(snapshot.room.id, agent.id)
                  )}
                >
                  <Mic2 size={13} /> Invite
                </button>
              </div>
              {confirmingRemovalId === agent.id && (
                <div className="participant-remove-confirmation" role="group" aria-label={`Remove ${agent.name}?`}>
                  <span>Remove from this room?</span>
                  <button
                    className="secondary-button"
                    disabled={removingId !== undefined}
                    onClick={() => setConfirmingRemovalId(undefined)}
                  >
                    Cancel
                  </button>
                  <button
                    className="danger-button"
                    disabled={removingId !== undefined}
                    onClick={() => {
                      setRemovingId(agent.id);
                      void onRemove(agent.id).then(removed => {
                        if (removed) setConfirmingRemovalId(undefined);
                      }).finally(() => {
                        setRemovingId(undefined);
                      });
                    }}
                  >
                    {removingId === agent.id
                      ? <LoaderCircle size={13} className="spin" />
                      : <Trash2 size={13} />}
                    Remove
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="room-meter">
        <span>Room pressure</span>
        <div><i style={{ width: `${Math.min(100, snapshot.messages.filter(message =>
          message.authorType === "agent" && message.lifecycle === "active"
        ).length * 8)}%` }} /></div>
        <small>Soft pacing protects the conversation from runaway loops.</small>
      </div>
    </aside>
  );
}

function RoomManager({
  rooms,
  currentRoomId,
  errorMessage,
  onSwitch,
  onCreate,
  onDelete,
  onClose
}: {
  rooms: Room[];
  currentRoomId: string;
  errorMessage?: string;
  onSwitch: (roomId: string) => Promise<boolean>;
  onCreate: (title: string) => Promise<boolean>;
  onDelete: (roomId: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [switchingId, setSwitchingId] = useState<string>();
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string>();
  const [deletingId, setDeletingId] = useState<string>();
  const [error, setError] = useState<string>();
  const operationPending = creating || switchingId !== undefined || deletingId !== undefined;
  const operationPendingRef = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!operationPendingRef.current) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []).filter(element => !element.hidden);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleDialogKeys);
    return () => document.removeEventListener("keydown", handleDialogKeys);
  }, [onClose]);

  useEffect(() => {
    if (!confirmingDeleteId) return;
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLButtonElement>(
        ".room-delete-confirmation button"
      )?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [confirmingDeleteId]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (operationPendingRef.current) return;
    const nextTitle = title.trim();
    if (!nextTitle) {
      setError("Enter a room name before creating it.");
      return;
    }
    operationPendingRef.current = true;
    setCreating(true);
    setError(undefined);
    try {
      if (await onCreate(nextTitle)) onClose();
    } finally {
      operationPendingRef.current = false;
      setCreating(false);
    }
  }

  async function switchTo(roomId: string) {
    if (operationPendingRef.current) return;
    operationPendingRef.current = true;
    setSwitchingId(roomId);
    setError(undefined);
    try {
      if (await onSwitch(roomId)) onClose();
    } finally {
      operationPendingRef.current = false;
      setSwitchingId(undefined);
    }
  }

  async function remove(roomId: string) {
    if (operationPendingRef.current) return;
    operationPendingRef.current = true;
    setDeletingId(roomId);
    setError(undefined);
    try {
      const deleted = await onDelete(roomId);
      if (deleted) {
        setConfirmingDeleteId(undefined);
        if (roomId === currentRoomId) onClose();
      }
    } finally {
      operationPendingRef.current = false;
      setDeletingId(undefined);
    }
  }

  return (
    <div className="modal-backdrop room-manager-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget && !operationPendingRef.current) onClose();
    }}>
      <section ref={dialogRef} className="room-manager-modal" role="dialog" aria-modal="true" aria-labelledby="rooms-heading">
        <header>
          <div>
            <span className="eyebrow">Persistent workspaces</span>
            <h2 id="rooms-heading">Rooms</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              if (!operationPendingRef.current) onClose();
            }}
            aria-label="Close rooms"
            disabled={operationPending}
          >
            <X size={16} />
          </button>
        </header>
        <form className="room-create-form" onSubmit={create} noValidate>
          <label>Create a room
            <input
              value={title}
              onChange={event => {
                setTitle(event.target.value);
                setError(undefined);
              }}
              placeholder="Architecture workshop"
              autoFocus
            />
          </label>
          <button className="primary-button" disabled={operationPending}>
            {creating ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}
            Create room
          </button>
        </form>
        {(error ?? errorMessage) && (
          <div className="settings-error" role="alert">
            {error ?? errorMessage}
          </div>
        )}
        <div className="room-list" aria-label="Existing rooms">
          {rooms.map(room => {
            const current = room.id === currentRoomId;
            const confirming = confirmingDeleteId === room.id;
            return (
              <article className={current ? "current" : ""} key={room.id}>
                <div className="room-list-copy">
                  <strong>{room.title}</strong>
                  <span>{current ? "Current room" : room.status === "paused" ? "Paused" : "Available"}</span>
                </div>
                {!confirming && (
                  <div className="room-list-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={current || operationPending}
                      onClick={() => void switchTo(room.id)}
                      aria-label={`Switch to ${room.title}`}
                    >
                      {switchingId === room.id
                        ? <LoaderCircle size={13} className="spin" />
                        : <MessageSquareText size={13} />}
                      {current ? "Current" : "Switch"}
                    </button>
                    <button
                      type="button"
                      className="danger-button"
                      disabled={operationPending}
                      onClick={() => setConfirmingDeleteId(room.id)}
                      aria-label={`Delete room ${room.title}`}
                    >
                      <Trash2 size={13} /> Delete
                    </button>
                  </div>
                )}
                {confirming && (
                  <div className="room-delete-confirmation" role="group" aria-label={`Delete ${room.title}?`}>
                    <span>Delete this room and its transcript?</span>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={operationPending}
                      onClick={() => setConfirmingDeleteId(undefined)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="danger-button"
                      disabled={operationPending}
                      onClick={() => void remove(room.id)}
                    >
                      {deletingId === room.id
                        ? <LoaderCircle size={13} className="spin" />
                        : <Trash2 size={13} />}
                      Confirm delete
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function EmptyRoom({ onCreate }: { onCreate: (title: string) => void }) {
  const [title, setTitle] = useState("New writers' room");
  return (
    <main className="welcome">
      <div className="brand-mark"><MessageSquareText size={28} /></div>
      <span className="eyebrow">A persistent, multi-model studio</span>
      <h1>Pull up a chair.</h1>
      <p>Put an idea on the table and let independently configured models challenge, extend, and connect it.</p>
      <form onSubmit={event => {
        event.preventDefault();
        onCreate(title);
      }}>
        <input value={title} onChange={event => setTitle(event.target.value)} />
        <button className="primary-button"><Plus size={16} /> Create room</button>
      </form>
    </main>
  );
}

export default function App() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomId, setRoomId] = useState<string>();
  const [snapshot, setSnapshot] = useState<RoomSnapshot>();
  const [composer, setComposer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [showAgent, setShowAgent] = useState(false);
  const [showRooms, setShowRooms] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmingChatReset, setConfirmingChatReset] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const latestSequenceRef = useRef(0);
  const refreshRequestRef = useRef(0);
  const activeRoomIdRef = useRef<string | undefined>(undefined);
  const roomPickerRef = useRef<HTMLButtonElement>(null);
  latestSequenceRef.current = snapshot && snapshot.room.id === roomId
    ? snapshot.latestSequence
    : 0;

  const refresh = useCallback(async (selectedRoomId?: string) => {
    const activeRoomIdAtStart = activeRoomIdRef.current;
    if (
      selectedRoomId !== undefined &&
      selectedRoomId !== activeRoomIdAtStart
    ) return;
    const requestId = ++refreshRequestRef.current;
    const id = selectedRoomId ?? activeRoomIdAtStart;
    const nextRooms = await api.listRooms();
    const resolved = id ?? nextRooms[0]?.id;
    const nextSnapshot = resolved ? await api.snapshot(resolved) : undefined;
    if (
      requestId !== refreshRequestRef.current ||
      activeRoomIdRef.current !== activeRoomIdAtStart
    ) return;
    setRooms(nextRooms);
    if (resolved && nextSnapshot) {
      activeRoomIdRef.current = resolved;
      setRoomId(resolved);
      setSnapshot(nextSnapshot);
    } else {
      activeRoomIdRef.current = undefined;
      setRoomId(undefined);
      setSnapshot(undefined);
    }
  }, []);

  useEffect(() => {
    void refresh().catch(errorValue => setError(String(errorValue)));
  }, []);

  useEffect(() => {
    if (!roomId) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let disposed = false;
    let refreshTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let socket: WebSocket | undefined;

    function connect() {
      if (disposed) return;
      socket = new WebSocket(
        `${protocol}//${location.host}/api/v1/rooms/${roomId}/stream?after=${latestSequenceRef.current}`
      );
      socket.onmessage = () => {
        if (activeRoomIdRef.current !== roomId) return;
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => {
          if (disposed || activeRoomIdRef.current !== roomId) return;
          void refresh(roomId).catch(errorValue => setError(String(errorValue)));
        }, 80);
      };
      socket.onclose = () => {
        if (!disposed) reconnectTimer = window.setTimeout(connect, 1_000);
      };
    }

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(refreshTimer);
      window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [roomId]);

  const mentions = useMemo(() => {
    if (!snapshot) return [];
    const content = composer.toLowerCase();
    const mentioned = new Set<string>();
    for (let index = content.indexOf("@"); index >= 0; index = content.indexOf("@", index + 1)) {
      const match = [...snapshot.agents]
        .sort((left, right) => right.name.length - left.name.length)
        .find(agent => {
          const token = `@${agent.name.toLowerCase()}`;
          if (!content.startsWith(token, index)) return false;
          const following = content[index + token.length];
          return following === undefined || /\s|[.,!?;:()[\]{}]/.test(following);
        });
      if (match) mentioned.add(match.id);
    }
    return [...mentioned];
  }, [composer, snapshot]);

  const mentionSuggestions = useMemo(() => {
    if (!snapshot) return [];
    const match = composer.match(/(?:^|\s)@([^@\n]*)$/);
    if (!match) return [];
    const query = (match[1] ?? "").trim().toLowerCase();
    return snapshot.agents.filter(agent =>
      agent.name.toLowerCase().includes(query)
    );
  }, [composer, snapshot]);

  function insertMention(agent: AgentDefinition) {
    setComposer(current => {
      const match = current.match(/(?:^|\s)@([^@\n]*)$/);
      if (!match || match.index === undefined) return `${current}@${agent.name} `;
      const atIndex = current.indexOf("@", match.index);
      return `${current.slice(0, atIndex)}@${agent.name} `;
    });
    setMentionIndex(0);
  }

  async function runRoomAction(
    action: () => Promise<unknown>,
    trackBusy = true
  ): Promise<boolean> {
    if (trackBusy) setBusy(true);
    setError(undefined);
    try {
      await action();
      await refresh(activeRoomIdRef.current);
      return true;
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
      return false;
    } finally {
      if (trackBusy) setBusy(false);
    }
  }

  async function createRoom(title: string): Promise<boolean> {
    setError(undefined);
    try {
      const room = await api.createRoom(title);
      activeRoomIdRef.current = room.id;
      await refresh(room.id);
      return true;
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
      return false;
    }
  }

  async function switchRoom(nextRoomId: string): Promise<boolean> {
    setError(undefined);
    const previousRoomId = activeRoomIdRef.current;
    activeRoomIdRef.current = nextRoomId;
    try {
      await refresh(nextRoomId);
      return true;
    } catch (errorValue) {
      activeRoomIdRef.current = previousRoomId;
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
      return false;
    }
  }

  async function deleteRoom(deletedRoomId: string): Promise<boolean> {
    setError(undefined);
    try {
      await api.deleteRoom(deletedRoomId);
      if (activeRoomIdRef.current === deletedRoomId) {
        activeRoomIdRef.current = undefined;
      }
      await refresh(activeRoomIdRef.current);
      return true;
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
      return false;
    }
  }

  const closeRoomManager = useCallback(() => {
    setShowRooms(false);
    window.setTimeout(() => roomPickerRef.current?.focus(), 0);
  }, []);

  if (!snapshot) {
    return (
      <>
        <EmptyRoom onCreate={title => {
          void createRoom(title);
        }} />
        {error && <div className="toast error-toast">{error}</div>}
      </>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><MessageSquareText size={18} /><span>Writers’ Room</span></div>
        <div className="room-switcher">
          <button
            ref={roomPickerRef}
            type="button"
            className="room-picker-button"
            onClick={() => {
              setError(undefined);
              setShowRooms(true);
            }}
            aria-label="Manage rooms"
          >
            <MessageSquareText size={14} />
            <span>{snapshot.room.title}</span>
            <ChevronDown size={14} />
          </button>
          <span className={`room-status ${snapshot.room.status}`} />
        </div>
        <div className="top-controls">
          <button
            className="top-icon-button"
            onClick={() => setShowSettings(true)}
            aria-label="Open settings"
            title="Settings"
          >
            <SettingsIcon size={15} />
          </button>
          <label className="toggle-label">
            Auto
            <button
              className={`toggle ${snapshot.room.settings.autoMode ? "on" : ""}`}
              onClick={() => void runRoomAction(() => api.updateRoom(snapshot.room.id, {
                settings: { autoMode: !snapshot.room.settings.autoMode }
              }))}
              disabled={busy}
            ><i /></button>
          </label>
          <label className="compact-select">
            <Sparkles size={13} />
            <select
              value={snapshot.room.settings.maxResponders}
              onChange={event => void runRoomAction(() => api.updateRoom(snapshot.room.id, {
                settings: { maxResponders: Number(event.target.value) }
              }))}
              disabled={busy}
            >
              <option value={1}>Focused</option>
              <option value={2}>Workshop</option>
              <option value={3}>Writers’ room</option>
            </select>
          </label>
          <button
            className="pause-button"
            onClick={() => void runRoomAction(() => api.updateRoom(snapshot.room.id, {
              status: snapshot.room.status === "running" ? "paused" : "running"
            }))}
            disabled={busy}
          >
            {snapshot.room.status === "running"
              ? <><CirclePause size={15} /> Pause</>
              : <><CirclePlay size={15} /> Resume</>}
          </button>
        </div>
      </header>

      <div className="room-grid">
        <WorkspacePanel
          key={snapshot.room.id}
          snapshot={snapshot}
          onChanged={() => refresh(roomId)}
        />
        <main className="center-panel">
          <div className="conversation-heading">
            <div>
              <span className="eyebrow">Live discussion</span>
              <h1>{snapshot.room.title}</h1>
            </div>
            <div className="run-limits">
              <span>{snapshot.room.settings.maxResponders} responders</span>
              <span>{snapshot.room.settings.maxAutonomousWaves} wave cap</span>
              {confirmingChatReset ? (
                <div className="chat-reset-confirmation" role="group" aria-label="Reset chat?">
                  <span>Clear chat, keep voices and files?</span>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setConfirmingChatReset(false)}
                  >Cancel</button>
                  <button
                    type="button"
                    className="danger-button"
                    disabled={busy}
                    onClick={() => {
                      void runRoomAction(() => api.resetChat(snapshot.room.id)).then(reset => {
                        if (reset) setConfirmingChatReset(false);
                      });
                    }}
                  ><RotateCcw size={12} /> Confirm reset</button>
                </div>
              ) : (
                <button
                  type="button"
                  className="reset-chat-button"
                  disabled={busy || snapshot.messages.length === 0}
                  onClick={() => setConfirmingChatReset(true)}
                ><RotateCcw size={12} /> Reset chat</button>
              )}
            </div>
          </div>
          <Conversation
            snapshot={snapshot}
            busy={busy}
            onDeleteTail={() => void runRoomAction(() => api.deleteTail(snapshot.room.id))}
            onRegenerateTail={() => void runRoomAction(() => api.regenerateTail(snapshot.room.id))}
          />
          <form
            className="composer"
            onSubmit={event => {
              event.preventDefault();
              const content = composer.trim();
              if (!content) return;
              setComposer("");
              void runRoomAction(() => api.sendMessage(snapshot.room.id, content, mentions));
            }}
          >
            {mentionSuggestions.length > 0 && (
              <div className="mention-menu" role="listbox" aria-label="Mention a participant">
                {mentionSuggestions.map((agent, index) => (
                  <button
                    key={agent.id}
                    type="button"
                    role="option"
                    aria-selected={index === mentionIndex}
                    className={index === mentionIndex ? "active" : ""}
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => insertMention(agent)}
                  >
                    <span className="avatar mention-avatar" style={{ background: agentColor(snapshot, agent.id) }}>
                      {initials(agent.name)}
                    </span>
                    <span><strong>{agent.name}</strong><small>{agent.description}</small></span>
                  </button>
                ))}
              </div>
            )}
            <textarea
              value={composer}
              onChange={event => {
                setComposer(event.target.value);
                setMentionIndex(0);
              }}
              placeholder="Put something on the table… Use @ to address a voice directly."
              rows={2}
              onKeyDown={event => {
                if (mentionSuggestions.length > 0 && event.key === "ArrowDown") {
                  event.preventDefault();
                  setMentionIndex(current => (current + 1) % mentionSuggestions.length);
                  return;
                }
                if (mentionSuggestions.length > 0 && event.key === "ArrowUp") {
                  event.preventDefault();
                  setMentionIndex(current =>
                    (current - 1 + mentionSuggestions.length) % mentionSuggestions.length
                  );
                  return;
                }
                if (mentionSuggestions.length > 0 && event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  insertMention(mentionSuggestions[mentionIndex] ?? mentionSuggestions[0]!);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="composer-footer">
              <div>
                <span>Enter to send · Shift+Enter for a new line</span>
              </div>
              <button className="send-button" disabled={!composer.trim() || busy}>
                {busy ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}
              </button>
            </div>
          </form>
        </main>
        <ParticipantsPanel
          snapshot={snapshot}
          busy={busy}
          onAction={action => void runRoomAction(action)}
          onAdd={() => setShowAgent(true)}
          onRemove={agentId => runRoomAction(
            () => api.removeAgent(snapshot.room.id, agentId),
            false
          )}
        />
      </div>
      {showAgent && (
        <AddAgent
          roomId={snapshot.room.id}
          onAdded={() => void refresh(roomId)
            .catch(errorValue => setError(String(errorValue)))}
          onClose={() => setShowAgent(false)}
        />
      )}
      {showRooms && (
        <RoomManager
          rooms={rooms}
          currentRoomId={snapshot.room.id}
          {...(error === undefined ? {} : { errorMessage: error })}
          onSwitch={switchRoom}
          onCreate={createRoom}
          onDelete={deleteRoom}
          onClose={closeRoomManager}
        />
      )}
      {showSettings && (
        <SettingsPage
          room={snapshot.room}
          onRoomChanged={room => {
            setSnapshot(current => current ? { ...current, room } : current);
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
      {error && (
        <div className="toast error-toast">
          <span>{error}</span>
          <button onClick={() => setError(undefined)}><X size={14} /></button>
        </div>
      )}
    </div>
  );
}
