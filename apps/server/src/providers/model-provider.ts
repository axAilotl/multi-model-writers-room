import type {
  ModelCapabilities,
  ModelDescriptor,
  NormalizedChatRequest,
  NormalizedGenerationEvent,
  ProviderExecutionProfile,
  StatefulParticipantTurnRequest
} from "@writers-room/contracts";

export type { ModelDescriptor } from "@writers-room/contracts";

export const statelessModelExecution: ProviderExecutionProfile = {
  semantics: "stateless-model",
  personaAuthority: "local",
  allowedCalls: {
    participantGeneration: true,
    activation: true,
    deliberation: true,
    housekeeping: true,
    toolLoop: true
  }
};

export const statefulCompanionExecution: ProviderExecutionProfile = {
  semantics: "stateful-companion",
  personaAuthority: "remote",
  allowedCalls: {
    participantGeneration: true,
    activation: false,
    deliberation: false,
    housekeeping: false,
    toolLoop: false
  }
};

export interface ModelProvider {
  readonly id: string;
  readonly execution?: ProviderExecutionProfile;
  listModels(): Promise<ModelDescriptor[]>;
  getCapabilities(modelId: string): Promise<ModelCapabilities | undefined>;
  streamChat(
    request: NormalizedChatRequest
  ): AsyncIterable<NormalizedGenerationEvent>;
  streamParticipantTurn?(
    request: StatefulParticipantTurnRequest
  ): AsyncIterable<NormalizedGenerationEvent>;
}
