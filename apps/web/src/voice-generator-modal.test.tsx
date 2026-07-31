// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceGeneratorModal } from "./voice-generator-modal.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("voice generator modal", () => {
  it("keeps generation disabled until a fallback model exists", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <VoiceGeneratorModal
          onClose={() => {}}
          onGenerated={() => {}}
        />
      );
    });
    expect(container.textContent).toContain("Choose a default fallback model");
    expect(container.querySelector<HTMLButtonElement>(".primary-button")?.disabled)
      .toBe(true);
    await act(async () => root.unmount());
  });

  it("aborts generation and discards a late result when closed", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(resolve => {
        resolveFetch = resolve;
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const onGenerated = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <VoiceGeneratorModal
          defaultModel={{
            provider: "openrouter",
            modelId: "anthropic/claude-sonnet"
          }}
          onClose={() => root.unmount()}
          onGenerated={onGenerated}
        />
      );
    });

    const name = container.querySelector<HTMLInputElement>(
      'input[name="generatedVoiceName"]'
    )!;
    const source = container.querySelector<HTMLTextAreaElement>(
      'textarea[name="voiceSourceText"]'
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        ?.set?.call(name, "Mara");
      name.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
        ?.set?.call(
          source,
          "Challenge safe assumptions and ask what users truly need from the product."
        );
      source.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", {
        bubbles: true,
        cancelable: true
      }));
    });
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);

    await act(async () => root.unmount());
    expect(signal?.aborted).toBe(true);
    resolveFetch(new Response(JSON.stringify({ template: { name: "Too late" } }), {
      headers: { "content-type": "application/json" }
    }));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(onGenerated).not.toHaveBeenCalled();
  });
});
