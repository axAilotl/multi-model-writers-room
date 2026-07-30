import {
  Archive,
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
  MoreHorizontal,
  PanelLeft,
  Plus,
  RotateCcw,
  Search,
  Send,
  Sparkles,
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
  Room,
  RoomMessage,
  RoomSnapshot,
  WorkspaceSearchResult
} from "@writers-room/contracts";
import { defaultRoomToolNames } from "@writers-room/contracts";
import { api } from "./api.js";

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

function MessageDetails({ generation }: {
  generation: GenerationRecord;
}) {
  const [open, setOpen] = useState(false);
  const [inspection, setInspection] = useState<Awaited<
    ReturnType<typeof api.inspectGeneration>
  >>();
  useEffect(() => {
    if (!open || inspection) return;
    void api.inspectGeneration(generation.id).then(setInspection);
  }, [open, generation.id, inspection]);
  return (
    <div className="message-details">
      <button className="detail-toggle" onClick={() => setOpen(value => !value)}>
        <BrainCircuit size={13} />
        Inspect
        <ChevronDown size={13} className={open ? "turn" : ""} />
      </button>
      {open && (
        <div className="detail-panel">
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
              <strong>{generation.costUsd == null ? "—" : `$${generation.costUsd.toFixed(4)}`}</strong>
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
  useEffect(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), [messages.length]);
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
              {generation && <MessageDetails generation={generation} />}
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
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkspaceSearchResult[]>([]);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState("");

  async function upload(file: File) {
    setUploading(true);
    try {
      await api.upload(snapshot.room.id, file);
      onChanged();
    } finally {
      setUploading(false);
    }
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setResults(await api.search(snapshot.room.id, query.trim()));
  }

  async function addNote(event: FormEvent) {
    event.preventDefault();
    if (!note.trim()) return;
    await api.addNote(snapshot.room.id, note.trim(), "working");
    setNote("");
    onChanged();
  }

  return (
    <aside className="left-panel">
      <div className="panel-title">
        <span><PanelLeft size={16} /> The table</span>
        <label className="icon-button upload-button" title="Upload document">
          {uploading ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}
          <input
            type="file"
            accept=".md,.markdown,.txt,.pdf,text/plain,text/markdown,application/pdf"
            disabled={uploading}
            onChange={event => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
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
      {results.length > 0 && (
        <div className="search-results">
          <div className="section-label">Search results</div>
          {results.slice(0, 4).map(result => (
            <button className="search-result" key={result.chunk.id}>
              <strong>{result.artifact.filename}</strong>
              <span>{result.chunk.text.slice(0, 110)}…</span>
              <code>{result.citation}</code>
            </button>
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
        {snapshot.artifacts.map(artifact => (
          <div className="artifact" key={artifact.id}>
            <div className="file-icon"><FileText size={16} /></div>
            <div>
              <strong>{artifact.filename}</strong>
              <span>{artifact.summary}</span>
              <small className={`status-${artifact.ingestionStatus}`}>
                {artifact.ingestionStatus}
              </small>
            </div>
            <button className="ghost-button"><MoreHorizontal size={14} /></button>
          </div>
        ))}
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
  const [name, setName] = useState("");
  const [model, setModel] = useState("anthropic/claude-sonnet-4");
  const [provider, setProvider] = useState<AgentDefinition["provider"]>("openrouter");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("Advance the discussion from your distinct expertise.");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${Date.now().toString(36)}`;
      await api.addAgent(roomId, {
        id,
        name,
        description,
        provider,
        modelId: model,
        systemPrompt: prompt,
        temperature: 0.7,
        maxOutputTokens: 1_200,
        reasoning: { enabled: true, effort: "medium", displayMode: "summary" },
        tools: [...defaultRoomToolNames],
        contextBudget: {
          softLimitTokens: 120_000,
          hardLimitTokens: 160_000,
          recentTranscriptTokens: 70_000,
          retrievedContextTokens: 24_000,
          notebookTokens: 0
        }
      });
      onAdded();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <form className="agent-modal" onSubmit={submit}>
        <header>
          <div><Bot size={18} /> Add a voice</div>
          <button type="button" className="icon-button" onClick={onClose}><X size={16} /></button>
        </header>
        <label>Name<input required value={name} onChange={event => setName(event.target.value)} placeholder="Systems Engineer" /></label>
        <label>Point of view<input value={description} onChange={event => setDescription(event.target.value)} placeholder="Finds durable seams and failure modes." /></label>
        <div className="field-row">
          <label>Provider
            <select value={provider} onChange={event => setProvider(event.target.value as AgentDefinition["provider"])}>
              <option value="openrouter">OpenRouter</option>
              <option value="ollama">Ollama</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
          </label>
          <label>Model<input required value={model} onChange={event => setModel(event.target.value)} /></label>
        </div>
        <label>System prompt<textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={4} /></label>
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={saving || !name.trim()}>
            {saving ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}
            Add participant
          </button>
        </footer>
      </form>
    </div>
  );
}

function ParticipantsPanel({ snapshot, onChanged, onAdd }: {
  snapshot: RoomSnapshot;
  onChanged: () => void;
  onAdd: () => void;
}) {
  return (
    <aside className="right-panel">
      <div className="panel-title">
        <span><Users size={16} /> In the room</span>
        <button className="icon-button" onClick={onAdd}><Plus size={15} /></button>
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
                  title={runtime?.muted ? "Unmute" : "Mute"}
                  onClick={() => void api.mute(snapshot.room.id, agent.id, !(runtime?.muted ?? false)).then(onChanged)}
                >
                  {runtime?.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                </button>
                <button
                  disabled={generating || runtime?.muted}
                  onClick={() => void api.selectSpeaker(snapshot.room.id, agent.id).then(onChanged)}
                >
                  <Mic2 size={13} /> Invite
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="room-meter">
        <span>Room pressure</span>
        <div><i style={{ width: `${Math.min(100, snapshot.messages.filter(message => message.authorType === "agent").length * 8)}%` }} /></div>
        <small>Soft pacing protects the conversation from runaway loops.</small>
      </div>
    </aside>
  );
}

function EmptyRoom({ onCreate }: { onCreate: (title: string) => Promise<void> }) {
  const [title, setTitle] = useState("New writers' room");
  return (
    <main className="welcome">
      <div className="brand-mark"><MessageSquareText size={28} /></div>
      <span className="eyebrow">A persistent, multi-model studio</span>
      <h1>Pull up a chair.</h1>
      <p>Put an idea on the table and let independently configured models challenge, extend, and connect it.</p>
      <form onSubmit={event => {
        event.preventDefault();
        void onCreate(title);
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

  const refresh = useCallback(async (selectedRoomId?: string) => {
    const id = selectedRoomId ?? roomId;
    const nextRooms = await api.listRooms();
    setRooms(nextRooms);
    const resolved = id ?? nextRooms[0]?.id;
    if (resolved) {
      setRoomId(resolved);
      setSnapshot(await api.snapshot(resolved));
    }
  }, [roomId]);

  useEffect(() => {
    void refresh().catch(errorValue => setError(String(errorValue)));
  }, []);

  useEffect(() => {
    if (!roomId) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const after = snapshot?.latestSequence ?? 0;
    const socket = new WebSocket(
      `${protocol}//${location.host}/api/v1/rooms/${roomId}/stream?after=${after}`
    );
    let timer: number | undefined;
    socket.onmessage = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void refresh(roomId).catch(errorValue => setError(String(errorValue)));
      }, 80);
    };
    return () => {
      window.clearTimeout(timer);
      socket.close();
    };
  }, [roomId]);

  const mentions = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.agents
      .filter(agent => composer.toLowerCase().includes(`@${agent.name.toLowerCase()}`))
      .map(agent => agent.id);
  }, [composer, snapshot]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      await refresh(roomId);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      setBusy(false);
    }
  }

  if (!snapshot) {
    return (
      <>
        <EmptyRoom onCreate={async title => {
          const room = await api.createRoom(title);
          await refresh(room.id);
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
          <select value={roomId} onChange={event => void refresh(event.target.value)}>
            {rooms.map(room => <option key={room.id} value={room.id}>{room.title}</option>)}
          </select>
          <span className={`room-status ${snapshot.room.status}`} />
        </div>
        <div className="top-controls">
          <label className="toggle-label">
            Auto
            <button
              className={`toggle ${snapshot.room.settings.autoMode ? "on" : ""}`}
              onClick={() => void act(() => api.updateRoom(snapshot.room.id, {
                settings: { autoMode: !snapshot.room.settings.autoMode }
              }))}
            ><i /></button>
          </label>
          <label className="compact-select">
            <Sparkles size={13} />
            <select
              value={snapshot.room.settings.maxResponders}
              onChange={event => void act(() => api.updateRoom(snapshot.room.id, {
                settings: { maxResponders: Number(event.target.value) }
              }))}
            >
              <option value={1}>Focused</option>
              <option value={2}>Workshop</option>
              <option value={3}>Writers’ room</option>
            </select>
          </label>
          <button
            className="pause-button"
            onClick={() => void act(() => api.updateRoom(snapshot.room.id, {
              status: snapshot.room.status === "running" ? "paused" : "running"
            }))}
          >
            {snapshot.room.status === "running"
              ? <><CirclePause size={15} /> Pause</>
              : <><CirclePlay size={15} /> Resume</>}
          </button>
        </div>
      </header>

      <div className="room-grid">
        <WorkspacePanel snapshot={snapshot} onChanged={() => void refresh(roomId)} />
        <main className="center-panel">
          <div className="conversation-heading">
            <div>
              <span className="eyebrow">Live discussion</span>
              <h1>{snapshot.room.title}</h1>
            </div>
            <div className="run-limits">
              <span>{snapshot.room.settings.maxResponders} responders</span>
              <span>{snapshot.room.settings.maxAutonomousWaves} wave cap</span>
            </div>
          </div>
          <Conversation
            snapshot={snapshot}
            busy={busy}
            onDeleteTail={() => void act(() => api.deleteTail(snapshot.room.id))}
            onRegenerateTail={() => void act(() => api.regenerateTail(snapshot.room.id))}
          />
          <form
            className="composer"
            onSubmit={event => {
              event.preventDefault();
              const content = composer.trim();
              if (!content) return;
              setComposer("");
              void act(() => api.sendMessage(snapshot.room.id, content, mentions));
            }}
          >
            <textarea
              value={composer}
              onChange={event => setComposer(event.target.value)}
              placeholder="Put something on the table…"
              rows={2}
              onKeyDown={event => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="composer-footer">
              <div>
                <button type="button" title="Reference a document"><Archive size={15} /></button>
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
          onChanged={() => void refresh(roomId)}
          onAdd={() => setShowAgent(true)}
        />
      </div>
      {showAgent && (
        <AddAgent
          roomId={snapshot.room.id}
          onAdded={() => void refresh(roomId)}
          onClose={() => setShowAgent(false)}
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
