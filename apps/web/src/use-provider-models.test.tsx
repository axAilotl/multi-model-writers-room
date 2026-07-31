// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "@writers-room/contracts";
import { useProviderModels } from "./use-provider-models.js";

function Harness({ provider }: { provider: AgentDefinition["provider"] }) {
  const { models } = useProviderModels(provider);
  return <div>{models.map(model => model.name).join(", ")}</div>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("provider model loading", () => {
  it("ignores a stale catalog response after the provider changes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const resolveByProvider = new Map<string, (response: Response) => void>();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const provider = String(input).includes("/ollama/") ? "ollama" : "openrouter";
      return new Promise<Response>(resolve => {
        resolveByProvider.set(provider, resolve);
      });
    }));

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness provider="openrouter" />);
    });
    await act(async () => {
      root.render(<Harness provider="ollama" />);
    });

    await act(async () => {
      resolveByProvider.get("ollama")!(new Response(JSON.stringify({
        provider: "ollama",
        models: [{ id: "llama3.3", name: "Llama 3.3" }]
      }), { headers: { "content-type": "application/json" } }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await act(async () => {
      resolveByProvider.get("openrouter")!(new Response(JSON.stringify({
        provider: "openrouter",
        models: [{ id: "anthropic/claude", name: "Claude" }]
      }), { headers: { "content-type": "application/json" } }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(container.textContent).toBe("Llama 3.3");
    await act(async () => root.unmount());
  });
});
