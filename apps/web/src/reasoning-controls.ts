import type {
  ModelDescriptor,
  ReasoningConfig,
  ReasoningEffort
} from "@writers-room/contracts";

export const reasoningEffortOptions: Array<{
  value: ReasoningEffort;
  label: string;
}> = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Maximum" }
];

export type ReasoningSupport = ModelDescriptor["reasoning"];

export function availableReasoningEfforts(
  support: ReasoningSupport
): typeof reasoningEffortOptions {
  if (!Array.isArray(support?.supportedEfforts)) return reasoningEffortOptions;
  const allowed = new Set(support.supportedEfforts);
  return reasoningEffortOptions.filter(option => allowed.has(option.value));
}

export function reconcileReasoningConfig(
  config: ReasoningConfig,
  support: ReasoningSupport
): ReasoningConfig {
  const options = availableReasoningEfforts(support);
  const defaultEffort = support?.defaultEffort !== "none"
    ? support?.defaultEffort
    : undefined;
  const selectedEffort = config.effort && options.some(option =>
    option.value === config.effort
  )
    ? config.effort
    : options.some(option => option.value === defaultEffort)
      ? defaultEffort
      : options[0]?.value;
  const enabled = support?.mandatory
    ? true
    : config.enabled && selectedEffort !== undefined;
  const { maxTokens: _unsupportedBudget, ...withoutBudget } = config;
  return {
    ...(support?.supportsMaxTokens === false ? withoutBudget : config),
    enabled,
    ...(selectedEffort === undefined ? {} : { effort: selectedEffort })
  };
}
