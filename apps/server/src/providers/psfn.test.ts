import { describe, expect, it, vi } from "vitest";
import type { StatefulParticipantTurnRequest } from "@writers-room/contracts";
import {
  PsfnProvider,
  PsfnProviderError,
  normalizePsfnBaseUrl
} from "./psfn.js";

function turnRequest(signal = new AbortController().signal): StatefulParticipantTurnRequest {
  return {
    generationId: "generation-1",
    room: {
      id: "room-1",
      title: "Architecture room",
      conversationStyle: "conversation",
      responseLength: "medium"
    },
    agent: {
      id: "agent-1",
      name: "Remote Ada",
      description: "Finds systems seams.",
      modelId: "companion-1"
    },
    participants: [{
      id: "agent-1",
      name: "Remote Ada",
      description: "Finds systems seams."
    }],
    triggerMessageId: "message-2",
    pendingMessages: [{
      id: "message-2",
      sequence: 2,
      authorType: "human",
      authorName: "Human",
      content: "What should we build next?",
      citedChunkIds: []
    }],
    evidence: [],
    sessionId: "writers-room:room-1:agent-1:v1",
    responseStyle: "expressive",
    signal
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("PSFN stateful companion provider", () => {
  it("normalizes only secure or explicitly private endpoints", () => {
    expect(normalizePsfnBaseUrl("https://companion.example.invalid"))
      .toBe("https://companion.example.invalid/v1");
    expect(normalizePsfnBaseUrl("https://companion.example.invalid/v1/"))
      .toBe("https://companion.example.invalid/v1");
    expect(() => normalizePsfnBaseUrl("http://companion.example.invalid"))
      .toThrow(/HTTPS/i);
    expect(normalizePsfnBaseUrl("http://127.0.0.1:8788", true))
      .toBe("http://127.0.0.1:8788/v1");
    expect(() => normalizePsfnBaseUrl("http://8.8.8.8", true))
      .toThrow(/private/i);
    expect(() => normalizePsfnBaseUrl("https://user:pass@example.invalid"))
      .toThrow(/credentials/i);
    expect(() => normalizePsfnBaseUrl("https://example.invalid?secret=x"))
      .toThrow(/query/i);
  });

  it("discovers and pins identity without creating a chat turn", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/identity")) {
        return jsonResponse({
          object: "psfn.identity",
          companion: { id: "companion-1", name: "Remote Ada" },
          channels: {}
        });
      }
      if (url.endsWith("/models")) {
        return jsonResponse({
          object: "list",
          data: [{ id: "companion-1", object: "model", owned_by: "psfn" }]
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const provider = new PsfnProvider({
      baseUrl: "https://companion.example.invalid/v1",
      apiKey: "test-bearer",
      sessionMode: "header",
      fetcher
    });

    const connection = await provider.connect();

    expect(connection).toMatchObject({
      companionId: "companion-1",
      companionName: "Remote Ada",
      modelId: "companion-1"
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.some(([input]) =>
      String(input).includes("chat/completions")
    )).toBe(false);
    expect((await provider.listModels())[0]).toMatchObject({
      id: "companion-1",
      name: "Remote Ada",
      capabilities: { contextLength: 32_768, toolCalling: false }
    });
  });

  it("sends one PSFN-owned participant turn and uses header sessions", async () => {
    let chatBody: Record<string, unknown> | undefined;
    let chatHeaders: Headers | undefined;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/identity")) {
        return jsonResponse({
          object: "psfn.identity",
          companion: { id: "companion-1", name: "Remote Ada" }
        });
      }
      if (url.endsWith("/models")) {
        return jsonResponse({ data: [{ id: "companion-1", owned_by: "psfn" }] });
      }
      chatBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      chatHeaders = new Headers(init?.headers);
      return new Response([
        "data: {\"model\":\"companion-1\",\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"A durable seam.\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
      ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const provider = new PsfnProvider({
      baseUrl: "https://companion.example.invalid",
      apiKey: "test-bearer",
      sessionMode: "header",
      fetcher
    });
    const events = [];
    for await (const event of provider.streamParticipantTurn(turnRequest())) {
      events.push(event);
    }

    expect(chatHeaders?.get("authorization")).toBe("Bearer test-bearer");
    expect(chatHeaders?.get("x-session-id")).toBe("writers-room:room-1:agent-1:v1");
    expect(chatBody).toMatchObject({
      model: "companion-1",
      stream: true,
      system_prompt_mode: "default",
      response_style: "expressive"
    });
    expect(chatBody?.messages).toEqual([
      expect.objectContaining({ role: "user" })
    ]);
    for (const forbidden of [
      "provider", "system_prompt", "user", "tools", "tool_choice",
      "response_format", "reasoning", "stream_options", "temperature",
      "top_p", "max_tokens"
    ]) {
      expect(chatBody).not.toHaveProperty(forbidden);
    }
    expect(events).toContainEqual({ type: "text-delta", text: "A durable seam." });
    expect(events).toContainEqual({
      type: "done",
      finishReason: "stop",
      disposition: "published"
    });
  });

  it("treats a normal empty stream as intentional no-reply", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/identity")) {
        return jsonResponse({
          object: "psfn.identity",
          companion: { id: "companion-1", name: "Remote Ada" }
        });
      }
      if (url.endsWith("/models")) {
        return jsonResponse({ data: [{ id: "companion-1", owned_by: "psfn" }] });
      }
      return new Response(
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    });
    const provider = new PsfnProvider({
      baseUrl: "https://companion.example.invalid",
      sessionMode: "fixed",
      fetcher
    });
    const events = [];
    for await (const event of provider.streamParticipantTurn(turnRequest())) {
      events.push(event);
    }
    expect(events.at(-1)).toEqual({
      type: "done",
      finishReason: "stop",
      disposition: "no-reply"
    });
  });

  it("rejects a streamed model identity that differs from the pinned handshake", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/identity")) {
        return jsonResponse({
          object: "psfn.identity",
          companion: { id: "companion-1", name: "Remote Ada" }
        });
      }
      if (url.endsWith("/models")) {
        return jsonResponse({ data: [{ id: "companion-1", owned_by: "psfn" }] });
      }
      return new Response([
        "data: {\"model\":\"different-companion\",\"choices\":[{\"delta\":{\"content\":\"Wrong identity\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
      ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const provider = new PsfnProvider({
      baseUrl: "https://companion.example.invalid",
      sessionMode: "fixed",
      expectedCompanionId: "companion-1",
      fetcher
    });

    let error: unknown;
    try {
      for await (const _event of provider.streamParticipantTurn(turnRequest())) {
        // consume
      }
    } catch (value) {
      error = value;
    }

    expect(error).toBeInstanceOf(PsfnProviderError);
    expect(error).toMatchObject({ category: "identity-drift" });
    expect(provider.connectionState).toBe("identity-drift");
    expect(provider.connectedIdentity).toBeUndefined();
  });

  it("classifies typed HTTP failures and redacts upstream error detail", async () => {
    async function failureFor(status: number, type: string): Promise<PsfnProviderError> {
      const fetcher = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/identity")) {
          return jsonResponse({
            object: "psfn.identity",
            companion: { id: "companion-1", name: "Remote Ada" }
          });
        }
        if (url.endsWith("/models")) {
          return jsonResponse({ data: [{ id: "companion-1", owned_by: "psfn" }] });
        }
        return new Response(JSON.stringify({
          error: {
            type,
            message: "Bearer private-provider-token internal detail"
          }
        }), {
          status,
          headers: {
            "content-type": "application/json",
            "retry-after": "4"
          }
        });
      });
      const provider = new PsfnProvider({
        baseUrl: "https://companion.example.invalid",
        sessionMode: "fixed",
        fetcher
      });
      try {
        for await (const _event of provider.streamParticipantTurn(turnRequest())) {
          // consume
        }
      } catch (error) {
        expect(String(error)).not.toContain("private-provider-token");
        if (error instanceof PsfnProviderError) return error;
        throw error;
      }
      throw new Error("Expected the PSFN request to fail");
    }

    const busy = await failureFor(503, "agent_busy");
    expect(busy).toMatchObject({
      category: "unavailable",
      definitivePreAdmission: true
    });
    expect(busy.message).toContain("Retry-After 4");

    const timeout = await failureFor(504, "gateway_timeout");
    expect(timeout).toMatchObject({
      category: "ambiguous",
      definitivePreAdmission: false
    });

    const unknownUnavailable = await failureFor(503, "proxy_unavailable");
    expect(unknownUnavailable).toMatchObject({
      category: "unavailable",
      definitivePreAdmission: false
    });

    const unavailableDoor = await failureFor(
      503,
      "fleet_auth_principal_resolver_unavailable"
    );
    expect(unavailableDoor).toMatchObject({
      category: "door-unavailable",
      definitivePreAdmission: true
    });
  });

  it("fails named SSE error events without exposing the bearer", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/identity")) {
        return jsonResponse({
          object: "psfn.identity",
          companion: { id: "companion-1", name: "Remote Ada" }
        });
      }
      if (url.endsWith("/models")) {
        return jsonResponse({ data: [{ id: "companion-1", owned_by: "psfn" }] });
      }
      return new Response([
        "event: error\n",
        "data: {\"error\":{\"type\":\"top-secret\",\"message\":\"credential=top-secret\"}}\n\n",
        "data: [DONE]\n\n"
      ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const provider = new PsfnProvider({
      baseUrl: "https://companion.example.invalid",
      apiKey: "top-secret",
      sessionMode: "fixed",
      fetcher
    });

    let error: unknown;
    try {
      for await (const _event of provider.streamParticipantTurn(turnRequest())) {
        // consume
      }
    } catch (value) {
      error = value;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("upstream_error");
    expect(String(error)).not.toContain("top-secret");
  });

  it("bounds unterminated SSE frames and oversized HTTP error bodies", async () => {
    const handshake = (url: string): Response | undefined => {
      if (url.endsWith("/identity")) {
        return jsonResponse({
          object: "psfn.identity",
          companion: { id: "companion-1", name: "Remote Ada" }
        });
      }
      if (url.endsWith("/models")) {
        return jsonResponse({ data: [{ id: "companion-1", owned_by: "psfn" }] });
      }
      return undefined;
    };
    const oversizedSseProvider = new PsfnProvider({
      baseUrl: "https://companion.example.invalid",
      sessionMode: "fixed",
      fetcher: (async input => {
        const url = String(input);
        return handshake(url) ?? new Response(
          `data: ${"x".repeat(1_048_577)}`,
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }) as typeof fetch
    });
    await expect(async () => {
      for await (const _event of oversizedSseProvider.streamParticipantTurn(turnRequest())) {
        // consume
      }
    }).rejects.toThrow(/safe size limit/i);

    let cancelled = false;
    const oversizedErrorProvider = new PsfnProvider({
      baseUrl: "https://companion.example.invalid",
      sessionMode: "fixed",
      fetcher: (async input => {
        const url = String(input);
        const handshakeResponse = handshake(url);
        if (handshakeResponse) return handshakeResponse;
        const bytes = new TextEncoder().encode(JSON.stringify({
          error: { type: "proxy_unavailable", message: "x".repeat(100_000) }
        }));
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
          },
          cancel() {
            cancelled = true;
          }
        }), { status: 503, headers: { "content-type": "application/json" } });
      }) as typeof fetch
    });
    await expect(async () => {
      for await (const _event of oversizedErrorProvider.streamParticipantTurn(turnRequest())) {
        // consume
      }
    }).rejects.toThrow(/temporarily unavailable/i);
    expect(cancelled).toBe(true);
  });
});
