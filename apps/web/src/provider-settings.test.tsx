// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderSettings } from "./provider-settings.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("provider settings", () => {
  it("renders the feature-gated PSFN connection as stateful and not fallback-eligible", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/api/v1/settings/providers")) {
        return Response.json({
          providers: [
            {
              provider: "openrouter",
              configured: false,
              hasApiKey: false,
              endpointSource: "none",
              credentialSource: "none"
            },
            {
              provider: "psfn",
              configured: true,
              baseUrl: "https://companion.example.invalid/v1",
              hasApiKey: true,
              endpointSource: "settings",
              credentialSource: "settings",
              sessionMode: "header",
              expectedCompanionId: "companion-1",
              remoteCompanionId: "companion-1",
              remoteCompanionName: "Ada",
              contextLength: 32_768,
              connectionState: "connected"
            }
          ]
        });
      }
      if (path.endsWith("/api/v1/settings/default-model")) {
        return Response.json({ defaultModel: null });
      }
      if (path.includes("/api/v1/providers/psfn/models")) {
        return Response.json({
          provider: "psfn",
          models: [{
            id: "companion-1",
            name: "Ada",
            capabilities: {
              contextLength: 32_768,
              textInput: true,
              imageInput: false,
              pdfInput: false,
              toolCalling: false,
              structuredOutput: false,
              reasoningInputControl: false,
              reasoningOutput: false,
              promptCaching: false
            }
          }]
        });
      }
      return Response.json({ provider: "openrouter", models: [] });
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<ProviderSettings />);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const psfnButton = [...container.querySelectorAll(".provider-strip button")]
      .find(button => button.textContent?.includes("PSFN companion")) as HTMLButtonElement;
    expect(psfnButton).toBeTruthy();
    await act(async () => {
      psfnButton.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("PSFN owns its persona, prompt, memory, and faculties");
    expect(container.textContent).toContain("Ada · companion-1");
    expect(container.querySelector<HTMLSelectElement>('select')?.value).toBe("header");
    const fallbackButton = [...container.querySelectorAll(".catalog-list button")]
      .find(button => button.textContent?.includes("Stateful only")) as HTMLButtonElement;
    expect(fallbackButton.disabled).toBe(true);

    await act(async () => root.unmount());
  });
});
