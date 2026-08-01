import type {
  ModelCapabilities,
  ModelDescriptor,
  NormalizedChatRequest,
  NormalizedGenerationEvent,
  StatefulParticipantTurnRequest
} from "@writers-room/contracts";
import { renderPsfnEnvelope } from "../room/psfn-turn-assembler.js";
import {
  statefulCompanionExecution,
  type ModelProvider
} from "./model-provider.js";

export type PsfnConnectionState =
  | "untested"
  | "connected"
  | "auth-rejected"
  | "door-unavailable"
  | "incompatible"
  | "identity-drift"
  | "unavailable";

export interface PsfnConnectionIdentity {
  companionId: string;
  companionName: string;
  modelId: string;
}

export class PsfnProviderError extends Error {
  constructor(
    message: string,
    readonly category:
      | "auth-rejected"
      | "door-unavailable"
      | "incompatible"
      | "identity-drift"
      | "unavailable"
      | "ambiguous",
    readonly definitivePreAdmission = false
  ) {
    super(message);
    this.name = "PsfnProviderError";
  }
}

function privateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some(value =>
    !Number.isInteger(value) || value < 0 || value > 255
  )) return false;
  return octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31);
}

function privateHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value === "localhost" || value === "::1" || value === "[::1]" ||
    value.endsWith(".localhost") || privateIpv4(value);
}

export function normalizePsfnBaseUrl(
  value: string,
  allowInsecureHttp = false
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PSFN base URL must be a valid URL");
  }
  if (url.username || url.password) {
    throw new Error("PSFN URL credentials are not allowed; use the bearer field");
  }
  if (url.search || url.hash) {
    throw new Error("PSFN base URL cannot contain a query or fragment");
  }
  if (url.protocol !== "https:") {
    if (url.protocol !== "http:") throw new Error("PSFN base URL must use HTTPS");
    if (!allowInsecureHttp) throw new Error("PSFN base URL must use HTTPS");
    if (!privateHostname(url.hostname)) {
      throw new Error("Insecure PSFN HTTP is allowed only for private or loopback endpoints");
    }
  }
  if (!(url.pathname === "/" || url.pathname === "" || /^\/v1\/?$/.test(url.pathname))) {
    throw new Error("PSFN base URL must be an origin or end in /v1");
  }
  url.pathname = "/v1";
  return url.toString().replace(/\/$/, "");
}

interface SseFrame {
  event: string;
  data: string;
}

const MAX_SSE_FRAME_CHARACTERS = 1_048_576;
const MAX_SSE_OUTPUT_CHARACTERS = 4_194_304;
const MAX_ERROR_BODY_BYTES = 8_192;
const MAX_HANDSHAKE_BODY_BYTES = 262_144;

function parseFrame(block: string): SseFrame | undefined {
  let event = "message";
  const data: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length === 0 ? undefined : { event, data: data.join("\n") };
}

async function* readSse(response: Response): AsyncIterable<SseFrame> {
  if (!response.body) throw new PsfnProviderError(
    "PSFN returned no response stream",
    "ambiguous"
  );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        if (boundary > MAX_SSE_FRAME_CHARACTERS) {
          throw new PsfnProviderError(
            "PSFN SSE frame exceeded the safe size limit",
            "ambiguous"
          );
        }
        const block = buffer.slice(0, boundary);
        const separator = /^\r\n\r\n/.test(buffer.slice(boundary)) ? 4 : 2;
        buffer = buffer.slice(boundary + separator);
        const frame = parseFrame(block);
        if (frame) yield frame;
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      if (buffer.length > MAX_SSE_FRAME_CHARACTERS) {
        throw new PsfnProviderError(
          "PSFN SSE frame exceeded the safe size limit",
          "ambiguous"
        );
      }
      if (done) {
        completed = true;
        break;
      }
    }
    if (buffer.trim()) {
      const frame = parseFrame(buffer);
      if (frame) yield frame;
    }
  } finally {
    if (!completed) {
      await reader.cancel("PSFN SSE reader stopped before normal completion").catch(() => undefined);
    }
    reader.releaseLock();
  }
}

async function readBoundedText(response: Response, byteLimit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  try {
    while (bytes < byteLimit) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = byteLimit - bytes;
      const accepted = value.byteLength <= remaining
        ? value
        : value.subarray(0, remaining);
      bytes += accepted.byteLength;
      result += decoder.decode(accepted, { stream: bytes < byteLimit });
      if (bytes >= byteLimit) {
        await reader.cancel("PSFN response exceeded the safe size limit");
        break;
      }
    }
    result += decoder.decode();
    return result;
  } finally {
    reader.releaseLock();
  }
}

