import type {
  ModelCapabilities,
  ModelDescriptor,
  NormalizedChatRequest,
  NormalizedGenerationEvent
} from "@writers-room/contracts";

export type { ModelDescriptor } from "@writers-room/contracts";

export interface ModelProvider {
  readonly id: string;
  listModels(): Promise<ModelDescriptor[]>;
  getCapabilities(modelId: string): Promise<ModelCapabilities | undefined>;
  streamChat(
    request: NormalizedChatRequest
  ): AsyncIterable<NormalizedGenerationEvent>;
}
