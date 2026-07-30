import type {
  ModelCapabilities,
  NormalizedChatRequest,
  NormalizedGenerationEvent
} from "@writers-room/contracts";

export interface ModelDescriptor {
  id: string;
  name: string;
  capabilities: ModelCapabilities;
}

export interface ModelProvider {
  readonly id: string;
  listModels(): Promise<ModelDescriptor[]>;
  getCapabilities(modelId: string): Promise<ModelCapabilities | undefined>;
  streamChat(
    request: NormalizedChatRequest
  ): AsyncIterable<NormalizedGenerationEvent>;
}

