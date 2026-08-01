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

function environmentConfigurations(environment: Environment): {
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
  }
}

export class ProviderConnectionManager {
  private readonly stored = new Map<ProviderKind, ProviderConnectionConfiguration>();
  private readonly environment: Map<ProviderKind, ProviderConnectionConfiguration>;
  private readonly environmentSources: Map<ProviderKind, "environment" | "built-in">;
  private readonly injected = new Map<ProviderKind, ModelProvider>();

  constructor(
    private readonly store: RoomStore,
    private readonly providers: Map<string, ModelProvider>,
    environment: Environment = {}
  ) {
    for (const kind of providerKinds) {
      const provider = providers.get(kind);
      if (provider) this.injected.set(kind, provider);
    }
    for (const configuration of store.listProviderConnectionConfigurations()) {
      this.stored.set(configuration.provider, configuration);
    }
    const fromEnvironment = environmentConfigurations(environment);
    this.environment = fromEnvironment.configurations;
    this.environmentSources = fromEnvironment.sources;
    for (const kind of providerKinds) this.apply(kind);
  }

  list(): ProviderConnectionStatus[] {
    return providerKinds.map(kind => this.status(kind));
  }

  configure(providerValue: string, updateValue: unknown): ProviderConnectionStatus {
    const provider = providerKindSchema.parse(providerValue);
    const update = providerConnectionUpdateSchema.parse(updateValue);
    const previous = this.stored.get(provider);
    const nextBaseUrl = update.baseUrl === undefined
      ? previous?.baseUrl
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
        : { apiKey: update.apiKey.trim() })
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
    this.store.setProviderConnectionConfiguration(configuration);
    this.stored.set(provider, configuration);
    this.providers.set(provider, instance);
    return this.status(provider);
  }

  remove(providerValue: string): ProviderConnectionStatus {
    const provider = providerKindSchema.parse(providerValue);
    this.store.deleteProviderConnectionConfiguration(provider);
    this.stored.delete(provider);
    this.apply(provider);
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
    return providerConnectionStatusSchema.parse({
      provider,
      configured: this.providers.has(provider),
      ...(effective?.baseUrl === undefined ? {} : { baseUrl: effective.baseUrl }),
      hasApiKey: effective?.apiKey !== undefined,
      endpointSource,
      credentialSource
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
    const baseUrl = saved.baseUrl ?? environment?.baseUrl;
    const environmentCredentialMatchesEndpoint =
      saved.provider === "openrouter" ||
      saved.baseUrl === undefined ||
      saved.baseUrl === environment?.baseUrl;
    const apiKey = saved.apiKey ?? (
      environmentCredentialMatchesEndpoint ? environment?.apiKey : undefined
    );
    return {
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
}
