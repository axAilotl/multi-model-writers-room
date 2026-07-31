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
      } else if (path.endsWith("/api/v1/voice-templates")) {
        payload = {
          templates: [
            {
              id: "template-1",
              title: "Systems critic",
              name: "Systems Engineer",
              description: "Finds durable seams.",
              provider: "openrouter",
              modelId: "anthropic/claude-sonnet",
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
    expect(model?.options[0]?.textContent).toContain("Claude Sonnet");

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

    await act(async () => root.unmount());
  });

  it("opens a settings page with persistent voice and provider controls", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => {}
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
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

    const settings = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open settings"]'
    );
    expect(settings).not.toBeNull();
    await act(async () => settings!.click());
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(document.querySelector(".settings-page")).not.toBeNull();
    expect(document.body.textContent).toContain("Voice templates");
    expect(document.body.textContent).toContain("Providers & models");
    expect(document.querySelector(".template-form")).not.toBeNull();
    expect(
      document.querySelector<HTMLSelectElement>('select[name="modelId"]')
        ?.options[0]?.textContent
    ).toContain("Claude Sonnet");

    await act(async () => root.unmount());
  });
});
