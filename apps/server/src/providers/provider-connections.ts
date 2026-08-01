import {
  providerConnectionStatusSchema,
  providerConnectionUpdateSchema,
  providerKinds,
  providerKindSchema,
  type ProviderConnectionConfiguration,
  type ProviderConnectionStatus,
  type ProviderKind
} from "@writers-room/contracts";
import { RoomStore } from "../storage/room-store.js";
import type { ModelProvider } from "./model-provider.js";
import { createOllamaProvider } from "./ollama.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";
import { createOpenRouterProvider } from "./openrouter.js";
import { normalizePsfnBaseUrl, PsfnProvider } from "./psfn.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";

type Environment = Readonly<Record<string, string | undefined>>;

function optionalSecret(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw Object.assign(new Error("Base URL must be a valid HTTP or HTTPS URL"), {
      status: 400
    });
  }
  if (!(["http:", "https:"] as const).includes(parsed.protocol as "http:" | "https:")) {
    throw Object.assign(new Error("Base URL must use HTTP or HTTPS"), { status: 400 });
  }
  if (parsed.username || parsed.password) {
    throw Object.assign(new Error("Put credentials in the API key field, not the URL"), {
      status: 400
    });
  }
  if (parsed.search || parsed.hash) {
    throw Object.assign(new Error("Base URL cannot contain a query or fragment"), {
      status: 400
    });
  }
  return value.replace(/\/+$/, "");
}

function environmentConfigurations(environment: Environment, psfnEnabled: boolean): {
  configurations: Map<ProviderKind, ProviderConnectionConfiguration>;
  sources: Map<ProviderKind, "environment" | "built-in">;
} {
  const configurations = new Map<ProviderKind, ProviderConnectionConfiguration>();
  const sources = new Map<ProviderKind, "environment" | "built-in">();
  const openRouterKey = optionalSecret(environment.OPENROUTER_API_KEY);
  if (openRouterKey) {
    configurations.set("openrouter", {
      provider: "openrouter",
      baseUrl: OPENROUTER_BASE_URL,
      apiKey: openRouterKey
    });
    sources.set("openrouter", "environment");
  }

  const ollamaEnvironmentUrl = optionalSecret(environment.OLLAMA_BASE_URL);
  const ollamaEnvironmentKey = optionalSecret(environment.OLLAMA_API_KEY);
  configurations.set("ollama", {
    provider: "ollama",
    baseUrl: ollamaEnvironmentUrl ?? DEFAULT_OLLAMA_BASE_URL,
    ...(ollamaEnvironmentKey === undefined
      ? {}
      : { apiKey: ollamaEnvironmentKey })
  });
  sources.set(
    "ollama",
    ollamaEnvironmentUrl ? "environment" : "built-in"
  );

  const compatibleUrl = optionalSecret(environment.OPENAI_COMPATIBLE_BASE_URL);
  if (compatibleUrl) {
    const compatibleKey = optionalSecret(environment.OPENAI_COMPATIBLE_API_KEY);
    configurations.set("openai-compatible", {
      provider: "openai-compatible",
      baseUrl: compatibleUrl,
      ...(compatibleKey === undefined ? {} : { apiKey: compatibleKey })
    });
    sources.set("openai-compatible", "environment");
  }
  const psfnUrl = psfnEnabled ? optionalSecret(environment.PSFN_BASE_URL) : undefined;
  if (psfnUrl) {
    const psfnKey = optionalSecret(environment.PSFN_API_KEY);
    const expectedCompanionId = optionalSecret(environment.PSFN_EXPECTED_COMPANION_ID);
    const parsedContextLength = Number(environment.PSFN_CONTEXT_LENGTH ?? 1_000_000);
    const allowInsecureHttp = environment.PSFN_ALLOW_INSECURE_HTTP === "true";
    configurations.set("psfn", {
      provider: "psfn",
      baseUrl: normalizePsfnBaseUrl(psfnUrl, allowInsecureHttp),
      ...(psfnKey === undefined ? {} : { apiKey: psfnKey }),
      sessionMode: environment.PSFN_SESSION_MODE === "fixed" ? "fixed" : "header",
      ...(expectedCompanionId === undefined ? {} : { expectedCompanionId }),
      contextLength: Number.isInteger(parsedContextLength) && parsedContextLength >= 4_096
        ? Math.min(parsedContextLength, 1_000_000)
        : 1_000_000,
      allowInsecureHttp
    });
    sources.set("psfn", "environment");
  }
  return { configurations, sources };
}

