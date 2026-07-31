import { LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  AgentDefinition,
  DefaultModelSelection
} from "@writers-room/contracts";
import { api } from "./api.js";
import { providerLabels } from "./provider-labels.js";
import {
  useFilteredModels,
  useProviderModels
} from "./use-provider-models.js";

export function ProviderSettings() {
  const [providers, setProviders] = useState<AgentDefinition["provider"][]>([]);
  const [selected, setSelected] =
    useState<AgentDefinition["provider"]>("openrouter");
  const [query, setQuery] = useState("");
  const [defaultModel, setDefaultModel] = useState<DefaultModelSelection>();
  const [savingDefaultId, setSavingDefaultId] = useState<string>();
  const [settingsError, setSettingsError] = useState<string>();
  const { models, loading, error, refresh } = useProviderModels(selected);

  useEffect(() => {
    let active = true;
    void Promise.all([api.health(), api.getDefaultModel()])
      .then(([health, savedDefault]) => {
        if (!active) return;
        setProviders(health.providers);
        setDefaultModel(savedDefault);
        if (!health.providers.includes("openrouter") && health.providers[0]) {
          setSelected(health.providers[0]);
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

  return (
    <section>
      <div className="settings-section-heading">
        <div>
          <span className="eyebrow">Server-side connections</span>
          <h2>Providers & models</h2>
          <p>Credentials remain in the local environment and are never sent to the browser.</p>
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
          <div className="catalog-search">
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search the catalog…"
            />
            <button
              type="button"
              onClick={refresh}
              aria-label="Refresh model catalog"
              title="Refresh model catalog"
            >
              {loading
                ? <LoaderCircle size={13} className="spin" />
                : <RefreshCw size={13} />}
            </button>
          </div>
        </header>
        {(error || settingsError) && (
          <div className="settings-error" role="alert">{settingsError ?? error}</div>
        )}
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
