import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentDefinition,
  ModelDescriptor
} from "@writers-room/contracts";
import { api } from "./api.js";

export function useProviderModels(provider: AgentDefinition["provider"]) {
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setModels([]);

    void (async () => {
      try {
        const nextModels = await api.listProviderModels(provider, controller.signal);
        if (active) setModels(nextModels);
      } catch (errorValue) {
        if (!active) return;
        setModels([]);
        setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [provider, revision]);

  const refresh = useCallback(() => {
    setRevision(current => current + 1);
  }, []);

  return { models, loading, error, refresh };
}

export function useFilteredModels(
  models: ModelDescriptor[],
  query: string
): ModelDescriptor[] {
  return useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return models;
    return models.filter(model =>
      `${model.name} ${model.id}`.toLowerCase().includes(needle)
    );
  }, [models, query]);
}
