import type { ArtifactChunk } from "@writers-room/contracts";
import { uuidv7 } from "../shared/id.js";

interface ChunkDraft {
  text: string;
  pageNumber?: number;
  headingPath?: string;
  lineStart?: number;
  lineEnd?: number;
}

function finalizeChunks(drafts: ChunkDraft[]): ArtifactChunk[] {
  return drafts
    .filter(draft => draft.text.trim())
    .map((draft, ordinal) => ({
      id: uuidv7(),
      artifactId: "",
      ordinal,
      text: draft.text.trim(),
      tokenCount: Math.ceil(draft.text.length / 4),
      ...(draft.pageNumber === undefined ? {} : { pageNumber: draft.pageNumber }),
      ...(draft.headingPath === undefined ? {} : { headingPath: draft.headingPath }),
      ...(draft.lineStart === undefined ? {} : { lineStart: draft.lineStart }),
      ...(draft.lineEnd === undefined ? {} : { lineEnd: draft.lineEnd })
    }));
}

export function parseMarkdown(text: string): ArtifactChunk[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const headings: string[] = [];
  const drafts: ChunkDraft[] = [];
  let currentLines: string[] = [];
  let currentHeading: string | undefined;
  let lineStart = 1;

  const flush = (lineEnd: number) => {
    const content = currentLines.join("\n").trim();
    if (content) {
      drafts.push({
        text: content,
        ...(currentHeading === undefined ? {} : { headingPath: currentHeading }),
        lineStart,
        lineEnd
      });
    }
    currentLines = [];
  };

  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) {
      currentLines.push(line);
      return;
    }
    flush(index);
    const level = match[1]!.length;
    headings.splice(level - 1);
    headings[level - 1] = match[2]!.trim();
    currentHeading = headings.filter(Boolean).join(" > ");
    lineStart = index + 1;
    currentLines = [line];
  });
  flush(lines.length);
  return finalizeChunks(drafts);
}

function splitOversizedParagraph(
  paragraph: string,
  maxChars: number,
  overlapChars: number
): string[] {
  if (paragraph.length <= maxChars) return [paragraph];
  const pieces: string[] = [];
  let start = 0;
  while (start < paragraph.length) {
    const end = Math.min(paragraph.length, start + maxChars);
    pieces.push(paragraph.slice(start, end));
    if (end === paragraph.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return pieces;
}

export function parsePlainText(
  text: string,
  maxChars = 4_000,
  overlapChars = 400
): ArtifactChunk[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const paragraphs = normalized.split(/\n\s*\n/);
  const drafts: ChunkDraft[] = [];
  let searchOffset = 0;
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    const offset = normalized.indexOf(trimmed, searchOffset);
    const lineStart = normalized.slice(0, Math.max(0, offset)).split("\n").length;
    const lineEnd = lineStart + trimmed.split("\n").length - 1;
    for (const piece of splitOversizedParagraph(trimmed, maxChars, overlapChars)) {
      drafts.push({ text: piece, lineStart, lineEnd });
    }
    searchOffset = Math.max(searchOffset, offset + trimmed.length);
  }
  return finalizeChunks(drafts);
}

export async function parsePdf(bytes: Buffer): Promise<ArtifactChunk[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes)
  });
  const document = await task.promise;
  if (document.numPages > 500) {
    await document.destroy();
    throw new Error("PDF exceeds the 500 page limit");
  }
  const drafts: ChunkDraft[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map(item => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) drafts.push({ text, pageNumber });
    page.cleanup();
  }
  await document.destroy();
  return finalizeChunks(drafts);
}
