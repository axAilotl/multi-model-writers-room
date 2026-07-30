import type {
  AgentDefinition,
  Room,
  RoomSettings,
  RoomSnapshot,
  WorkspaceSearchResult
} from "@writers-room/contracts";

async function requestJson<Result>(
  path: string,
  init?: RequestInit
): Promise<Result> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "content-type": "application/json" }),
      ...init?.headers
    }
  });
  const payload = await response.json() as Result & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed: ${response.status}`);
  return payload;
}

export const api = {
  async listRooms(): Promise<Room[]> {
    return (await requestJson<{ rooms: Room[] }>("/api/v1/rooms")).rooms;
  },

  async createRoom(title: string): Promise<Room> {
    return (await requestJson<{ room: Room }>("/api/v1/rooms", {
      method: "POST",
      body: JSON.stringify({ title })
    })).room;
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

  addAgent(roomId: string, agent: AgentDefinition): Promise<{ agent: AgentDefinition }> {
    return requestJson(`/api/v1/rooms/${roomId}/agents`, {
      method: "POST",
      body: JSON.stringify(agent)
    });
  },

  sendMessage(
    roomId: string,
    content: string,
    mentionedAgentIds: string[]
  ): Promise<unknown> {
    return requestJson(`/api/v1/rooms/${roomId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, mentionedAgentIds })
    });
  },

  selectSpeaker(roomId: string, agentId: string): Promise<unknown> {
    return requestJson(`/api/v1/rooms/${roomId}/speakers/${agentId}`, {
      method: "POST",
      body: JSON.stringify({})
    });
  },

  mute(roomId: string, agentId: string, muted: boolean): Promise<unknown> {
    return requestJson(`/api/v1/rooms/${roomId}/agents/${agentId}/runtime`, {
      method: "PATCH",
      body: JSON.stringify({ muted })
    });
  },

  async upload(roomId: string, file: File): Promise<void> {
    const body = new FormData();
    body.set("file", file);
    await requestJson(`/api/v1/rooms/${roomId}/artifacts`, {
      method: "POST",
      body
    });
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
      body: "{}"
    });
  },

  deleteTail(roomId: string): Promise<unknown> {
    return requestJson(`/api/v1/rooms/${roomId}/messages/tail`, {
      method: "DELETE"
    });
  }
};

