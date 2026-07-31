export function validationMessage(
  action: string,
  error: {
    issues: Array<{
      path: PropertyKey[];
      message: string;
      code?: string;
      minimum?: number | bigint;
    }>;
  }
): string {
  const labels: Record<string, string> = {
    title: "Template title",
    name: "Voice name",
    modelId: "Model",
    systemPrompt: "System prompt"
  };
  const missing = new Set(error.issues.flatMap(issue => {
    const field = String(issue.path[0] ?? "");
    const label = labels[field];
    const isMissing = issue.code === "too_small" &&
      (issue.minimum === 1 || issue.message.includes(">=1"));
    return label && isMissing ? [label] : [];
  }));
  const required = [
    "Template title",
    "Voice name",
    "Model",
    "System prompt"
  ].filter(label => missing.has(label));
  if (required.length > 0) {
    const list = required.length === 1
      ? required[0]
      : required.length === 2
        ? `${required[0]} and ${required[1]}`
        : `${required.slice(0, -1).join(", ")}, and ${required.at(-1)}`;
    return `${action}: ${list} ${required.length === 1 ? "is" : "are"} required.`;
  }
  const issue = error.issues[0];
  if (!issue) return `${action}: invalid values`;
  const field = issue.path.map((part, index) => {
    const value = String(part);
    return index === 0 ? labels[value] ?? value : value;
  }).join(" → ");
  return `${action}: ${field ? `${field}: ` : ""}${issue.message}`;
}
