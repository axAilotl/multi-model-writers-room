import { LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type {
  AgentDefinition,
  ModelCapabilities,
  ModelDescriptor
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
  onModel,
  name = "modelId"
}: {
  provider: AgentDefinition["provider"];
  value: string;
  onChange: (modelId: string) => void;
  onCapabilities?: (capabilities: ModelCapabilities | undefined) => void;
  onModel?: (model: ModelDescriptor | undefined) => void;
  name?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const { models, loading, error, refresh } = useProviderModels(provider);
  const selected = models.find(model => model.id === value);
  const visible = useFilteredModels(
    models,
    open && selected ? "" : value
  ).slice(0, 80);

  useEffect(() => {
    onCapabilities?.(selected?.capabilities);
    onModel?.(selected);
  }, [selected]);

  useEffect(() => {
    setActiveIndex(visible.length > 0 ? 0 : -1);
  }, [value, models.length, open]);

  function choose(modelId: string) {
    onChange(modelId);
    setOpen(false);
  }

  return (
    <div className="model-picker">
      <div className="model-filter">
        <input
          name={name}
          required
          value={value}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={
            open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
          }
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={event => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onKeyDown={event => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex(current => Math.min(current + 1, visible.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex(current => Math.max(current - 1, 0));
            } else if (event.key === "Enter" && open && activeIndex >= 0) {
              event.preventDefault();
              choose(visible[activeIndex]!.id);
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
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
      {open && (
        <div className="model-options" id={listId} role="listbox">
          {visible.map((model, index) => (
            <button
              id={`${listId}-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "active" : ""}
              key={model.id}
              onMouseDown={event => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(model.id)}
            >
              <strong>{model.name}</strong>
              <code>{model.id}</code>
            </button>
          ))}
          {visible.length === 0 && !loading && (
            <div className="model-options-empty">Use this custom model ID</div>
          )}
        </div>
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
          {selected.reasoning?.supportedEfforts && (
            <span>{selected.reasoning.supportedEfforts.join(" / ")}</span>
          )}
          {selected.reasoning?.supportsMaxTokens && <span>reasoning budget</span>}
          {selected.capabilities.promptCaching && <span>prompt caching</span>}
          {!selected.capabilities.textInput && <span>no text input</span>}
        </div>
      )}
    </div>
  );
}
