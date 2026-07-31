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
});
