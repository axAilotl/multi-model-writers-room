import type { RoomSnapshot } from "@writers-room/contracts";

function escapeInlineMarkdown(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/([\\`*_[\]<>#])/g, "\\$1");
}

export function markdownExportFilename(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return `${slug || "writers-room"}.md`;
}

export function renderRoomMarkdown(
  snapshot: RoomSnapshot,
  exportedAt = new Date().toISOString()
): string {
  const names = new Map(snapshot.agents.map(agent => [agent.id, agent.name]));
  const messages = snapshot.messages.filter(message =>
    message.lifecycle === "active" &&
    (message.status === "complete" || message.status === "edited") &&
    (message.authorType === "human" || message.authorType === "agent")
  );
  const lines = [
    "---",
    `title: ${JSON.stringify(snapshot.room.title)}`,
    `room_id: ${JSON.stringify(snapshot.room.id)}`,
    `exported_at: ${JSON.stringify(exportedAt)}`,
    "---",
    "",
    `# ${escapeInlineMarkdown(snapshot.room.title)}`,
    "",
    "## Participants",
    "",
    "- **Human**"
  ];

  for (const agent of snapshot.agents) {
    const description = agent.description.trim()
      ? ` — ${escapeInlineMarkdown(agent.description.trim())}`
      : "";
    lines.push(
      `- **${escapeInlineMarkdown(agent.name)}** (${escapeInlineMarkdown(agent.provider)} / ${escapeInlineMarkdown(agent.modelId)})${description}`
    );
  }

  lines.push("", "## Conversation", "");
  if (messages.length === 0) {
    lines.push("_No public messages._", "");
  }
  for (const message of messages) {
    const author = message.authorType === "human"
      ? "Human"
      : names.get(message.authorId) ?? message.authorId;
    lines.push(
      `### ${escapeInlineMarkdown(author)} · ${message.createdAt}`,
      "",
      `> Message ID: ${message.id}`
    );
    if (message.replyToMessageId) {
      lines.push(`> Reply to: ${message.replyToMessageId}`);
    }
    if (message.citedChunkIds.length > 0) {
      lines.push(`> Sources: ${message.citedChunkIds.join(", ")}`);
    }
    lines.push("", message.content, "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
