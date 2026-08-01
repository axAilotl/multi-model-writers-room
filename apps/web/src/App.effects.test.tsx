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
    conversationStyle: "conversation" as const,
    deliberationTurns: 1,
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
  static instances: FakeWebSocket[] = [];
  onmessage?: () => void;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {}
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  document.body.replaceChildren();
});

describe("App effect lifecycle", () => {
  it("shows an inspectable quiet-outcome record instead of an empty reply bubble", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => {}
    });
    const noReplySnapshot = {
      ...snapshot,
      agents: [{
        id: "quiet-agent",
        name: "Quiet Agent",
        description: "Speaks selectively.",
        provider: "openrouter",
        modelId: "fixture/model",
        systemPrompt: "Speak only when useful.",
        temperature: 0.7,
        maxOutputTokens: 512,
        reasoning: { enabled: false, displayMode: "hidden" },
        tools: [],
        contextBudget: {
          softLimitTokens: 4_000,
          hardLimitTokens: 8_000,
          recentTranscriptTokens: 2_000,
          retrievedContextTokens: 1_000,
          notebookTokens: 0
        }
      }],
      messages: [{
        id: "quiet-message",
        roomId: room.id,
        authorType: "agent",
        authorId: "quiet-agent",
        content: "",
        createdAt: "2026-07-31T00:01:00.000Z",
        sequence: 1,
        generationId: "quiet-generation",
        status: "complete",
        lifecycle: "deleted",
        visibility: "public"
      }],
      generations: [{
        id: "quiet-generation",
        roomId: room.id,
        messageId: "quiet-message",
        agentId: "quiet-agent",
        requestedProvider: "openrouter",
        requestedModelId: "fixture/model",
        finalText: "",
        disposition: "no-reply",
        toolCalls: [],
        retrievedChunkIds: [],
        status: "complete",
        startedAt: "2026-07-31T00:01:00.000Z",
        completedAt: "2026-07-31T00:01:01.000Z"
      }]
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const payload = path.endsWith("/api/v1/rooms")
        ? { rooms: [room] }
        : noReplySnapshot;
      return new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" }
      });
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<App />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const quietRecord = container.querySelector(".no-reply-message");
    expect(quietRecord?.textContent).toContain("Chose not to add a public reply.");
    expect(quietRecord?.querySelector(".detail-toggle")?.textContent).toContain("Inspect");
    expect(quietRecord?.querySelector(".tail-actions")).toBeNull();

    await act(async () => root.unmount());
  });

  it("keeps an unsent message in the composer when the API gateway rejects it", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => {}
    });
    const fetchMock = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const path = String(input);
      if (
        path.endsWith(`/api/v1/rooms/${room.id}/messages`) &&
        init?.method === "POST"
      ) {
        return new Response(JSON.stringify({ error: "Bad gateway" }), {
          status: 502,
          headers: { "content-type": "application/json" }
        });
      }
      const payload = path.endsWith("/api/v1/rooms")
        ? { rooms: [room] }
        : snapshot;
      return new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const composer = container.querySelector<HTMLTextAreaElement>(
      ".composer textarea"
    )!;
    expect(composer.name).toBe("roomMessage");
    expect(composer.autocomplete).toBe("off");
    expect(composer.hasAttribute("data-1p-ignore")).toBe(true);
    expect(composer.form?.getAttribute("autocomplete")).toBe("off");
    const unsent = "This message must survive a gateway failure.";
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
        ?.set?.call(composer, unsent);
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      composer.form?.dispatchEvent(new Event("submit", {
        bubbles: true,
        cancelable: true
      }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/rooms/${room.id}/messages`,
      expect.objectContaining({ method: "POST" })
    );
    expect(composer.value).toBe(unsent);
    expect(container.querySelector(".error-toast")?.textContent)
      .toContain("Bad gateway");

    await act(async () => root.unmount());
  });

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

  it("does not let a queued refresh restore the previous room while switching", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => {}
    });
    const archiveRoom = {
      ...room,
      id: "room-2",
      title: "Archive room"
    };
    const archiveSnapshot = { ...snapshot, room: archiveRoom };
    let releaseArchive!: () => void;
    const archiveGate = new Promise<void>(resolve => {
      releaseArchive = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      let payload: unknown;
      if (path.endsWith("/api/v1/rooms")) {
        payload = { rooms: [room, archiveRoom] };
      } else if (path.endsWith(`/api/v1/rooms/${archiveRoom.id}`)) {
        await archiveGate;
        payload = archiveSnapshot;
      } else {
        payload = snapshot;
      }
      return new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" }
      });
    }));

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const liveSocket = FakeWebSocket.instances.at(-1);
    expect(liveSocket).toBeDefined();
    await act(async () => liveSocket!.onmessage?.());
    await act(async () => {
      document.querySelector<HTMLButtonElement>(
        'button[aria-label="Manage rooms"]'
      )!.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>(
        'button[aria-label="Switch to Archive room"]'
      )!.click();
      await new Promise(resolve => setTimeout(resolve, 100));
      releaseArchive();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(document.querySelector("h1")?.textContent).toBe("Archive room");
    await act(async () => root.unmount());
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
      } else if (
        path.endsWith("/api/v1/settings/providers/openai-compatible") &&
        init?.method === "PUT"
      ) {
        payload = {
          provider: {
            provider: "openai-compatible",
            configured: true,
            baseUrl: requestBody<{ baseUrl: string }>(init).baseUrl,
            hasApiKey: true,
            endpointSource: "settings",
            credentialSource: "settings"
          }
        };
      } else if (path.endsWith("/api/v1/settings/providers")) {
        payload = {
          providers: [
            {
              provider: "openrouter",
              configured: true,
              baseUrl: "https://openrouter.ai/api/v1",
              hasApiKey: true,
              endpointSource: "environment",
              credentialSource: "environment"
            },
            {
              provider: "ollama",
              configured: false,
              baseUrl: "http://127.0.0.1:11434/v1",
              hasApiKey: false,
              endpointSource: "built-in",
              credentialSource: "none"
            },
            {
              provider: "openai-compatible",
              configured: true,
              baseUrl: "http://127.0.0.1:40000/v1",
              hasApiKey: true,
              endpointSource: "environment",
              credentialSource: "settings"
            }
          ]
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
      } else if (path.includes("/api/v1/providers/openai-compatible/models")) {
        payload = {
          provider: "openai-compatible",
          models: [{
            id: "local/test-model",
            name: "Local test model",
            capabilities: {
              contextLength: 128_000,
              textInput: true,
              imageInput: false,
              pdfInput: false,
              toolCalling: true,
              structuredOutput: true,
              reasoningInputControl: true,
              reasoningOutput: true,
              promptCaching: false
            }
          }]
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

    const compatibleProvider = Array.from(document.querySelectorAll<HTMLButtonElement>(
      ".provider-strip button"
    )).find(button => button.textContent?.includes("OpenAI-compatible"));
    await act(async () => compatibleProvider!.click());
    expect(Array.from(document.querySelectorAll<HTMLButtonElement>(
      ".provider-connection-card button"
    )).some(button => button.textContent?.includes("Remove saved connection")))
      .toBe(true);
    const connectionForm = document.querySelector<HTMLFormElement>(
      ".provider-connection-card"
    );
    const connectionUrl = connectionForm?.querySelector<HTMLInputElement>(
      'input[type="url"]'
    );
    const connectionKey = connectionForm?.querySelector<HTMLInputElement>(
      'input[type="password"]'
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        ?.set?.call(connectionUrl, "http://127.0.0.1:40123/v1");
      connectionUrl!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.body.textContent).toContain(
      "The current credential is scoped to the old endpoint and will not be reused."
    );
    expect(connectionKey?.placeholder).toBe("Enter a key for the new endpoint");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        ?.set?.call(connectionKey, "browser-only-secret");
      connectionKey!.dispatchEvent(new Event("input", { bubbles: true }));
      connectionForm!.dispatchEvent(new Event("submit", {
        bubbles: true,
        cancelable: true
      }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const providerSave = fetchMock.mock.calls.find(([input, init]) =>
      String(input).endsWith("/api/v1/settings/providers/openai-compatible") &&
      init?.method === "PUT"
    );
    expect(String(providerSave?.[1]?.body)).toContain(
      '"baseUrl":"http://127.0.0.1:40123/v1"'
    );
    expect(String(providerSave?.[1]?.body)).toContain(
      '"apiKey":"browser-only-secret"'
    );
    expect(connectionKey?.value).toBe("");
    expect(document.body.textContent).not.toContain("browser-only-secret");
    expect(document.body.textContent).toContain("Local test model");

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