function safeErrorType(
  value: unknown,
  sensitiveValues: readonly string[] = []
): string {
  if (
    typeof value === "string" &&
    sensitiveValues.some(sensitive => sensitive && value.includes(sensitive))
  ) {
    return "upstream_error";
  }
  return typeof value === "string" && /^[a-z0-9_.-]{1,80}$/i.test(value)
    ? value
    : "upstream_error";
}

function safeErrorMessage(
  value: unknown,
  sensitiveValues: readonly string[] = []
): string | undefined {
  if (typeof value !== "string") return undefined;
  let redacted = value;
  for (const sensitive of sensitiveValues) {
    if (sensitive) redacted = redacted.split(sensitive).join("[redacted]");
  }
  const cleaned = redacted
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, 240) : undefined;
}

const PSFN_CAPABILITIES: ModelCapabilities = {
  contextLength: 32_768,
  textInput: true,
  imageInput: false,
  pdfInput: false,
  toolCalling: false,
  structuredOutput: false,
  reasoningInputControl: false,
  reasoningOutput: false,
  promptCaching: false
};

export class PsfnProvider implements ModelProvider {
  readonly id = "psfn";
  readonly execution = statefulCompanionExecution;
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly sessionMode: "fixed" | "header";
  private expectedCompanionId: string | undefined;
  private readonly contextLength: number;
  private readonly fetcher: typeof fetch;
  private connection?: PsfnConnectionIdentity;
  private observedIdentity?: Omit<PsfnConnectionIdentity, "modelId">;
  private connectionPromise: Promise<PsfnConnectionIdentity> | undefined;
  private state: PsfnConnectionState = "untested";

  constructor(input: {
    baseUrl: string;
    apiKey?: string;
    sessionMode: "fixed" | "header";
    expectedCompanionId?: string;
    contextLength?: number;
    allowInsecureHttp?: boolean;
    fetcher?: typeof fetch;
  }) {
    this.baseUrl = normalizePsfnBaseUrl(
      input.baseUrl,
      input.allowInsecureHttp === true
    );
    this.apiKey = input.apiKey;
    this.sessionMode = input.sessionMode;
    this.expectedCompanionId = input.expectedCompanionId;
    this.contextLength = input.contextLength ?? PSFN_CAPABILITIES.contextLength;
    this.fetcher = input.fetcher ?? fetch;
  }

  get connectionState(): PsfnConnectionState {
    return this.state;
  }

  get connectedIdentity(): PsfnConnectionIdentity | undefined {
    return this.connection;
  }

  get configuredSessionMode(): "fixed" | "header" {
    return this.sessionMode;
  }

  get pinnedCompanionId(): string | undefined {
    return this.expectedCompanionId;
  }

  get lastObservedIdentity(): Omit<PsfnConnectionIdentity, "modelId"> | undefined {
    return this.observedIdentity;
  }

  pinExpectedIdentity(companionId: string): void {
    const observed = this.connection?.companionId ?? this.observedIdentity?.companionId;
    if (observed && observed !== companionId) {
      this.expectedCompanionId = companionId;
      delete this.connection;
      this.state = "identity-drift";
      throw new PsfnProviderError(
        "Cannot pin a different PSFN identity than the one observed",
        "identity-drift",
        true
      );
    }
    this.expectedCompanionId = companionId;
  }

  async connect(signal?: AbortSignal): Promise<PsfnConnectionIdentity> {
    if (this.connection) return this.connection;
    if (this.connectionPromise) return this.connectionPromise;
    const promise = this.performConnect(signal).then(identity => {
      this.connection = identity;
      this.state = "connected";
      return identity;
    }).catch(error => {
      this.state = error instanceof PsfnProviderError
        ? error.category === "ambiguous" ? "unavailable" : error.category
        : "unavailable";
      throw error;
    }).finally(() => {
      if (this.connectionPromise === promise) this.connectionPromise = undefined;
    });
    this.connectionPromise = promise;
    return promise;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const identity = await this.connect();
    return [{
      id: identity.modelId,
      name: identity.companionName,
      capabilities: { ...PSFN_CAPABILITIES, contextLength: this.contextLength }
    }];
  }

  async getCapabilities(modelId: string): Promise<ModelCapabilities | undefined> {
    return (await this.listModels()).find(model => model.id === modelId)?.capabilities;
  }

