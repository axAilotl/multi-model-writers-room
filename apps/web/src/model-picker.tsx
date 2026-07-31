import { LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useId } from "react";
import type {
  AgentDefinition,
  ModelCapabilities
} from "@writers-room/contracts";
import { useProviderModels } from "./use-provider-models.js";

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
  const listId = useId();
  const { models, loading, error, refresh } = useProviderModels(provider);
  const selected = models.find(model => model.id === value);

  useEffect(() => {
    onCapabilities?.(selected?.capabilities);
  }, [selected, onCapabilities]);

  return (
    <div className="model-picker">
      <div className="model-filter">
        <input
          name={name}
          required
          list={listId}
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder={loading ? "Loading provider models…" : "Type to filter models…"}
          aria-label="Model"
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
      <datalist id={listId}>
        {models.map(model => (
          <option value={model.id} label={model.name} key={model.id} />
        ))}
      </datalist>
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
