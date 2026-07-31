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

try {
  runtime = await startRuntime({ dataRoot, host: "127.0.0.1", port: 0 });
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