function createProvider(configuration: ProviderConnectionConfiguration): ModelProvider {
  switch (configuration.provider) {
    case "openrouter":
      if (!configuration.apiKey) {
        throw Object.assign(new Error("OpenRouter requires an API key"), { status: 400 });
      }
      return createOpenRouterProvider({
        apiKey: configuration.apiKey,
        appName: "Multi-Model Writers' Room"
      });
    case "ollama":
      return createOllamaProvider({
        ...(configuration.baseUrl === undefined
          ? {}
          : { baseUrl: configuration.baseUrl }),
        ...(configuration.apiKey === undefined
          ? {}
          : { apiKey: configuration.apiKey })
      });
    case "openai-compatible":
      if (!configuration.baseUrl) {
        throw Object.assign(
          new Error("OpenAI-compatible providers require a base URL"),
          { status: 400 }
        );
      }
      return new OpenAiCompatibleProvider({
        id: "openai-compatible",
        baseUrl: configuration.baseUrl,
        ...(configuration.apiKey === undefined
          ? {}
          : { apiKey: configuration.apiKey })
      });
    case "psfn":
      if (!configuration.baseUrl) {
        throw Object.assign(new Error("PSFN requires a base URL"), { status: 400 });
      }
      return new PsfnProvider({
        baseUrl: configuration.baseUrl,
        ...(configuration.apiKey === undefined ? {} : { apiKey: configuration.apiKey }),
        sessionMode: configuration.sessionMode ?? "header",
        ...(configuration.expectedCompanionId === undefined
          ? {}
          : { expectedCompanionId: configuration.expectedCompanionId }),
        ...(configuration.contextLength === undefined
          ? {}
          : { contextLength: configuration.contextLength }),
        allowInsecureHttp: configuration.allowInsecureHttp === true
      });
  }
}

export class ProviderConnectionManager {
  private readonly stored = new Map<ProviderKind, ProviderConnectionConfiguration>();
  private readonly environment: Map<ProviderKind, ProviderConnectionConfiguration>;
  private readonly environmentSources: Map<ProviderKind, "environment" | "built-in">;
  private readonly injected = new Map<ProviderKind, ModelProvider>();
  private readonly psfnEnabled: boolean;
  private readonly enabledKinds: ProviderKind[];

  constructor(
    private readonly store: RoomStore,
    private readonly providers: Map<string, ModelProvider>,
    environment: Environment = {}
  ) {
    this.psfnEnabled = environment.PSFN_PROVIDER_ENABLED === "true";
    this.enabledKinds = providerKinds.filter(kind => kind !== "psfn" || this.psfnEnabled);
    for (const kind of this.enabledKinds) {
      const provider = providers.get(kind);
      if (provider) this.injected.set(kind, provider);
    }
    for (const configuration of store.listProviderConnectionConfigurations()) {
      if (configuration.provider === "psfn" && !this.psfnEnabled) continue;
      this.stored.set(configuration.provider, configuration);
    }
    const fromEnvironment = environmentConfigurations(environment, this.psfnEnabled);
    this.environment = fromEnvironment.configurations;
    this.environmentSources = fromEnvironment.sources;
    for (const kind of this.enabledKinds) this.apply(kind);
    if (!this.psfnEnabled) this.providers.delete("psfn");
  }

  list(): ProviderConnectionStatus[] {
    return this.enabledKinds.map(kind => this.status(kind));
  }