  async *streamChat(
    _request: NormalizedChatRequest
  ): AsyncIterable<NormalizedGenerationEvent> {
    throw new PsfnProviderError(
      "PSFN companion calls require the stateful participant-turn path",
      "incompatible",
      true
    );
  }

  async *streamParticipantTurn(
    request: StatefulParticipantTurnRequest
  ): AsyncIterable<NormalizedGenerationEvent> {
    const identity = await this.connect(request.signal);
    if (request.agent.modelId !== identity.modelId) {
      throw new PsfnProviderError(
        "The PSFN participant model no longer matches the connected companion",
        "identity-drift",
        true
      );
    }
    const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        ...this.headers("text/event-stream"),
        ...(this.sessionMode === "header"
          ? { "X-Session-ID": request.sessionId }
          : {})
      },
      body: JSON.stringify({
        model: identity.modelId,
        messages: [{
          role: "user",
          content: request.preRenderedEnvelope ?? renderPsfnEnvelope(request)
        }],
        stream: true,
        system_prompt_mode: "default",
        response_style: request.responseStyle
      }),
      signal: request.signal
    });
    if (!response.ok) throw await this.httpError(response);
    let textSeen = false;
    let outputCharacters = 0;
    let finishReason: string | undefined;
    let doneSeen = false;
    yield { type: "routing", modelId: identity.modelId, provider: "psfn" };
    for await (const frame of readSse(response)) {
      if (frame.event === "error") {
        let errorType = "upstream_error";
        let errorMessage: string | undefined;
        try {
          const payload = JSON.parse(frame.data) as {
            error?: { type?: unknown; message?: unknown };
          };
          errorType = safeErrorType(
            payload.error?.type,
            this.apiKey ? [this.apiKey] : []
          );
          errorMessage = safeErrorMessage(
            payload.error?.message,
            this.apiKey ? [this.apiKey] : []
          );
        } catch {
          // Keep the local generic label. Upstream text is intentionally omitted.
        }
        throw new PsfnProviderError(
          `PSFN stream failed (${errorType})${errorMessage ? `: ${errorMessage}` : ""}`,
          "ambiguous"
        );
      }
      if (frame.data === "[DONE]") {
        doneSeen = true;
        continue;
      }
      let payload: {
        model?: string;
        choices?: Array<{
          delta?: { content?: unknown };
          finish_reason?: unknown;
        }>;
      };
      try {
        payload = JSON.parse(frame.data) as typeof payload;
      } catch {
        throw new PsfnProviderError("PSFN returned malformed stream JSON", "ambiguous");
      }
      if (payload.model) {
        if (payload.model !== identity.modelId) {
          delete this.connection;
          this.state = "identity-drift";
          throw new PsfnProviderError(
            "PSFN stream model identity changed during the participant turn",
            "identity-drift"
          );
        }
        yield { type: "routing", modelId: payload.model, provider: "psfn" };
      }
      const choice = payload.choices?.[0];
      if (typeof choice?.delta?.content === "string" && choice.delta.content) {
        outputCharacters += choice.delta.content.length;
        if (outputCharacters > MAX_SSE_OUTPUT_CHARACTERS) {
          throw new PsfnProviderError(
            "PSFN streamed output exceeded the safe size limit",
            "ambiguous"
          );
        }
        textSeen = true;
        yield { type: "text-delta", text: choice.delta.content };
      }
      if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    }
    if (!doneSeen || finishReason === undefined) {
      throw new PsfnProviderError("PSFN stream ended before completion", "ambiguous");
    }
    yield {
      type: "done",
      finishReason,
      disposition: textSeen ? "published" : "no-reply"
    };
  }

  async verifyConnection(signal: AbortSignal): Promise<PsfnConnectionIdentity> {
    try {
      const identity = await this.performConnect(signal);
      this.connection = identity;
      this.state = "connected";
      return identity;
    } catch (error) {
      delete this.connection;
      this.state = error instanceof PsfnProviderError
        ? error.category === "ambiguous" ? "unavailable" : error.category
        : "unavailable";
      throw error;
    }
  }

  private async performConnect(signal?: AbortSignal): Promise<PsfnConnectionIdentity> {
    const identityResponse = await this.fetcher(`${this.baseUrl}/identity`, {
      headers: this.headers("application/json"),
      signal: signal ?? AbortSignal.timeout(30_000)
    });
    if (!identityResponse.ok) throw await this.httpError(identityResponse);
    const identityPayload = await readBoundedText(
      identityResponse,
      MAX_HANDSHAKE_BODY_BYTES
    ).then(raw => JSON.parse(raw) as unknown).catch(() => undefined) as {
      object?: unknown;
      companion?: { id?: unknown; name?: unknown };
    } | undefined;
    if (
      identityPayload?.object !== "psfn.identity" ||
      typeof identityPayload.companion?.id !== "string" ||
      !identityPayload.companion.id.trim() ||
      typeof identityPayload.companion.name !== "string" ||
      !identityPayload.companion.name.trim()
    ) {
      throw new PsfnProviderError("Endpoint did not return a valid PSFN identity", "incompatible", true);
    }
    const companionId = identityPayload.companion.id.trim();
    this.observedIdentity = {
      companionId,
      companionName: identityPayload.companion.name.trim()
    };
    if (this.expectedCompanionId && this.expectedCompanionId !== companionId) {
      throw new PsfnProviderError(
        "Remote PSFN companion identity changed; explicit acceptance is required",
        "identity-drift",
        true
      );
    }
    const modelsResponse = await this.fetcher(`${this.baseUrl}/models`, {
      headers: this.headers("application/json"),
      signal: signal ?? AbortSignal.timeout(30_000)
    });
    if (!modelsResponse.ok) throw await this.httpError(modelsResponse);
    const modelsPayload = await readBoundedText(
      modelsResponse,
      MAX_HANDSHAKE_BODY_BYTES
    ).then(raw => JSON.parse(raw) as unknown).catch(() => undefined) as {
      data?: Array<{ id?: unknown; owned_by?: unknown }>;
    } | undefined;
    const models = (modelsPayload?.data ?? []).filter(model =>
      typeof model.id === "string" && model.id.trim()
    ) as Array<{ id: string; owned_by?: unknown }>;
    if (models.length === 0) {
      throw new PsfnProviderError("PSFN returned no companion model", "incompatible", true);
    }
    const matching = models.find(model => model.id === companionId);
    const selected = matching ?? (models.length === 1 ? models[0] : undefined);
    if (!selected) {
      throw new PsfnProviderError("PSFN identity does not match its model catalog", "incompatible", true);
    }
    return {
      companionId,
      companionName: identityPayload.companion.name.trim(),
      modelId: selected.id
    };
  }

  private headers(accept: string): Record<string, string> {
    return {
      accept,
      "content-type": "application/json",
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
    };
  }

  private async httpError(response: Response): Promise<PsfnProviderError> {
    const status = response.status;
    let errorType = "upstream_error";
    let errorMessage: string | undefined;
    try {
      const raw = await readBoundedText(response, MAX_ERROR_BODY_BYTES);
      const payload = JSON.parse(raw) as {
        error?: { type?: unknown; message?: unknown };
      };
      errorType = safeErrorType(
        payload.error?.type,
        this.apiKey ? [this.apiKey] : []
      );
      errorMessage = safeErrorMessage(
        payload.error?.message,
        this.apiKey ? [this.apiKey] : []
      );
    } catch {
      // Numeric status and a local category remain sufficient and safe.
    }
    const detail = errorMessage ? `: ${errorMessage}` : "";
    if (status === 401) {
      return new PsfnProviderError(
        `PSFN authentication was rejected (${errorType}, HTTP 401)${detail}`,
        "auth-rejected",
        true
      );
    }
    if (status === 503) {
      if (errorType === "agent_busy") {
        const retryAfter = response.headers.get("retry-after");
        const safeRetryAfter = retryAfter && /^\d{1,9}$/.test(retryAfter.trim())
          ? retryAfter.trim()
          : undefined;
        return new PsfnProviderError(
          `PSFN companion is busy (agent_busy, HTTP 503)${safeRetryAfter ? `; Retry-After ${safeRetryAfter}` : ""}${detail}`,
          "unavailable",
          true
        );
      }
      if (errorType === "fleet_auth_principal_resolver_unavailable") {
        return new PsfnProviderError(
          `PSFN conversational door is unavailable (${errorType}, HTTP 503)${detail}`,
          "door-unavailable",
          true
        );
      }
      return new PsfnProviderError(
        `PSFN upstream is temporarily unavailable (${errorType}, HTTP 503)${detail}`,
        "unavailable"
      );
    }
    if (status === 504) {
      return new PsfnProviderError(
        `PSFN request outcome is uncertain (${errorType}, HTTP 504)${detail}`,
        "ambiguous"
      );
    }
    return new PsfnProviderError(
      `PSFN request failed (${errorType}, HTTP ${status})${detail}`,
      "unavailable",
      status < 500
    );
  }
}
