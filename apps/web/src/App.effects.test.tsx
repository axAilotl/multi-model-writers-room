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

    const model = document.querySelector<HTMLSelectElement>(
      'select[name="modelId"]'
    );
    expect(Array.from(model?.options ?? []).some(option =>
      option.textContent?.includes("Claude Sonnet")
    )).toBe(true);
    await act(async () => {
      model!.value = "anthropic/claude-sonnet";
      model!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("PDF");
    expect(document.body.textContent).toContain("structured output");
    expect(document.body.textContent).toContain("prompt caching");

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
      document.querySelector<HTMLSelectElement>('select[name="modelId"]')?.value
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
    const fetchMock = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const path = String(input);
      let payload: unknown;
      if (path.endsWith("/api/v1/voice-templates")) {
        payload = { templates: [] };
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
            }
          ]
        };
      } else if (
        path.endsWith("/api/v1/rooms/room-1") &&
        init?.method === "PATCH"
      ) {
        const body = JSON.parse(String(init.body)) as {
          settings: typeof room.settings;
        };
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
    expect(Array.from(
      document.querySelector<HTMLSelectElement>('select[name="modelId"]')?.options ?? []
    ).some(option => option.textContent?.includes("Claude Sonnet"))).toBe(true);
    expect(document.body.textContent).toContain("Top P");
    expect(document.body.textContent).toContain("Reasoning token cap");
    expect(document.body.textContent).toContain("Tools");
    expect(document.body.textContent).toContain("Context budget");

    const conversation = Array.from(document.querySelectorAll<HTMLButtonElement>(
      ".settings-layout nav button"
    )).find(button => button.textContent?.includes("Conversation"));
    await act(async () => conversation!.click());
    expect(document.body.textContent).toContain("Fatigue recovery interval");
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
});
