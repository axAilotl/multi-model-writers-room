import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
    await participantResponseGate;
    yield {
      type: "text-delta",
      text: "One concrete failure mode is stale scheduler selection after a participant leaves the room. Revalidate membership immediately before generation."
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
    providers: new Map([["openrouter", browserProvider]])
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
  await page.screenshot({
    path: join(evidenceRoot, "two-added-participants.png"),
    fullPage: true
  });

  await page.locator(".toggle-label .toggle").click();
  await page.locator(".toggle-label .toggle:not(.on)").waitFor();
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
  await page.getByRole("button", { name: "Close settings" }).click();
  const renderedReply = page.locator(".agent-message .message-copy").filter({
    hasText: completedReply.slice(0, 120)
  });
  await renderedReply.waitFor();
  assert.ok(
    (await renderedReply.innerText()).includes(completedReply.slice(0, 120)),
    "The completed participant response did not render"
  );

  await page.getByRole("button", {
    name: "Remove Browser Critic from room"
  }).click();
  const removalConfirmation = page.getByRole("group", {
    name: "Remove Browser Critic?"
  });
  await removalConfirmation.getByRole("button", { name: "Remove" }).click();
  await page.locator(".participant").filter({ hasText: "Browser Critic" }).waitFor({
    state: "detached"
  });
  assert.equal(await page.locator(".participant").count(), 1, "Participant was not removed");
  await page.screenshot({
    path: join(evidenceRoot, "participant-removed.png"),
    fullPage: true
  });

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
    participantsAdded: 2,
    participantsRemoved: 1,
    requiredFieldWarning: true,
    settingsAvailableDuringGeneration: true,
    realConversationCompleted: true,
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