  async configure(
    providerValue: string,
    updateValue: unknown
  ): Promise<ProviderConnectionStatus> {
    const provider = providerKindSchema.parse(providerValue);
    this.requireEnabled(provider);
    const update = providerConnectionUpdateSchema.parse(updateValue);
    const previous = this.stored.get(provider);
    const previousPinnedCompanionId = previous?.expectedCompanionId ??
      this.environment.get(provider)?.expectedCompanionId;
    const allowInsecureHttp = update.allowInsecureHttp ??
      previous?.allowInsecureHttp ??
      this.environment.get(provider)?.allowInsecureHttp ??
      false;
    const nextBaseUrl = update.baseUrl === undefined
      ? previous?.baseUrl
      : provider === "psfn"
        ? normalizePsfnBaseUrl(update.baseUrl.trim(), allowInsecureHttp)
        : normalizeBaseUrl(update.baseUrl);
    const previousBaseUrl = previous?.baseUrl ?? this.environment.get(provider)?.baseUrl;
    const endpointChanged = nextBaseUrl !== undefined &&
      previousBaseUrl !== undefined &&
      nextBaseUrl !== previousBaseUrl;
    const configuration: ProviderConnectionConfiguration = {
      provider,
      ...(nextBaseUrl === undefined ? {} : { baseUrl: nextBaseUrl }),
      ...(update.apiKey === undefined
        ? endpointChanged || previous?.apiKey === undefined
          ? {}
          : { apiKey: previous.apiKey }
        : { apiKey: update.apiKey.trim() }),
      ...((update.sessionMode ?? previous?.sessionMode) === undefined
        ? {}
        : { sessionMode: update.sessionMode ?? previous?.sessionMode }),
      ...((update.expectedCompanionId ?? previous?.expectedCompanionId) === undefined
        ? {}
        : {
            expectedCompanionId:
              update.expectedCompanionId ?? previous?.expectedCompanionId
          }),
      ...((update.contextLength ?? previous?.contextLength) === undefined
        ? {}
        : { contextLength: update.contextLength ?? previous?.contextLength }),
      ...((update.allowInsecureHttp ?? previous?.allowInsecureHttp) === undefined
        ? {}
        : {
            allowInsecureHttp:
              update.allowInsecureHttp ?? previous?.allowInsecureHttp
          })
    };
    if (provider === "openrouter") configuration.baseUrl = OPENROUTER_BASE_URL;
    if (provider === "ollama" && configuration.baseUrl === undefined) {
      configuration.baseUrl = this.environment.get(provider)?.baseUrl ??
        DEFAULT_OLLAMA_BASE_URL;
    }
    const effective = this.mergeWithEnvironment(configuration);
    // Construct before writing so invalid or incomplete settings do not break
    // a currently working connection.
    const instance = createProvider(effective);
    if (instance instanceof PsfnProvider && configuration.baseUrl !== undefined) {
      configuration.baseUrl = instance.baseUrl;
    }
    let psfnIdentity: Awaited<ReturnType<PsfnProvider["connect"]>> | undefined;
    if (instance instanceof PsfnProvider) {
      const identity = await instance.connect();
      psfnIdentity = identity;
      if (!configuration.expectedCompanionId) {
        instance.pinExpectedIdentity(identity.companionId);
        configuration.expectedCompanionId = identity.companionId;
      }
    }
    if (
      psfnIdentity &&
      previousPinnedCompanionId &&
      configuration.expectedCompanionId !== previousPinnedCompanionId
    ) {
      this.store.acceptPsfnProviderIdentityChange(
        configuration,
        previousPinnedCompanionId,
        psfnIdentity.modelId,
        psfnIdentity.companionName
      );
    } else {
      this.store.setProviderConnectionConfiguration(configuration);
    }
    this.stored.set(provider, configuration);
    this.providers.set(provider, instance);
    if (psfnIdentity) {
      this.store.ensurePsfnVoiceTemplate({
        companionName: psfnIdentity.companionName,
        modelId: psfnIdentity.modelId
      });
    }
    return this.status(provider);
  }

  remove(providerValue: string): ProviderConnectionStatus {
    const provider = providerKindSchema.parse(providerValue);
    this.requireEnabled(provider);
    this.store.deleteProviderConnectionConfiguration(provider);
    this.stored.delete(provider);
    this.apply(provider);
    return this.status(provider);
  }

  async test(
    providerValue: string,
    acceptIdentityChange = false
  ): Promise<ProviderConnectionStatus> {
    const provider = providerKindSchema.parse(providerValue);
    this.requireEnabled(provider);
    const instance = this.providers.get(provider);
    if (!instance) throw Object.assign(new Error(`Provider is not configured: ${provider}`), {
      status: 409
    });
    if (!(instance instanceof PsfnProvider)) {
      await instance.listModels();
      return this.status(provider);
    }
    try {
      const identity = await instance.verifyConnection(AbortSignal.timeout(30_000));
      const saved = this.stored.get(provider) ?? { provider };
      if (!saved.expectedCompanionId) {
        const pinned = { ...saved, expectedCompanionId: identity.companionId };
        instance.pinExpectedIdentity(identity.companionId);
        this.store.setProviderConnectionConfiguration(pinned);
        this.stored.set(provider, pinned);
      }
      this.store.ensurePsfnVoiceTemplate({
        companionName: identity.companionName,
        modelId: identity.modelId
      });
    } catch (error) {
      const observed = instance.lastObservedIdentity;
      if (!acceptIdentityChange || !observed) throw error;
      const saved = this.stored.get(provider) ?? { provider };
      const previousPinnedCompanionId = saved.expectedCompanionId ??
        this.environment.get(provider)?.expectedCompanionId;
      const accepted = { ...saved, expectedCompanionId: observed.companionId };
      const effective = this.mergeWithEnvironment(accepted);
      const replacement = createProvider(effective);
      if (!(replacement instanceof PsfnProvider)) throw error;
      const replacementIdentity = await replacement.connect();
      if (
        previousPinnedCompanionId &&
        previousPinnedCompanionId !== observed.companionId
      ) {
        this.store.acceptPsfnProviderIdentityChange(
          accepted,
          previousPinnedCompanionId,
          replacementIdentity.modelId,
          replacementIdentity.companionName
        );
      } else {
        this.store.setProviderConnectionConfiguration(accepted);
      }
      this.stored.set(provider, accepted);
      this.providers.set(provider, replacement);
      this.store.ensurePsfnVoiceTemplate({
        companionName: replacementIdentity.companionName,
        modelId: replacementIdentity.modelId
      });
    }
    return this.status(provider);
  }

