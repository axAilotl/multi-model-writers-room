// @vitest-environment jsdom

import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App.js";

const room = {
  id: "room-1",
  title: "Effect lifecycle room",
  status: "running" as const,
  settings: {
    autoMode: true,
    maxResponders: 2,
    maxAutonomousWaves: 3,
    maxAutonomousReplies: 6,
    agentContinuation: true,
    jitter: 0.06,
    responseLength: "medium" as const,
    fatigueThreshold: 0.72,
    idleRecoveryIntervalMs: 600_000
  },
  createdAt: "2026-07-31T00:00:00.000Z",
  updatedAt: "2026-07-31T00:00:00.000Z"
};

const snapshot = {
  room,
  agents: [],
  messages: [],
  generations: [],
  runtime: [],
  artifacts: [],
  notes: [],
  activations: [],
  latestSequence: 0
};

function requestBody<Result>(init?: RequestInit): Result {
  try {
    return JSON.parse(String(init?.body)) as Result;
  } catch (error) {
    throw new Error("Test received an invalid JSON request body", { cause: error });
  }
}

class FakeWebSocket {
  onmessage?: () => void;

  close(): void {}
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  document.body.replaceChildren();
});

describe("App effect lifecycle", () => {
  it("mounts and unmounts under Strict Mode when scrolling returns a promise", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: async () => {}
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const payload = path.endsWith("/api/v1/rooms")
        ? { rooms: [room] }
        : snapshot;
      return new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" }
      });
    }));

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <StrictMode>
          <App />
        </StrictMode>
      );
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(document.body.textContent).toContain("Effect lifecycle room");

    await act(async () => {
      root.unmount();
    });
  });

  it("populates Add Voice from provider models and saved templates", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => {}
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      let payload: unknown;
      if (path.includes("/api/v1/providers/openrouter/models")) {
        payload = {
          provider: "openrouter",
          models: [
            {
              id: "anthropic/claude-sonnet",
              name: "Claude Sonnet",
              capabilities: {
                contextLength: 200_000,
                textInput: true,
                imageInput: true,
                pdfInput: true,
                toolCalling: true,
                structuredOutput: true,
                reasoningInputControl: true,
                reasoningOutput: true,
                promptCaching: true
              }
            },
            {
              id: "provider/extremely-long-model-identifier-that-must-stay-contained",
              name: "An Extremely Long Experimental Model Name That Must Stay Inside the Picker",
              capabilities: {
                contextLength: 64_000,
                textInput: true,
                imageInput: false,
                pdfInput: false,
                toolCalling: false,
                structuredOutput: false,
                reasoningInputControl: false,
                reasoningOutput: false,
                promptCaching: false
              }
            }
          ]
        };
      } else if (path.includes("/api/v1/providers/ollama/models")) {
        payload = {
          provider: "ollama",
          models: [
            {
              id: "llama3.3",
              name: "Llama 3.3",
              capabilities: {
                contextLength: 128_000,
                textInput: true,
                imageInput: false,
                pdfInput: false,
                toolCalling: true,
                structuredOutput: false,
                reasoningInputControl: false,
                reasoningOutput: false,
                promptCaching: false
              }
            }
          ]
        };
      } else if (path.endsWith("/api/v1/voice-templates")) {
        payload = {
          templates: [
            {
              id: "template-1",
              title: "Systems critic",
              name: "Systems Engineer",
              description: "Finds durable seams.",
              provider: "ollama",
              modelId: "legacy/custom-model",
              systemPrompt: "Challenge architecture.",
              personaPrompt: "Direct and skeptical.",
              temperature: 0.4,
              maxOutputTokens: 900,
              reasoning: {
                enabled: true,
                effort: "high",
                displayMode: "summary"
              },
              tools: [],
              contextBudget: {
                softLimitTokens: 12_000,
                hardLimitTokens: 16_000,
                recentTranscriptTokens: 8_000,
                retrievedContextTokens: 2_000,
                notebookTokens: 0
              },
              createdAt: "2026-07-31T00:00:00.000Z",
              updatedAt: "2026-07-31T00:00:00.000Z"
            }
          ]
        };
      } else if (path.endsWith("/api/v1/settings/default-model")) {
        payload = {
          defaultModel: {
            provider: "openrouter",
            modelId: "anthropic/claude-sonnet"
          }
        };
      } else {
        payload = path.endsWith("/api/v1/rooms")
          ? { rooms: [room] }
          : snapshot;
      }
      return new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" }
      });
    }));

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <StrictMode>
          <App />
        </StrictMode>
      );
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const addVoice = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Add voice"]'
    );
    expect(addVoice).not.toBeNull();
    await act(async () => addVoice!.click());
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const model = document.querySelector<HTMLInputElement>(
      'input[name="modelId"]'
    );
    expect(model?.value).toBe("anthropic/claude-sonnet");
    expect(document.querySelector('[aria-label="Filter models"]')).toBeNull();
    expect(document.querySelector('select[name="modelId"]')).toBeNull();
    expect(document.querySelector(".agent-modal-wide")).not.toBeNull();
    expect(document.body.textContent).toContain("PDF");
    expect(document.body.textContent).toContain("structured output");
    expect(document.body.textContent).toContain("prompt caching");
    await act(async () => {
      model!.focus();
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(model, "claude");
      model!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const suggestions = Array.from(document.querySelectorAll<HTMLElement>(
      '.model-options [role="option"]'
    ));
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.textContent).toContain("Claude Sonnet");
    expect(suggestions[0]?.textContent).not.toContain("Extremely Long");

    const template = document.querySelector<HTMLSelectElement>(
      'select[name="voiceTemplate"]'
    );
    expect(template).not.toBeNull();
    await act(async () => {
      template!.value = "template-1";
      template!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(
      document.querySelector<HTMLInputElement>('input[name="voiceName"]')?.value
    ).toBe("Systems Engineer");
    expect(
      document.querySelector<HTMLTextAreaElement>('textarea[name="systemPrompt"]')
        ?.value
    ).toBe("Challenge architecture.");
    expect(
      document.querySelector<HTMLInputElement>('input[name="modelId"]')?.value
    ).toBe("legacy/custom-model");

    await act(async () => root.unmount());
  });

  it("opens a settings page with persistent voice and provider controls", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => {}
    });
    let generatedTemplateCount = 0;
    let savedTemplateCount = 0;
    const fetchMock = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const path = String(input);
      let payload: unknown;
      if (
        path.endsWith("/api/v1/voice-templates/generate") &&
        init?.method === "POST"
      ) {
        generatedTemplateCount += 1;
        const secondDraft = generatedTemplateCount === 2;
        payload = {
          template: {
            title: secondDraft ? "Systems Realist" : "Product Heretic",
            name: secondDraft ? "Niko" : "Mara",
            description: "Questions comfortable assumptions.",
            provider: "openrouter",
            modelId: "anthropic/claude-sonnet",
            systemPrompt: "Challenge the proposal and expose neglected alternatives.",
            personaPrompt: "Provocative, concrete, and constructive.",
            temperature: secondDraft ? 0.87 : 0.85,
            ...(secondDraft ? { topP: 0.73 } : {}),
            maxOutputTokens: 1_200,
            reasoning: {
              enabled: true,
              effort: "medium",
              displayMode: "summary"
            },
            tools: ["search_workspace"],
            contextBudget: {
              softLimitTokens: 120_000,
              hardLimitTokens: 160_000,
              recentTranscriptTokens: 70_000,
              retrievedContextTokens: 24_000,
              notebookTokens: 0
            }
          }
        };
      } else if (path.endsWith("/api/v1/voice-templates")) {
        if (init?.method === "POST") {
          savedTemplateCount += 1;
          payload = {
            template: {
              ...requestBody<Record<string, unknown>>(init),
              id: `saved-template-${savedTemplateCount}`,
              createdAt: "2026-07-31T12:00:00.000Z",
              updatedAt: "2026-07-31T12:00:00.000Z"
            }
          };
        } else {
          payload = { templates: [] };
        }
      } else if (path.endsWith("/api/v1/health")) {
        payload = {
          ok: true,
          database: true,
          providers: ["openrouter"]
        };
      } else if (path.endsWith("/api/v1/settings/default-model")) {
        payload = init?.method === "PUT"
          ? {
              defaultModel: requestBody<{
                provider: string;
                modelId: string;
              }>(init)
            }
          : {
              defaultModel: {
                provider: "openrouter",
                modelId: "anthropic/claude-sonnet"
              }
            };
      } else if (path.includes("/api/v1/providers/openrouter/models")) {
        payload = {
          provider: "openrouter",
          models: [
            {
              id: "anthropic/claude-sonnet",
              name: "Claude Sonnet",
              capabilities: {
                contextLength: 200_000,
                textInput: true,
                imageInput: true,
                pdfInput: true,
                toolCalling: true,
                structuredOutput: true,
                reasoningInputControl: true,
                reasoningOutput: true,
                promptCaching: true
              }
            },
            {
              id: "provider/extremely-long-model-identifier-that-must-stay-contained",
              name: "An Extremely Long Experimental Model Name That Must Stay Inside the Picker",
              capabilities: {
                contextLength: 64_000,
                textInput: true,
                imageInput: false,
                pdfInput: false,
                toolCalling: false,
                structuredOutput: false,
                reasoningInputControl: false,
                reasoningOutput: false,
                promptCaching: false
              }
            },
            {
              id: "image-only/settings-model",
              name: "Image-only settings model",
              capabilities: {
                contextLength: 32_000,
                textInput: false,
                imageInput: true,
                pdfInput: false,
                toolCalling: false,
                structuredOutput: false,
                reasoningInputControl: false,
                reasoningOutput: false,
                promptCaching: false
              }
            }
          ]
        };
      } else if (
        path.endsWith("/api/v1/rooms/room-1") &&
        init?.method === "PATCH"
      ) {
        const body = requestBody<{
          settings: typeof room.settings;
        }>(init);
        payload = {
          room: {
            ...room,
            settings: { ...room.settings, ...body.settings }
          }
        };
      } else {
        payload = path.endsWith("/api/v1/rooms")
          ? { rooms: [room] }
          : snapshot;
      }
      return new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <StrictMode>
          <App />
        </StrictMode>
      );
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const settings = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open settings"]'
    );
    expect(settings).not.toBeNull();
    await act(async () => settings!.click());
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Voice templates");
    expect(document.body.textContent).toContain("Providers & models");
    expect(document.querySelector(".template-form")).not.toBeNull();
    const settingsModel = document.querySelector<HTMLInputElement>(
      'input[name="modelId"]'
    );
    await act(async () => settingsModel?.focus());
    expect(document.querySelector(".model-options")?.textContent)
      .toContain("Claude Sonnet");
    expect(document.body.textContent).toContain("Top P");
    expect(document.body.textContent).toContain("Reasoning token cap");
    expect(document.body.textContent).toContain("Tools");
    expect(document.body.textContent).toContain("Context budget");

    const generateVoice = Array.from(document.querySelectorAll<HTMLButtonElement>(
      "button"
    )).find(button => button.textContent?.includes("Generate with AI"));
    await act(async () => generateVoice!.click());
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true
      }));
    });
    expect(document.querySelector(".voice-generator-modal")).toBeNull();
    expect(document.querySelector(".settings-page")).not.toBeNull();
    await act(async () => generateVoice!.click());
    const generator = document.querySelector<HTMLFormElement>(
      '.voice-generator-modal[role="dialog"]'
    );
    expect(generator).not.toBeNull();
    const generatedName = generator?.querySelector<HTMLInputElement>(
      'input[name="generatedVoiceName"]'
    );
    const sourceText = generator?.querySelector<HTMLTextAreaElement>(
      'textarea[name="voiceSourceText"]'
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(generatedName, "Mara");
      generatedName!.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set?.call(
        sourceText,
        "A product strategist who challenges safe assumptions and asks what users truly need."
      );
      sourceText!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      generator!.dispatchEvent(new Event("submit", {
        bubbles: true,
        cancelable: true
      }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(document.querySelector(".voice-generator-modal")).toBeNull();
    expect(document.querySelector<HTMLInputElement>(
      ".template-form input[placeholder=\"Systems Engineer\"]"
    )?.value).toBe("Mara");
    expect(document.querySelector<HTMLTextAreaElement>(
      ".template-form textarea[rows=\"5\"]"
    )?.value).toContain("neglected alternatives");
    const createTemplate = Array.from(document.querySelectorAll<HTMLButtonElement>(
      ".template-form button"
    )).find(button => button.textContent?.includes("Create template"));
    await act(async () => {
      createTemplate!.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input).endsWith("/api/v1/voice-templates") &&
      init?.method === "POST"
    )).toBe(true);
    expect(document.body.textContent).toContain("Product Heretic");
    expect(document.body.textContent).toContain("Saved");

    await act(async () => generateVoice!.click());
    const secondGenerator = document.querySelector<HTMLFormElement>(
      '.voice-generator-modal[role="dialog"]'
    );
    const secondName = secondGenerator?.querySelector<HTMLInputElement>(
      'input[name="generatedVoiceName"]'
    );
    const secondSource = secondGenerator?.querySelector<HTMLTextAreaElement>(
      'textarea[name="voiceSourceText"]'
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        ?.set?.call(secondName, "Niko");
      secondName!.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
        ?.set?.call(
          secondSource,
          "A systems realist who distinguishes operational constraints from imagined limitations."
        );
      secondSource!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      secondGenerator!.requestSubmit();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const secondCreate = Array.from(document.querySelectorAll<HTMLButtonElement>(
      ".template-form button"
    )).find(button => button.textContent?.includes("Create template"));
    await act(async () => {
      secondCreate!.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(fetchMock.mock.calls.filter(([input, init]) =>
      String(input).endsWith("/api/v1/voice-templates") &&
      init?.method === "POST"
    )).toHaveLength(2);
    expect(document.body.textContent).toContain("Product Heretic");
    expect(document.body.textContent).toContain("Systems Realist");

    const newTemplate = Array.from(document.querySelectorAll<HTMLButtonElement>(
      ".settings-heading-actions button"
    )).find(button => button.textContent?.includes("New template"));
    await act(async () => newTemplate!.click());
    const unsavedTitle = document.querySelector<HTMLInputElement>(
      '.template-form input[name="title"]'
    );
    const unsavedModel = document.querySelector<HTMLInputElement>(
      '.template-form input[name="modelId"]'
    );
    const unsavedSystemPrompt = document.querySelector<HTMLTextAreaElement>(
      '.template-form textarea[name="systemPrompt"]'
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        ?.set?.call(unsavedTitle, "");
      unsavedTitle!.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        ?.set?.call(unsavedModel, "");
      unsavedModel!.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
        ?.set?.call(unsavedSystemPrompt, "");
      unsavedSystemPrompt!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const invalidCreate = Array.from(document.querySelectorAll<HTMLButtonElement>(
      ".template-form button"
    )).find(button => button.textContent?.includes("Create template"));
    expect(invalidCreate?.disabled).toBe(false);
    await act(async () => invalidCreate!.click());
    expect(document.body.textContent).toContain(
      "Cannot save template: Template title, Voice name, Model, and System prompt are required."
    );
    expect(fetchMock.mock.calls.filter(([input, init]) =>
      String(input).endsWith("/api/v1/voice-templates") &&
      init?.method === "POST"
    )).toHaveLength(2);

    const providers = Array.from(document.querySelectorAll<HTMLButtonElement>(
      ".settings-layout nav button"
    )).find(button => button.textContent?.includes("Providers & models"));
    await act(async () => providers!.click());
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(document.body.textContent).toContain("Default fallback model");
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>(
      ".catalog-list button"
    )).find(button => button.textContent?.includes("No text input"))?.disabled)
      .toBe(true);
    const setDefault = Array.from(document.querySelectorAll<HTMLButtonElement>(
      ".catalog-list button"
    )).find(button => button.textContent?.includes("Set default"));
    await act(async () => {
      setDefault!.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(fetchMock.mock.calls
      .filter(([, init]) => init?.method === "PUT")
      .map(([, init]) => String(init?.body)))
      .toContainEqual(expect.stringContaining(
        '"modelId":"provider/extremely-long-model-identifier-that-must-stay-contained"'
      ));
    expect(document.body.textContent).toContain("Current default");

    const conversation = Array.from(document.querySelectorAll<HTMLButtonElement>(
      ".settings-layout nav button"
    )).find(button => button.textContent?.includes("Conversation"));
    await act(async () => conversation!.click());
    expect(document.body.textContent).toContain("Fatigue recovery interval");
    expect(document.querySelector<HTMLFormElement>(".settings-form")?.checkValidity())
      .toBe(true);
    const recoveryLabel = Array.from(document.querySelectorAll<HTMLLabelElement>(
      ".settings-form label"
    )).find(label => label.textContent?.includes("Fatigue recovery interval"));
    const recovery = recoveryLabel?.querySelector<HTMLInputElement>("input");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(recovery, "5");
      recovery!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      document.querySelector<HTMLFormElement>(".settings-form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(fetchMock.mock.calls
      .filter(([, init]) => init?.method === "PATCH")
      .map(([, init]) => String(init?.body)))
      .toContainEqual(expect.stringContaining('"idleRecoveryIntervalMs":300000'));

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true
      }));
    });
    expect(document.querySelector(".settings-page")).toBeNull();

    await act(async () => root.unmount());
  });

  it("opens settings and removes a participant while another participant is responding", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => {}
    });
    const agent = {
      id: "systems",
      name: "Systems Engineer",
      description: "Finds durable seams.",
      provider: "openrouter" as const,
      modelId: "fixture/model",
      systemPrompt: "Challenge the design.",
      temperature: 0.5,
      maxOutputTokens: 600,
      reasoning: { enabled: false, displayMode: "hidden" as const },
      tools: [],
      contextBudget: {
        softLimitTokens: 12_000,
        hardLimitTokens: 16_000,
        recentTranscriptTokens: 8_000,
        retrievedContextTokens: 2_000,
        notebookTokens: 0
      }
    };
    let currentSnapshot = {
      ...snapshot,
      agents: [agent],
      runtime: [{
        roomId: room.id,
        agentId: agent.id,
        fatigue: 0,
        activation: 0,
        consecutiveTurns: 0,
        muted: false
      }]
    };
    let releaseSpeaker!: (response: Response) => void;
    const speakerResponse = new Promise<Response>(resolve => {
      releaseSpeaker = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith(`/speakers/${agent.id}`)) return speakerResponse;
      if (path.endsWith(`/agents/${agent.id}`) && init?.method === "DELETE") {
        currentSnapshot = { ...currentSnapshot, agents: [], runtime: [] };
        return Promise.resolve(new Response(JSON.stringify({ removed: true, agent }), {
          headers: { "content-type": "application/json" }
        }));
      }
      const payload = path.endsWith("/api/v1/rooms")
        ? { rooms: [room] }
        : path.endsWith("/api/v1/voice-templates")
          ? { templates: [] }
          : path.includes("/api/v1/providers/openrouter/models")
            ? { provider: "openrouter", models: [] }
          : path.endsWith("/api/v1/settings/default-model")
            ? { defaultModel: null }
            : currentSnapshot;
      return Promise.resolve(new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" }
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<App />));
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)));

    const invite = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find(button => button.textContent?.includes("Invite"));
    await act(async () => invite!.click());
    const settings = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open settings"]'
    );
    expect(settings?.disabled).toBe(false);
    await act(async () => settings!.click());
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    const remove = document.querySelector<HTMLButtonElement>(
      `button[aria-label="Remove ${agent.name} from room"]`
    );
    expect(remove?.disabled).toBe(false);
    await act(async () => remove!.click());
    expect(document.querySelector('[role="group"][aria-label^="Remove"]')?.textContent)
      .toContain("Remove from this room?");
    const confirm = document.querySelector<HTMLButtonElement>(
      '[role="group"][aria-label^="Remove"] .danger-button'
    );
    await act(async () => {
      confirm!.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(document.body.textContent).not.toContain(agent.name);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/rooms/${room.id}/agents/${agent.id}`,
      expect.objectContaining({ method: "DELETE" })
    );

    releaseSpeaker(new Response(JSON.stringify({}), {
      headers: { "content-type": "application/json" }
    }));
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
    await act(async () => root.unmount());
  });
});
