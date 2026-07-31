import { LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentDefinition } from "@writers-room/contracts";
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
  const { models, loading, error, refresh } = useProviderModels(selected);

  useEffect(() => {
    let active = true;
    void api.health().then(health => {
      if (!active) return;
      setProviders(health.providers);
      if (!health.providers.includes(selected) && health.providers[0]) {
        setSelected(health.providers[0]);
      }
    });
    return () => {
      active = false;
    };
  }, [selected]);

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