  private status(provider: ProviderKind): ProviderConnectionStatus {
    const effective = this.effective(provider);
    const saved = this.stored.get(provider);
    const environment = this.environment.get(provider);
    const usesInjected = saved === undefined && this.injected.has(provider);
    const endpointSource = usesInjected
      ? "runtime"
      : saved?.baseUrl !== undefined
      ? "settings"
      : environment?.baseUrl !== undefined
        ? this.environmentSources.get(provider) ?? "environment"
        : this.injected.has(provider) ? "runtime" : "none";
    const credentialSource = effective?.apiKey === undefined
      ? "none"
      : saved?.apiKey !== undefined
        ? "settings"
        : environment?.apiKey !== undefined
          ? "environment"
          : "runtime";
    const psfn = this.providers.get(provider);
    const psfnProvider = psfn instanceof PsfnProvider ? psfn : undefined;
    const identity = psfnProvider?.connectedIdentity ?? psfnProvider?.lastObservedIdentity;
    return providerConnectionStatusSchema.parse({
      provider,
      configured: this.providers.has(provider),
      ...(effective?.baseUrl === undefined ? {} : { baseUrl: effective.baseUrl }),
      hasApiKey: effective?.apiKey !== undefined,
      endpointSource,
      credentialSource,
      ...(provider !== "psfn" ? {} : {
        sessionMode: effective?.sessionMode ?? "header",
        ...(effective?.expectedCompanionId === undefined
          ? {}
          : { expectedCompanionId: effective.expectedCompanionId }),
        ...(identity === undefined ? {} : {
          remoteCompanionId: identity.companionId,
          remoteCompanionName: identity.companionName
        }),
        contextLength: effective?.contextLength ?? 1_000_000,
        connectionState: psfnProvider?.connectionState ??
          (this.providers.has(provider) ? "untested" : "unconfigured")
      })
    });
  }

  private effective(provider: ProviderKind): ProviderConnectionConfiguration | undefined {
    const saved = this.stored.get(provider);
    if (saved) return this.mergeWithEnvironment(saved);
    if (this.injected.has(provider)) return undefined;
    return this.environment.get(provider);
  }

  private mergeWithEnvironment(
    saved: ProviderConnectionConfiguration
  ): ProviderConnectionConfiguration {
    const environment = this.environment.get(saved.provider);
    const {
      apiKey: _environmentApiKey,
      baseUrl: _environmentBaseUrl,
      ...environmentMetadata
    } = environment ?? { provider: saved.provider };
    const baseUrl = saved.baseUrl ?? environment?.baseUrl;
    const environmentCredentialMatchesEndpoint =
      saved.provider === "openrouter" ||
      saved.baseUrl === undefined ||
      saved.baseUrl === environment?.baseUrl;
    const apiKey = saved.apiKey ?? (
      environmentCredentialMatchesEndpoint ? environment?.apiKey : undefined
    );
    return {
      ...environmentMetadata,
      ...saved,
      provider: saved.provider,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(apiKey === undefined ? {} : { apiKey })
    };
  }

  private apply(provider: ProviderKind): void {
    const effective = this.effective(provider);
    if (effective) {
      this.providers.set(provider, createProvider(effective));
      return;
    }
    const injected = this.injected.get(provider);
    if (injected) this.providers.set(provider, injected);
    else this.providers.delete(provider);
  }

  private requireEnabled(provider: ProviderKind): void {
    if (provider === "psfn" && !this.psfnEnabled) {
      throw Object.assign(
        new Error("PSFN provider is disabled. Set PSFN_PROVIDER_ENABLED=true to enable it."),
        { status: 404 }
      );
    }
  }
}
