import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { startRuntime } from "../apps/server/dist/runtime.js";

const dataRoot = await mkdtemp(join(tmpdir(), "writers-room-browser-e2e-"));
const evidenceRoot = resolve("test-results/browser-e2e");
await mkdir(evidenceRoot, { recursive: true });

let runtime;
let browser;
let page;
const consoleErrors = [];
const pageErrors = [];
const failedResponses = [];
let releaseParticipantResponse;
const participantResponseGate = new Promise(resolve => {
  releaseParticipantResponse = resolve;
});
const fixtureCapabilities = {
  contextLength: 256_000,
  textInput: true,
  imageInput: true,
  pdfInput: true,
  toolCalling: true,
  structuredOutput: true,
  reasoningInputControl: true,
  reasoningOutput: true,
  promptCaching: true
};
const browserProvider = {
  id: "openrouter",
  async listModels() {
    return [{
      id: "moonshotai/kimi-k3",
      name: "MoonshotAI: Kimi K3",
      capabilities: fixtureCapabilities
    }];
  },
  async getCapabilities(modelId) {
    return modelId === "moonshotai/kimi-k3" ? fixtureCapabilities : undefined;
  },
  async *streamChat(request) {
    if (request.sessionId.startsWith("voice-template-generator")) {
      yield {
        type: "text-delta",
        text: JSON.stringify({
          title: "Pragmatic Systems Architect",
          description: "Identifies concrete failure modes and actionable mitigations.",
          systemPrompt: "Find concrete architecture failures, separate evidence from assumptions, and propose actionable mitigations.",
          personaPrompt: "Direct, pragmatic, and specific.",
          temperature: 0.6
        })
      };
      yield { type: "done", finishReason: "stop" };
      return;
    }
    yield {
      type: "text-delta",
      text: "## Architecture finding\n\n**Streaming evidence:** "
    };
    await participantResponseGate;
    yield {
      type: "text-delta",
      text: "one concrete failure mode is stale scheduler selection after a participant leaves the room. Revalidate membership immediately before generation."
    };
    yield { type: "usage", inputTokens: 120, outputTokens: 24, costUsd: 0.001 };
    yield { type: "done", finishReason: "stop" };
  }
};

