import { Check, KeyRound, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { providerKinds } from "@writers-room/contracts";
import type {
  AgentDefinition,
  DefaultModelSelection,
  ProviderConnectionStatus
} from "@writers-room/contracts";
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
    setConnectionSaved(false);
    setSettingsError(undefined);
  }, [connection?.baseUrl, selected]);

  function replaceConnection(next: ProviderConnectionStatus) {
    setConnections(current => providerKinds.map(provider =>
      provider === next.provider
        ? next
        : current.find(candidate => candidate.provider === provider) ?? {
            provider,
            configured: false,
            hasApiKey: false,
            endpointSource: "none",
            credentialSource: "none"
          }
    ));
  }

  async function saveConnection(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingConnection(true);
    setConnectionSaved(false);
    setSettingsError(undefined);
    try {
      const next = await api.configureProvider(selected, {
        ...(selected === "openrouter" ? {} : { baseUrl }),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
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
        {providerKinds.map(provider => {
          const status = connections.find(candidate => candidate.provider === provider);
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
        </div>
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
              <span>{model.capabilities.toolCalling ? "tools" : "text"}</span>
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
                  !model.capabilities.textInput
                }
                aria-busy={savingDefaultId === model.id}
                aria-label={
                  !model.capabilities.textInput
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
