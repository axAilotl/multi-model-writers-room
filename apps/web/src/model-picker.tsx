import { LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  AgentDefinition,
  ModelCapabilities
} from "@writers-room/contracts";
import {
  useFilteredModels,
  useProviderModels
} from "./use-provider-models.js";

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
  const [query, setQuery] = useState("");
  const { models, loading, error, refresh } = useProviderModels(provider);
  const selected = models.find(model => model.id === value);

  useEffect(() => {
    onCapabilities?.(selected?.capabilities);
  }, [selected, onCapabilities]);

  const filtered = useFilteredModels(models, query);
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
          onClick={refresh}
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
          {!value && <option value="">Select a model…</option>}
          {value && !selected && (
            <option value={value}>Unavailable/custom · {value}</option>
          )}
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
          {selected.capabilities.pdfInput && <span>PDF</span>}
          {selected.capabilities.toolCalling && <span>tools</span>}
          {selected.capabilities.structuredOutput && <span>structured output</span>}
          {selected.capabilities.reasoningOutput && <span>reasoning</span>}
          {selected.capabilities.promptCaching && <span>prompt caching</span>}
          {!selected.capabilities.textInput && <span>no text input</span>}
        </div>
      )}
    </div>
  );
}
