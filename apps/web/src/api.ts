import type {
  AgentDefinition,
  DefaultModelSelection,
  ModelDescriptor,
  ProviderConnectionStatus,
  ProviderConnectionUpdate,
  Room,
  RoomSettings,
  RoomSnapshot,
  VoiceTemplate,
  VoiceTemplateLibraryItem,
  VoiceTemplateInput,
  VoiceTemplatePatch,
  VoiceTemplateGenerationRequest,
  WorkspaceArtifact,
  WorkspaceSearchResult
} from "@writers-room/contracts";

const GENERATION_TIMEOUT_MS = 5 * 60_000;
const INGESTION_TIMEOUT_MS = 15 * 60_000;

async function requestJson<Result>(
  path: string,
  init?: RequestInit
): Promise<Result> {
  const response = await fetch(path, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
    headers: {
      ...(init?.body instanceof FormData ? {} : { "content-type": "application/json" }),
      ...init?.headers
    }
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(
      response.ok
        ? "The server returned an invalid response"
        : `Request failed: ${response.status} ${response.statusText}`.trim()
    );
  }
  if (!response.ok) {
    const error = payload && typeof payload === "object" &&
      "error" in payload && typeof payload.error === "string"
      ? payload.error
      : `Request failed: ${response.status} ${response.statusText}`.trim();
    throw new Error(error);
  }
  if (payload === undefined) throw new Error("The server returned an empty response");
  return payload as Result;
}