function trackBrowserFailures(currentPage) {
  currentPage.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  currentPage.on("pageerror", error => pageErrors.push(error.message));
  currentPage.on("response", response => {
    if (response.url().includes("/api/") && !response.ok()) {
      failedResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
}

async function selectTemplateByText(text) {
  const select = page.getByLabel("Voice template");
  const value = await select.locator("option").filter({ hasText: text }).getAttribute("value");
  assert.ok(value, `Template option was not available: ${text}`);
  await select.selectOption(value);
}

async function waitForCondition(predicate, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

try {
  runtime = await startRuntime({
    dataRoot,
    host: "127.0.0.1",
    port: 0,
    providers: new Map([["openrouter", browserProvider]]),
    workspaceModels: {
      embeddings: {
        dimensions: 2,
        async embedDocuments(texts) {
          return texts.map(() => new Float32Array([1, 0]));
        },
        async embedQuery() {
          return new Float32Array([1, 0]);
        }
      },
      housekeeping: {
        async summarize(input) {
          return { summary: `${input.filename} is browser-test evidence.` };
        }
      }
    }
  });
  const address = runtime.address();
  assert.ok(address, "Browser test server did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1
  });
  page = await context.newPage();
  trackBrowserFailures(page);

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("main").waitFor();
  assert.match(await page.locator("body").innerText(), /Pull up a chair/);

  await page.getByRole("textbox").fill("Browser verification room");
  await page.getByRole("button", { name: "Create room" }).click();
  await page.getByRole("heading", { name: "Browser verification room" }).waitFor();

  await page.getByRole("button", { name: "Manage rooms" }).click();
  const roomsDialog = page.getByRole("dialog", { name: "Rooms" });
  await roomsDialog.getByLabel("Create a room").fill("Archive room");
  await roomsDialog.getByRole("button", { name: "Create room" }).click();
  await page.getByRole("heading", { name: "Archive room" }).waitFor();
  await page.getByRole("button", { name: "Manage rooms" }).click();
  await page.getByRole("button", { name: "Switch to Browser verification room" }).click();
  await page.getByRole("heading", { name: "Browser verification room" }).waitFor();

  await page.locator(".left-panel").evaluate(element => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(
      ["# Dragged evidence\n\nThe workspace table accepts dropped Markdown files."],
      "dragged-evidence.md",
      { type: "text/markdown" }
    ));
    for (const type of ["dragenter", "dragover", "drop"]) {
      element.dispatchEvent(new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer
      }));
    }
  });
  await page.getByText("dragged-evidence.md", { exact: true }).waitFor({ timeout: 30_000 });
  const draggedArtifactRow = page.locator(".artifact").filter({
    hasText: "dragged-evidence.md"
  });
  await draggedArtifactRow.getByText("ready", { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByPlaceholder("Search the table").fill("workspace table accepts");
  await page.getByPlaceholder("Search the table").press("Enter");
  const draggedSearchResult = page.locator(".search-result").filter({
    hasText: "dragged-evidence.md"
  });
  await draggedSearchResult.waitFor();

  const workspaceRoom = runtime.store.listRooms().find(room =>
    room.title === "Browser verification room"
  );
  assert.ok(workspaceRoom, "Browser room was not persisted");
  const retryBytes = Buffer.from(
    "Retryable evidence remains available in its content-addressed blob."
  );
  const retryHash = createHash("sha256").update(retryBytes).digest("hex");
  const retryNow = new Date().toISOString();
  const failedArtifact = {
    id: "browser-failed-artifact",
    roomId: workspaceRoom.id,
    filename: "retry-evidence.txt",
    mediaType: "text/plain",
    sha256: retryHash,
    byteSize: retryBytes.byteLength,
    sourceType: "upload",
    summary: "Ingestion failed before extraction.",
    ingestionStatus: "failed",
    ingestionStage: "failed",
    error: "Transient ingestion failure",
    createdAt: retryNow,
    updatedAt: retryNow
  };
  await mkdir(join(dataRoot, "blobs", retryHash.slice(0, 2)), { recursive: true });
  await writeFile(join(dataRoot, "blobs", retryHash.slice(0, 2), retryHash), retryBytes);
  runtime.store.database.prepare(`
    INSERT INTO artifacts(id, room_id, sha256, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    failedArtifact.id,
    failedArtifact.roomId,
    failedArtifact.sha256,
    JSON.stringify(failedArtifact),
    failedArtifact.createdAt,
    failedArtifact.updatedAt
  );
  runtime.store.appendRoomEvent(workspaceRoom.id, {
    type: "artifact.updated",
    artifact: failedArtifact
  });
  const retryArtifactRow = page.locator(".artifact").filter({
    hasText: "retry-evidence.txt"
  });
  await retryArtifactRow.waitFor();
  await retryArtifactRow.getByRole("button", {
    name: "Retry retry-evidence.txt"
  }).click();
  await retryArtifactRow.getByText("ready", { exact: true }).waitFor({ timeout: 30_000 });

  await draggedArtifactRow.getByRole("button", {
    name: "Delete dragged-evidence.md"
  }).click();
  await draggedArtifactRow.getByRole("group", {
    name: "Delete dragged-evidence.md?"
  }).getByRole("button", { name: "Confirm" }).click();
  await draggedArtifactRow.waitFor({ state: "detached" });
  await draggedSearchResult.waitFor({ state: "detached" });

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Providers & models" }).click();
  const catalogSearch = page.getByPlaceholder("Search the catalog…");
  await catalogSearch.waitFor();
  await catalogSearch.fill("moonshotai/kimi-k3");
  const defaultButton = page.getByRole("button", {
    name: /Set MoonshotAI: Kimi K3 as the default model/i
  });
  await defaultButton.waitFor({ timeout: 30_000 });
  await defaultButton.click();
  await page.getByText(/Current default.*moonshotai\/kimi-k3/).waitFor();
  await page.screenshot({
    path: join(evidenceRoot, "provider-default.png"),
    fullPage: true
  });

  await page.getByRole("button", { name: "Voice templates" }).click();
  await page.getByRole("button", { name: "Generate with AI" }).click();
  const generatorModal = page.locator(".voice-generator-modal");
  await generatorModal.getByLabel("Voice name").fill("Browser Architect");
  await generatorModal.getByLabel("Source material").fill(
    "Act as a pragmatic systems architect who identifies concrete failure modes, " +
    "keeps recommendations actionable, and distinguishes evidence from assumptions."
  );
  await generatorModal.getByRole("button", { name: "Generate editable draft" }).click();
  await generatorModal.waitFor({
    state: "hidden",
    timeout: 310_000
  });
  await page.getByRole("button", { name: "Create template" }).click();
  await page.getByText("Saved", { exact: true }).waitFor();
  assert.equal(
    await page.locator(".template-list button").filter({ hasText: "Browser Architect" }).count(),
    1,
    "First generated template did not appear in the template list"
  );

  await page.getByRole("button", { name: "New template" }).click();
  const autoContext = page.getByLabel("Auto-scale to model context");
  assert.equal(await autoContext.isChecked(), true, "New voices did not default to model-aware context");
  await page.getByText(
    /256k working · 256k hard · compact chat at 90k/
  ).waitFor();
  await page.getByLabel("Template title").fill("Browser Product Critic");
  await page.getByLabel("Voice name").fill("Browser Critic");
  await page.getByLabel("Point of view").fill("Challenges unsupported product assumptions.");
  await page.getByLabel("System prompt").fill(
    "Challenge unsupported assumptions and propose concrete validation steps."
  );
  await page.getByLabel("Persona prompt").fill(
    "Long-context operating principle. ".repeat(200)
  );
  await page.getByRole("button", { name: "Create template" }).click();
  await page.getByText("Saved", { exact: true }).waitFor();

  const templateList = page.locator(".template-list button");
  assert.equal(
    await templateList.filter({ hasText: "Browser Architect" }).count(),
    1,
    "First template disappeared after the second save"
  );
  assert.equal(
    await templateList.filter({ hasText: "Browser Product Critic" }).count(),
    1,
    "Second template did not appear after saving"
  );
  assert.equal(await templateList.count(), 2, "Expected exactly two saved templates");
  await page.screenshot({
    path: join(evidenceRoot, "two-saved-templates.png"),
    fullPage: true
  });

  await page.getByRole("button", { name: "New template" }).click();
  const templateForm = page.locator(".template-form");
  await templateForm.getByLabel("Template title").fill("");
  await templateForm.getByLabel("Voice name").fill("");
  await templateForm.getByRole("combobox", { name: "Model", exact: true }).fill("");
  await templateForm.getByLabel("System prompt").fill("");
  const invalidCreate = templateForm.getByRole("button", { name: "Create template" });
  assert.equal(await invalidCreate.isEnabled(), true, "Validation was hidden behind a disabled save button");
  await invalidCreate.click();
  await templateForm.getByRole("alert").filter({
    hasText: "Template title, Voice name, Model, and System prompt are required"
  }).waitFor();
  await page.screenshot({
    path: join(evidenceRoot, "required-template-warning.png"),
    fullPage: true
  });

  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Add voice" }).click();
  await selectTemplateByText("Browser Product Critic");
  await page.getByRole("button", { name: "Add participant" }).click();
  await page.locator(".participant").filter({ hasText: "Browser Critic" }).waitFor();

  await page.getByRole("button", { name: "Add voice" }).click();
  await selectTemplateByText("Browser Architect");
  await page.getByRole("button", { name: "Add participant" }).click();
  await page.locator(".participant").filter({ hasText: "Browser Architect" }).waitFor();
  assert.equal(await page.locator(".participant").count(), 2);
  const modeSelect = page.locator(".compact-select select");
  assert.deepEqual(
    await modeSelect.locator("option").allTextContents(),
    ["Workshop", "Writers’ Room", "Shark Tank", "Fishbowl"]
  );
  await modeSelect.selectOption("hollywood");
  await waitForCondition(
    () => runtime.store.getRoom(workspaceRoom.id).settings.conversationStyle === "hollywood",
    "Writers’ Room mode did not persist"
  );
  assert.equal(runtime.store.getRoom(workspaceRoom.id).settings.maxResponders, 3);
  await modeSelect.selectOption("deep-study");
  await waitForCondition(
    () => runtime.store.getRoom(workspaceRoom.id).settings.conversationStyle === "deep-study",
    "Fishbowl mode did not persist"
  );
  assert.equal(runtime.store.getRoom(workspaceRoom.id).settings.deliberationTurns, 3);
  await modeSelect.selectOption("conversation");
  await waitForCondition(
    () => runtime.store.getRoom(workspaceRoom.id).settings.conversationStyle === "conversation",
    "Workshop mode did not persist"
  );

  const architectParticipant = page.locator(".participant").filter({
    hasText: "Browser Architect"
  });
  await architectParticipant.locator(".participant-library input").setInputFiles({
    name: "architect-interview.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Interview\nThe architect treats failure modes as design inputs.")
  });
  await architectParticipant.getByText("Library (1)", { exact: true }).waitFor({
    timeout: 30_000
  });
  const architectAgent = runtime.store.getSnapshot(workspaceRoom.id).agents.find(
    agent => agent.name === "Browser Architect"
  );
  assert.ok(architectAgent, "Architect participant was not persisted");
  await waitForCondition(
    () => runtime.store.getSnapshot(workspaceRoom.id).artifacts.some(artifact =>
      artifact.ownerAgentId === architectAgent.id &&
      artifact.sourceType === "persona-memory"
    ),
    "Private participant library upload was not persisted"
  );

  const repositoryFixture = join(dataRoot, "repository-fixture");
  await mkdir(repositoryFixture, { recursive: true });
  await writeFile(
    join(repositoryFixture, "speaker-router.ts"),
    "export const routeSpeaker = () => 'balanced';"
  );
  await page.locator('label[title="Add repository folder"] input')
    .setInputFiles(repositoryFixture);
  await page.locator(".artifact").filter({ hasText: "speaker-router.ts" })
    .getByText("repository · ready", { exact: true }).waitFor({ timeout: 30_000 });
  assert.ok(
    runtime.store.getSnapshot(workspaceRoom.id).artifacts.some(artifact =>
      artifact.sourceType === "repository" && artifact.filename.endsWith("speaker-router.ts")
    ),
    "Repository directory upload was not persisted"
  );
  const roomComposer = page.getByRole("textbox", { name: "Room message" });
  assert.equal(await roomComposer.getAttribute("autocomplete"), "off");
  assert.notEqual(
    await roomComposer.getAttribute("data-1p-ignore"),
    null,
    "The room composer is not marked as a non-credential field for 1Password"
  );
  await page.screenshot({
    path: join(evidenceRoot, "two-added-participants.png"),
    fullPage: true
  });

  await page.locator(".toggle-label .toggle").click();
  await page.locator(".toggle-label .toggle:not(.on)").waitFor();

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Voice templates" }).click();
  await page.locator(".template-list button").filter({
    hasText: "Browser Architect"
  }).click();
  const managedReference = page.locator(".voice-library-item").filter({
    hasText: "architect-interview.md"
  });
  await managedReference.waitFor();
  await managedReference.getByRole("button", {
    name: "Delete architect-interview.md"
  }).click();
  await managedReference.getByRole("group", {
    name: "Delete architect-interview.md?"
  }).getByRole("button", { name: "Confirm" }).click();
  await managedReference.waitFor({ state: "detached" });
  await page.locator(".template-list button").filter({
    hasText: "Browser Product Critic"
  }).click();
  await page.getByLabel("Voice name").fill("Browser Reviewer");
  await page.getByRole("button", { name: "Save template" }).click();
  await page.getByText("Saved", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.locator(".participant").filter({ hasText: "Browser Reviewer" }).waitFor();
  assert.equal(
    await page.locator(".participant").filter({ hasText: "Browser Critic" }).count(),
    0,
    "The linked room participant kept the old voice-template name"
  );

  const mentionComposer = page.locator(".composer textarea");
  await mentionComposer.fill("@Browser R");
  const reviewerMention = page.getByRole("option", { name: /Browser Reviewer/ });
  await reviewerMention.waitFor();
  await reviewerMention.click();
  assert.equal(await mentionComposer.inputValue(), "@Browser Reviewer ");
  await mentionComposer.fill("@Browser Reviewer inspect this directly.");
  await mentionComposer.press("Enter");
  await page.locator(".human-message").filter({
    hasText: "@Browser Reviewer inspect this directly."
  }).waitFor();
  const linkedReviewer = runtime.store.getSnapshot(workspaceRoom.id).agents.find(
    agent => agent.name === "Browser Reviewer"
  );
  assert.ok(linkedReviewer, "Renamed linked voice was not persisted in the room");
  assert.deepEqual(
    runtime.store.getTailMessage(workspaceRoom.id)?.mentionedAgentIds,
    [linkedReviewer.id],
    "The selected @ mention was not persisted as a direct target"
  );

  const markdownPrompt = [
    "## Markdown browser check",
    "",
    "**Bold evidence** with `inlineCode()`.",
    "",
    "| Item | State |",
    "| --- | --- |",
    "| renderer | ready |"
  ].join("\n");
  await mentionComposer.fill(markdownPrompt);
  await mentionComposer.press("Enter");
  const markdownMessage = page.locator(".human-message").filter({
    hasText: "Markdown browser check"
  });
  await markdownMessage.locator("h2").waitFor();
  assert.equal(
    await markdownMessage.locator(".message-copy strong").innerText(),
    "Bold evidence"
  );
  assert.equal(await markdownMessage.locator("table").count(), 1);
  assert.equal(await markdownMessage.locator("code").innerText(), "inlineCode()");

  const prompt = "Identify one concrete failure mode in this room design.";
  await page.locator(".composer textarea").fill(prompt);
  await page.locator(".composer textarea").press("Enter");
  await page.locator(".human-message").filter({ hasText: prompt }).waitFor();

  const browserRoom = runtime.store.listRooms().find(room =>
    room.title === "Browser verification room"
  );
  assert.ok(browserRoom, "Browser-created room was not persisted");
  await page.locator(".participant").filter({ hasText: "Browser Architect" })
    .getByRole("button", { name: "Invite" }).click();
  await waitForCondition(
    () => runtime.store.getSnapshot(browserRoom.id).generations.some(
      generation => generation.status === "streaming"
    ),
    "The real speaker endpoint never persisted a streaming generation"
  );
  const streamingMarkdown = page.locator(".agent-message").filter({
    hasText: "Streaming evidence"
  });
  await streamingMarkdown.locator("h2").waitFor();
  assert.equal(
    await streamingMarkdown.locator(".message-copy strong").innerText(),
    "Streaming evidence:"
  );
  const settingsButton = page.getByRole("button", { name: "Open settings" });
  assert.equal(await settingsButton.isEnabled(), true, "Settings was locked during generation");
  await settingsButton.click();
  await page.locator(".settings-page").waitFor();
  assert.equal(
    runtime.store.getSnapshot(browserRoom.id).generations.some(
      generation => generation.status === "streaming"
    ),
    true,
    "The participant was no longer generating when Settings opened"
  );
  await page.screenshot({
    path: join(evidenceRoot, "settings-during-generation.png"),
    fullPage: true
  });
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Manage rooms" }).click();
  await page.getByRole("button", { name: "Switch to Archive room" }).click();
  await page.getByRole("heading", { name: "Archive room" }).waitFor();
  releaseParticipantResponse();
  await waitForCondition(
    () => runtime.store.getSnapshot(browserRoom.id).generations.some(
      generation => generation.status === "complete"
    ),
    "The real participant response did not complete",
    310_000
  );
  const completedReply = runtime.store.getSnapshot(browserRoom.id).generations.find(
    generation => generation.status === "complete"
  )?.finalText.trim();
  assert.ok(completedReply, "The completed generation persisted no response text");
  await page.getByRole("heading", { name: "Archive room" }).waitFor();
  await page.getByRole("button", { name: "Manage rooms" }).click();
  await page.getByRole("button", { name: "Switch to Browser verification room" }).click();
  await page.getByRole("heading", { name: "Browser verification room" }).waitFor();
  const renderedReply = page.locator(".agent-message").filter({
    hasText: "one concrete failure mode is stale scheduler selection"
  });
  await renderedReply.waitFor();
  assert.equal(await renderedReply.locator("h2").innerText(), "Architecture finding");
  assert.equal(
    await renderedReply.locator(".message-copy strong").innerText(),
    "Streaming evidence:"
  );
  assert.match(completedReply, /^## Architecture finding/);
  await page.getByRole("button", {
    name: "Remove Browser Reviewer from room"
  }).click();
  const removalConfirmation = page.getByRole("group", {
    name: "Remove Browser Reviewer?"
  });
  await removalConfirmation.getByRole("button", { name: "Remove" }).click();
  await page.locator(".participant").filter({ hasText: "Browser Reviewer" }).waitFor({
    state: "detached"
  });
  assert.equal(await page.locator(".participant").count(), 1, "Participant was not removed");
  await page.screenshot({
    path: join(evidenceRoot, "participant-removed.png"),
    fullPage: true
  });

  await page.locator(".agent-message .tail-actions")
    .getByRole("button", { name: "Remove" }).click();
  await page.locator(".agent-message").waitFor({ state: "detached" });
  assert.match(
    await page.locator(".room-meter > div i").getAttribute("style"),
    /width:\s*0%/,
    "Room pressure did not reset after deleting the last agent message"
  );

  const replyTarget = runtime.store.getSnapshot(browserRoom.id).messages.find(message =>
    message.authorType === "human" && message.content === markdownPrompt
  );
  assert.ok(replyTarget, "Could not identify the browser reply target");
  await markdownMessage.getByRole("button", { name: "Reply", exact: true }).click();
  await page.locator(".composer-reply-context").filter({
    hasText: "Replying to your message"
  }).waitFor();
  const directReplyText = "This human reply should retain its exact target.";
  await page.getByRole("textbox", { name: "Room message" }).fill(directReplyText);
  await page.getByRole("textbox", { name: "Room message" }).press("Enter");
  await page.locator(".human-message").filter({ hasText: directReplyText }).waitFor();
  const persistedReply = runtime.store.getSnapshot(browserRoom.id).messages.find(
    message => message.content === directReplyText
  );
  assert.equal(persistedReply?.replyToMessageId, replyTarget.id);

  await page.getByRole("button", { name: "Reset chat" }).click();
  await page.getByRole("group", { name: "Reset chat?" })
    .getByRole("button", { name: "Confirm reset" }).click();
  await waitForCondition(
    async () => await page.locator(".human-message").count() === 0,
    "Reset left human messages behind"
  );
  assert.equal(await page.locator(".agent-message").count(), 0, "Reset left agent messages behind");
  assert.equal(await page.locator(".participant").count(), 1, "Reset removed a participant");
  await page.locator(".artifact").filter({ hasText: "retry-evidence.txt" }).waitFor();
  const resetSnapshot = runtime.store.getSnapshot(browserRoom.id);
  assert.equal(resetSnapshot.messages.length, 0, "Reset did not clear persisted messages");
  assert.equal(resetSnapshot.generations.length, 0, "Reset did not clear generations");
  assert.equal(resetSnapshot.agents.length, 1, "Reset did not retain participants");
  assert.equal(resetSnapshot.artifacts.length, 2, "Reset did not retain artifacts");

  await page.getByRole("button", { name: "Manage rooms" }).click();
  await page.getByRole("button", { name: "Switch to Archive room" }).click();
  await page.getByRole("heading", { name: "Archive room" }).waitFor();
  await page.getByRole("button", { name: "Manage rooms" }).click();
  await page.getByRole("button", { name: "Delete room Archive room" }).click();
  await page.getByRole("group", { name: "Delete Archive room?" })
    .getByRole("button", { name: "Confirm delete" }).click();
  await page.getByRole("heading", { name: "Browser verification room" }).waitFor();

  const tableLayout = await page.locator(".left-panel").evaluate(panel => {
    const probe = document.createElement("div");
    probe.dataset.layoutScrollProbe = "true";
    probe.style.height = "2000px";
    probe.style.pointerEvents = "none";
    panel.append(probe);
    const metrics = {
      viewportHeight: window.innerHeight,
      pageHeight: document.documentElement.scrollHeight,
      panelClientHeight: panel.clientHeight,
      panelScrollHeight: panel.scrollHeight,
      overflowY: getComputedStyle(panel).overflowY
    };
    probe.remove();
    return metrics;
  });
  assert.ok(
    tableLayout.pageHeight <= tableLayout.viewportHeight + 1,
    "A long table made the entire page scroll"
  );
  assert.ok(
    tableLayout.panelScrollHeight > tableLayout.panelClientHeight,
    "The table column did not own its vertical overflow"
  );
  assert.equal(tableLayout.overflowY, "auto", "The table column has no scrollbar");

  const bodyMetrics = await page.locator("body").evaluate(element => ({
    textLength: element.innerText.trim().length,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2
  }));
  assert.ok(bodyMetrics.textLength > 100, "The browser rendered an empty page");
  assert.equal(bodyMetrics.horizontalOverflow, false, "The page has horizontal overflow");
  assert.deepEqual(pageErrors, [], `Browser runtime errors: ${pageErrors.join(" | ")}`);
  assert.deepEqual(consoleErrors, [], `Browser console errors: ${consoleErrors.join(" | ")}`);
  assert.deepEqual(failedResponses, [], `Failed API responses: ${failedResponses.join(" | ")}`);

  console.log(JSON.stringify({
    ok: true,
    templatesSaved: 2,
    modelAwareContextBudget: true,
    participantsAdded: 2,
    participantsRemoved: 1,
    roomModesConfigured: 4,
    personaLibraryUploaded: true,
    voiceReferenceManagedInSettings: true,
    repositoryDirectoryUploaded: true,
    composerIgnoredByPasswordManagers: true,
    requiredFieldWarning: true,
    settingsAvailableDuringGeneration: true,
    realConversationCompleted: true,
    explicitMessageReplyPersisted: true,
    roomsCreated: 2,
    roomSwitchSurvivedPriorGeneration: true,
    roomsDeleted: 1,
    roomPressureReset: true,
    workspaceDragDropUploaded: true,
    workspaceArtifactRetried: true,
    workspaceArtifactDeleted: true,
    tableOwnScroller: true,
    directMentionAutocomplete: true,
    directMentionPersisted: true,
    linkedVoiceRenamePropagated: true,
    chatResetRetainedRoomResources: true,
    markdownMessagesRendered: true,
    streamedAgentMarkdownRendered: true,
    consoleErrors: 0,
    pageErrors: 0,
    failedApiResponses: 0,
    evidenceRoot
  }));
} catch (error) {
  if (page) {
    await page.screenshot({
      path: join(evidenceRoot, "failure.png"),
      fullPage: true
    }).catch(() => undefined);
  }
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  await runtime?.close().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true });
}
