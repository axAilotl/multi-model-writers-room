import { Check, KeyRound, LoaderCircle, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  AgentDefinition,
  DefaultModelSelection,
  ProviderConnectionStatus
} from "@writers-room/contracts";
import { PSFN_DEFAULT_CONTEXT_LENGTH } from "@writers-room/contracts";
import { api } from "./api.js";
import { providerLabels } from "./provider-labels.js";
import {
  useFilteredModels,
  useProviderModels
} from "./use-provider-models.js";

const defaultBaseUrls: Partial<Record<AgentDefinition["provider"], string>> = {
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://127.0.0.1:11434/v1"
};

function connectionDescription(connection: ProviderConnectionStatus | undefined): string {
  if (!connection?.configured) return "No connection has been configured.";
  const endpoint = {
    settings: "saved locally",
    environment: "server environment",
    "built-in": "built-in local default",
    runtime: "running server",
    none: "not configured"
  }[connection.endpointSource];
  const credential = {
    settings: "saved locally",
    environment: "server environment",
    runtime: "running server",
    none: "none"
  }[connection.credentialSource];
  return `Endpoint: ${endpoint}. Credential: ${credential}.`;
}

export function ProviderSettings() {
  const [connections, setConnections] = useState<ProviderConnectionStatus[]>([]);
  const [selected, setSelected] =
    useState<AgentDefinition["provider"]>("openrouter");
  const [query, setQuery] = useState("");
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrls.openrouter ?? "");
  const [apiKey, setApiKey] = useState("");
  const [sessionMode, setSessionMode] = useState<"fixed" | "header">("header");
  const [expectedCompanionId, setExpectedCompanionId] = useState("");
  const [contextLength, setContextLength] = useState(PSFN_DEFAULT_CONTEXT_LENGTH);
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(false);
  const [defaultModel, setDefaultModel] = useState<DefaultModelSelection>();
  const [savingDefaultId, setSavingDefaultId] = useState<string>();
  const [savingConnection, setSavingConnection] = useState(false);
  const [removingConnection, setRemovingConnection] = useState(false);
  const [connectionSaved, setConnectionSaved] = useState(false);
  const [settingsError, setSettingsError] = useState<string>();
  const connection = connections.find(candidate => candidate.provider === selected);
  const { models, loading, error, refresh } = useProviderModels(
    selected,
    connection?.configured === true
  );

  useEffect(() => {
    let active = true;
    void Promise.all([api.listProviderConnections(), api.getDefaultModel()])
      .then(([nextConnections, savedDefault]) => {
        if (!active) return;
        setConnections(nextConnections);
        setDefaultModel(savedDefault);
        const openRouter = nextConnections.find(candidate =>
          candidate.provider === "openrouter"
        );
        if (!openRouter?.configured) {
          const firstConfigured = nextConnections.find(candidate => candidate.configured);
          if (firstConfigured) setSelected(firstConfigured.provider);
        }
      })
      .catch(errorValue => {
        if (active) {
          setSettingsError(
            errorValue instanceof Error ? errorValue.message : String(errorValue)
          );
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setBaseUrl(connection?.baseUrl ?? defaultBaseUrls[selected] ?? "");
    setApiKey("");
    setSessionMode(connection?.sessionMode ?? "header");
    setExpectedCompanionId(connection?.expectedCompanionId ?? "");
    setContextLength(connection?.contextLength ?? PSFN_DEFAULT_CONTEXT_LENGTH);
    setAllowInsecureHttp(connection?.baseUrl?.startsWith("http://") ?? false);
    setConnectionSaved(false);
    setSettingsError(undefined);
  }, [connection?.baseUrl, connection?.contextLength, connection?.expectedCompanionId, connection?.sessionMode, selected]);

  function replaceConnection(next: ProviderConnectionStatus) {
    setConnections(current => current.some(candidate => candidate.provider === next.provider)
      ? current.map(candidate => candidate.provider === next.provider ? next : candidate)
      : [...current, next]);
  }

  async function saveConnection(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingConnection(true);
    setConnectionSaved(false);
    setSettingsError(undefined);
    try {
      const next = await api.configureProvider(selected, {
        ...(selected === "openrouter" ? {} : { baseUrl }),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(selected === "psfn" ? {
          sessionMode,
          ...(expectedCompanionId.trim()
            ? { expectedCompanionId: expectedCompanionId.trim() }
            : {}),
          contextLength,
          allowInsecureHttp
        } : {})
      });
      replaceConnection(next);
      setBaseUrl(next.baseUrl ?? "");
      setApiKey("");
      setConnectionSaved(true);
      refresh();
    } catch (errorValue) {
      setSettingsError(
        errorValue instanceof Error ? errorValue.message : String(errorValue)
      );
      if (selected === "psfn") {
        void api.listProviderConnections().then(nextConnections => {
          setConnections(nextConnections);
        }).catch(() => undefined);
      }
    } finally {
      setSavingConnection(false);
    }
  }

  async function testConnection(acceptIdentityChange = false) {
    setSavingConnection(true);
    setConnectionSaved(false);
    setSettingsError(undefined);
    try {
      const next = await api.testProviderConnection(selected, acceptIdentityChange);
      replaceConnection(next);
      setExpectedCompanionId(next.expectedCompanionId ?? "");
      setConnectionSaved(true);
      refresh();
    } catch (errorValue) {
      setSettingsError(
        errorValue instanceof Error ? errorValue.message : String(errorValue)
      );
      if (selected === "psfn") {
        void api.listProviderConnections().then(nextConnections => {
          setConnections(nextConnections);
        }).catch(() => undefined);
      }
    } finally {
      setSavingConnection(false);
    }
  }

  async function removeConnection() {
    setRemovingConnection(true);
    setConnectionSaved(false);
    setSettingsError(undefined);
    try {
      const next = await api.removeProviderConfiguration(selected);
      replaceConnection(next);
      setBaseUrl(next.baseUrl ?? defaultBaseUrls[selected] ?? "");
      setApiKey("");
      refresh();
    } catch (errorValue) {
      setSettingsError(
        errorValue instanceof Error ? errorValue.message : String(errorValue)
      );
    } finally {
      setRemovingConnection(false);
    }
  }

  async function chooseDefault(modelId: string) {
    setSavingDefaultId(modelId);
    setSettingsError(undefined);
    try {
      setDefaultModel(await api.setDefaultModel({ provider: selected, modelId }));
    } catch (errorValue) {
      setSettingsError(
        errorValue instanceof Error ? errorValue.message : String(errorValue)
      );
    } finally {
      setSavingDefaultId(undefined);
    }
  }

  const visible = useFilteredModels(models, query);
  const endpointChanged = selected !== "openrouter" &&
    connection?.baseUrl !== undefined &&
    baseUrl.replace(/\/+$/, "") !== connection.baseUrl.replace(/\/+$/, "");

  return (
    <section>
      <div className="settings-section-heading">
        <div>
          <span className="eyebrow">Server-side connections</span>
          <h2>Providers & models</h2>
          <p>Add endpoints and credentials here. API keys are stored only by the local server and are never returned to the browser.</p>
        </div>
      </div>
      <div className="default-model-card" aria-live="polite">
        <div>
          <span className="eyebrow">Default fallback model</span>
          {defaultModel ? (
            <strong>
              Current default · {providerLabels[defaultModel.provider]} / {defaultModel.modelId}
            </strong>
          ) : (
            <strong>No fallback selected</strong>
          )}
          <p>Used for generated voice drafts and as the starting model for new voices.</p>
        </div>
      </div>
      <div className="provider-strip">
        {connections.map(status => {
          const provider = status.provider;
          return (
            <button
              key={provider}
              className={selected === provider ? "active" : ""}
              onClick={() => {
                setSelected(provider);
                setQuery("");
              }}
            >
              <span className={status?.configured ? "connected-dot" : "offline-dot"} />
              <strong>{providerLabels[provider]}</strong>
              <small>{status?.configured ? "Configured" : "Not configured"}</small>
            </button>
          );
        })}
      </div>

      <form className="provider-connection-card" onSubmit={event => void saveConnection(event)}>
        <header>
          <div>
            <KeyRound size={15} />
            <span>
              <strong>{providerLabels[selected]} connection</strong>
              <small>{connectionDescription(connection)}</small>
            </span>
          </div>
          {connection?.hasApiKey && <span className="credential-badge"><Check size={11} /> Credential available</span>}
        </header>
        <div className="provider-connection-fields">
          <label>
            Base URL
            <input
              type="url"
              value={baseUrl}
              readOnly={selected === "openrouter"}
              required={selected !== "openrouter"}
              placeholder={selected === "openai-compatible" ? "https://host.example/v1" : undefined}
              onChange={event => setBaseUrl(event.target.value)}
              autoComplete="url"
              spellCheck={false}
            />
          </label>
          <label>
            API key {selected === "openrouter" ? "(required)" : "(optional)"}
            <input
              type="password"
              value={apiKey}
              required={selected === "openrouter" && !connection?.hasApiKey}
              placeholder={
                endpointChanged && connection?.hasApiKey
                  ? "Enter a key for the new endpoint"
                  : connection?.hasApiKey
                    ? "Leave blank to keep the current key"
                    : "Enter API key"
              }
              onChange={event => setApiKey(event.target.value)}
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              spellCheck={false}
            />
            {endpointChanged && connection?.hasApiKey && (
              <small className="credential-guidance">
                The current credential is scoped to the old endpoint and will not be reused.
              </small>
            )}
          </label>
          {selected === "psfn" && (
            <>
              <label>
                Session routing
                <select value={sessionMode} onChange={event => setSessionMode(event.target.value as "fixed" | "header")}>
                  <option value="header">Per-room X-Session-ID</option>
                  <option value="fixed">Shared fixed PSFN session</option>
                </select>
              </label>
              <label>
                Expected companion ID
                <input
                  value={expectedCompanionId}
                  onChange={event => setExpectedCompanionId(event.target.value)}
                  placeholder="Pinned automatically on first successful test"
                  spellCheck={false}
                />
              </label>
              <label>
                Remote model context window
                <input
                  type="number"
                  min={4_096}
                  max={PSFN_DEFAULT_CONTEXT_LENGTH}
                  value={contextLength}
                  onChange={event => setContextLength(Number(event.target.value))}
                />
              </label>
              <label className="provider-checkbox">
                <input
                  type="checkbox"
                  checked={allowInsecureHttp}
                  onChange={event => setAllowInsecureHttp(event.target.checked)}
                />
                Allow HTTP for private or loopback hosts
              </label>
            </>
          )}
        </div>
        {selected === "psfn" && (
          <div className="psfn-connection-summary">
            <ShieldCheck size={15} />
            <div>
              <strong>Stateful PSFN companion</strong>
              <span>
                {connection?.remoteCompanionName
                  ? `${connection.remoteCompanionName} · ${connection.remoteCompanionId}`
                  : "Identity is verified and pinned by the connection test."}
              </span>
              <small>Status: {connection?.connectionState ?? "unconfigured"}. PSFN owns its persona, prompt, memory, and faculties.</small>
              <small>A successful handshake creates one deduplicated PSFN voice template for adding the companion to rooms.</small>
              <small>{contextLength.toLocaleString()} tokens records the remote model window. Writers’ Room sends bounded stateful event deltas rather than filling it.</small>
              {sessionMode === "fixed" && (
                <small className="credential-guidance">
                  Shared remote continuity: local rooms and chat resets do not erase or isolate PSFN history.
                </small>
              )}
            </div>
          </div>
        )}
        <footer>
          {(connection?.endpointSource === "settings" ||
            connection?.credentialSource === "settings") && (
            <button
              type="button"
              className="connection-remove"
              disabled={savingConnection || removingConnection}
              onClick={() => void removeConnection()}
            >
              {removingConnection
                ? <LoaderCircle size={12} className="spin" />
                : <Trash2 size={12} />}
              Remove saved connection
            </button>
          )}
          {connectionSaved && <span className="saved-label"><Check size={12} /> Saved</span>}
          {connection?.configured && (
            <button
              type="button"
              disabled={savingConnection || removingConnection}
              onClick={() => void testConnection(connection.connectionState === "identity-drift")}
            >
              {connection.connectionState === "identity-drift" ? "Accept new identity" : "Test connection"}
            </button>
          )}
          <button type="submit" className="primary-button" disabled={savingConnection || removingConnection}>
            {savingConnection && <LoaderCircle size={12} className="spin" />}
            Save & load models
          </button>
        </footer>
      </form>

      {(error || settingsError) && (
        <div className="settings-error" role="alert">{settingsError ?? error}</div>
      )}
      <div className="model-catalog">
        <header>
          <div>
            <strong>{providerLabels[selected]}</strong>
            <span>
              {!connection?.configured
                ? "Configure this connection to load models"
                : loading ? "Loading…" : `${models.length} models available`}
            </span>
          </div>
          <div className="catalog-search">
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search the catalog…"
              disabled={!connection?.configured}
            />
            <button
              type="button"
              onClick={refresh}
              disabled={!connection?.configured}
              aria-label="Refresh model catalog"
              title="Refresh model catalog"
            >
              {loading
                ? <LoaderCircle size={13} className="spin" />
                : <RefreshCw size={13} />}
            </button>
          </div>
        </header>
        <div className="catalog-list">
          {visible.slice(0, 100).map(model => (
            <div key={model.id}>
              <div><strong>{model.name}</strong><code>{model.id}</code></div>
              <span>{Math.round(model.capabilities.contextLength / 1_000)}k</span>
              <span>{selected === "psfn" ? "stateful companion / text" : model.capabilities.toolCalling ? "tools" : "text"}</span>
              <span>{model.capabilities.reasoningOutput ? "reasoning" : "—"}</span>
              <button
                type="button"
                className={
                  defaultModel?.provider === selected &&
                  defaultModel.modelId === model.id
                    ? "current"
                    : ""
                }
                disabled={
                  savingDefaultId !== undefined ||
                  selected === "psfn" ||
                  !model.capabilities.textInput
                }
                aria-busy={savingDefaultId === model.id}
                aria-label={
                  selected === "psfn"
                    ? `${model.name} is stateful and cannot be used as a fallback`
                    : !model.capabilities.textInput
                    ? `${model.name} cannot be used as a text fallback`
                    : defaultModel?.provider === selected &&
                        defaultModel.modelId === model.id
                      ? `${model.name} is the current default model`
                      : `Set ${model.name} as the default model`
                }
                onClick={() => void chooseDefault(model.id)}
              >
                {savingDefaultId === model.id
                  ? <><LoaderCircle size={12} className="spin" /> Saving…</>
                  : selected === "psfn"
                    ? "Stateful only"
                    : !model.capabilities.textInput
                    ? "No text input"
                    : defaultModel?.provider === selected &&
                      defaultModel.modelId === model.id
                    ? "Default"
                    : "Set default"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