export const api = {
  health(): Promise<{
    ok: boolean;
    database: boolean;
    providers: AgentDefinition["provider"][];
    workspace?: { vectorExtensionAvailable: boolean };
  }> {
    return requestJson("/api/v1/health");
  },

  async listProviderModels(
    provider: AgentDefinition["provider"],
    signal?: AbortSignal
  ): Promise<ModelDescriptor[]> {
    return (await requestJson<{
      provider: AgentDefinition["provider"];
      models: ModelDescriptor[];
    }>(
      `/api/v1/providers/${encodeURIComponent(provider)}/models`,
      signal === undefined ? undefined : { signal }
    )).models;
  },

  async listProviderConnections(): Promise<ProviderConnectionStatus[]> {
    return (await requestJson<{ providers: ProviderConnectionStatus[] }>(
      "/api/v1/settings/providers"
    )).providers ?? [];
  },

  async configureProvider(
    provider: AgentDefinition["provider"],
    update: ProviderConnectionUpdate
  ): Promise<ProviderConnectionStatus> {
    return (await requestJson<{ provider: ProviderConnectionStatus }>(
      `/api/v1/settings/providers/${encodeURIComponent(provider)}`,
      { method: "PUT", body: JSON.stringify(update) }
    )).provider;
  },

  async removeProviderConfiguration(
    provider: AgentDefinition["provider"]
  ): Promise<ProviderConnectionStatus> {
    return (await requestJson<{ provider: ProviderConnectionStatus }>(
      `/api/v1/settings/providers/${encodeURIComponent(provider)}`,
      { method: "DELETE" }
    )).provider;
  },

  async testProviderConnection(
    provider: AgentDefinition["provider"],
    acceptIdentityChange = false
  ): Promise<ProviderConnectionStatus> {
    return (await requestJson<{ provider: ProviderConnectionStatus }>(
      `/api/v1/settings/providers/${encodeURIComponent(provider)}/test`,
      {
        method: "POST",
        body: JSON.stringify({ acceptIdentityChange })
      }
    )).provider;
  },

  async getDefaultModel(): Promise<DefaultModelSelection | undefined> {
    return (await requestJson<{ defaultModel: DefaultModelSelection | null }>(
      "/api/v1/settings/default-model"
    )).defaultModel ?? undefined;
  },

  async setDefaultModel(
    selection: DefaultModelSelection
  ): Promise<DefaultModelSelection> {
    return (await requestJson<{ defaultModel: DefaultModelSelection }>(
      "/api/v1/settings/default-model",
      { method: "PUT", body: JSON.stringify(selection) }
    )).defaultModel;
  },

  async listVoiceTemplates(): Promise<VoiceTemplate[]> {
    return (await requestJson<{ templates: VoiceTemplate[] }>(
      "/api/v1/voice-templates"
    )).templates;
  },

  async createVoiceTemplate(input: VoiceTemplateInput): Promise<VoiceTemplate> {
    return (await requestJson<{ template: VoiceTemplate }>(
      "/api/v1/voice-templates",
      { method: "POST", body: JSON.stringify(input) }
    )).template;
  },

  async generateVoiceTemplate(
    input: VoiceTemplateGenerationRequest,
    signal?: AbortSignal
  ): Promise<VoiceTemplateInput> {
    return (await requestJson<{ template: VoiceTemplateInput }>(
      "/api/v1/voice-templates/generate",
      {
        method: "POST",
        body: JSON.stringify(input),
        ...(signal === undefined ? {} : { signal })
      }
    )).template;
  },

  async updateVoiceTemplate(
    templateId: string,
    patch: VoiceTemplatePatch
  ): Promise<VoiceTemplate> {
    return (await requestJson<{ template: VoiceTemplate }>(
      `/api/v1/voice-templates/${encodeURIComponent(templateId)}`,
      { method: "PATCH", body: JSON.stringify(patch) }
    )).template;
  },

  async deleteVoiceTemplate(templateId: string): Promise<void> {
    await requestJson(
      `/api/v1/voice-templates/${encodeURIComponent(templateId)}`,
      { method: "DELETE" }
    );
  },

  async listVoiceTemplateLibrary(
    templateId: string
  ): Promise<VoiceTemplateLibraryItem[]> {
    return (await requestJson<{ items?: VoiceTemplateLibraryItem[] }>(
      `/api/v1/voice-templates/${encodeURIComponent(templateId)}/library`
    )).items ?? [];
  },

  async uploadVoiceTemplateReference(
    templateId: string,
    file: File
  ): Promise<VoiceTemplateLibraryItem> {
    const body = new FormData();
    body.append("file", file);
    return (await requestJson<{ item: VoiceTemplateLibraryItem }>(
      `/api/v1/voice-templates/${encodeURIComponent(templateId)}/library`,
      {
        method: "POST",
        body,
        signal: AbortSignal.timeout(INGESTION_TIMEOUT_MS)
      }
    )).item;
  },

  async deleteVoiceTemplateReference(
    templateId: string,
    itemId: string
  ): Promise<void> {
    await requestJson(
      `/api/v1/voice-templates/${encodeURIComponent(templateId)}/library/${encodeURIComponent(itemId)}`,
      { method: "DELETE" }
    );
  },

  async listRooms(): Promise<Room[]> {
    return (await requestJson<{ rooms: Room[] }>("/api/v1/rooms")).rooms;
  },

  async createRoom(title: string): Promise<Room> {
    return (await requestJson<{ room: Room }>("/api/v1/rooms", {
      method: "POST",
      body: JSON.stringify({ title })
    })).room;
  },

  async deleteRoom(roomId: string): Promise<void> {
    await requestJson(`/api/v1/rooms/${encodeURIComponent(roomId)}`, {
      method: "DELETE"
    });
  },

  async resetChat(roomId: string): Promise<void> {
    await requestJson(`/api/v1/rooms/${encodeURIComponent(roomId)}/chat/reset`, {
      method: "POST",
      body: "{}"
    });
  },

  snapshot(roomId: string): Promise<RoomSnapshot> {
    return requestJson(`/api/v1/rooms/${roomId}`);
  },

  async updateRoom(
    roomId: string,
    patch: { title?: string; status?: Room["status"]; settings?: Partial<RoomSettings> }
  ): Promise<Room> {
    return (await requestJson<{ room: Room }>(`/api/v1/rooms/${roomId}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    })).room;
  },

  addAgent(
    roomId: string,
    agent: AgentDefinition,
    confirmSharedPsfnSession = false
  ): Promise<{ agent: AgentDefinition }> {
    return requestJson(`/api/v1/rooms/${roomId}/agents`, {
      method: "POST",
      body: JSON.stringify({
        ...agent,
        ...(confirmSharedPsfnSession ? { confirmSharedPsfnSession: true } : {})
      })
    });
  },

  async removeAgent(roomId: string, agentId: string): Promise<void> {
    await requestJson(
      `/api/v1/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}`,
      { method: "DELETE" }
    );
  },

  sendMessage(
    roomId: string,
    content: string,
    mentionedAgentIds: string[],
    replyToMessageId?: string
  ): Promise<unknown> {
    return requestJson(`/api/v1/rooms/${roomId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content,
        mentionedAgentIds,
        ...(replyToMessageId === undefined ? {} : { replyToMessageId })
      })
    });
  },

  selectSpeaker(
    roomId: string,
    agentId: string,
    targetMessageId?: string
  ): Promise<unknown> {
    return requestJson(`/api/v1/rooms/${roomId}/speakers/${agentId}`, {
      method: "POST",
      body: JSON.stringify(
        targetMessageId === undefined ? {} : { targetMessageId }
      ),
      signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS)
    });
  },

  mute(roomId: string, agentId: string, muted: boolean): Promise<unknown> {
    return requestJson(`/api/v1/rooms/${roomId}/agents/${agentId}/runtime`, {
      method: "PATCH",
      body: JSON.stringify({ muted })
    });
  },

  resolvePsfnDelivery(
    roomId: string,
    agentId: string,
    resolution:
      | "assume-delivered"
      | "retry-possible-duplicate"
      | "send-resynchronization-summary"
  ): Promise<unknown> {
    return requestJson(
      `/api/v1/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}/psfn-delivery/resolve`,
      { method: "POST", body: JSON.stringify({ resolution }) }
    );
  },

  async upload(
    roomId: string,
    file: File,
    ownerAgentId?: string
  ): Promise<WorkspaceArtifact> {
    const body = new FormData();
    body.set("file", file);
    if (ownerAgentId !== undefined) body.set("ownerAgentId", ownerAgentId);
    return (await requestJson<{ artifact: WorkspaceArtifact }>(
      `/api/v1/rooms/${roomId}/artifacts`, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(INGESTION_TIMEOUT_MS)
      }
    )).artifact;
  },

  async uploadRepository(
    roomId: string,
    files: File[]
  ): Promise<{ imported: number; failures: Array<{ path: string; error: string }> }> {
    const body = new FormData();
    const paths = files.map(file => file.webkitRelativePath || file.name);
    for (const file of files) body.append("files", file, file.name);
    body.set("paths", JSON.stringify(paths));
    const result = await requestJson<{
      artifacts: WorkspaceArtifact[];
      failures: Array<{ path: string; error: string }>;
    }>(`/api/v1/rooms/${roomId}/repositories`, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(INGESTION_TIMEOUT_MS)
    });
    return { imported: result.artifacts.length, failures: result.failures };
  },

  async retryArtifact(roomId: string, artifactId: string): Promise<WorkspaceArtifact> {
    return (await requestJson<{ artifact: WorkspaceArtifact }>(
      `/api/v1/rooms/${roomId}/artifacts/${artifactId}/retry`,
      {
        method: "POST",
        signal: AbortSignal.timeout(INGESTION_TIMEOUT_MS)
      }
    )).artifact;
  },

  async deleteArtifact(roomId: string, artifactId: string): Promise<void> {
    await requestJson(
      `/api/v1/rooms/${roomId}/artifacts/${artifactId}`,
      { method: "DELETE" }
    );
  },

  async search(roomId: string, query: string): Promise<WorkspaceSearchResult[]> {
    const parameters = new URLSearchParams({ q: query });
    return (await requestJson<{ results: WorkspaceSearchResult[] }>(
      `/api/v1/rooms/${roomId}/workspace/search?${parameters}`
    )).results;
  },

  addNote(roomId: string, text: string, category?: string): Promise<unknown> {
    return requestJson(`/api/v1/rooms/${roomId}/scratchpad`, {
      method: "POST",
      body: JSON.stringify({
        text,
        ...(category ? { category } : {})
      })
    });
  },

  regenerateTail(roomId: string): Promise<unknown> {
    return requestJson(`/api/v1/rooms/${roomId}/messages/tail/regenerate`, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS)
    });
  },

  deleteTail(roomId: string): Promise<unknown> {
    return requestJson(`/api/v1/rooms/${roomId}/messages/tail`, {
      method: "DELETE"
    });
  },

  inspectGeneration(generationId: string): Promise<{
    events: Array<{ ordinal: number; type: string; payload: unknown; createdAt: string }>;
    toolCalls: Array<{
      id: string;
      toolName: string;
      arguments: unknown;
      result: unknown;
      status: string;
    }>;
    citations: Array<{
      chunkId: string;
      artifactId: string;
      filename: string;
      text: string;
      headingPath?: string;
      pageNumber?: number;
      lineStart?: number;
      lineEnd?: number;
    }>;
  }> {
    return requestJson(`/api/v1/generations/${generationId}/inspection`);
  }
};
