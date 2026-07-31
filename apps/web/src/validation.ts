export function validationMessage(
  action: string,
  error: { issues: Array<{ path: PropertyKey[]; message: string }> }
): string {
  const issue = error.issues[0];
  if (!issue) return `${action}: invalid values`;
  const field = issue.path.map(String).join(" → ");
  return `${action}: ${field ? `${field}: ` : ""}${issue.message}`;
}
