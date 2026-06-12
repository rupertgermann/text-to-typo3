"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  SETTINGS_UPDATED_EVENT,
  useClientQuery,
} from "@/lib/client-query";
import { readApiErrorMessage } from "@/lib/api-client";
import {
  type AvailableModel,
  type ProviderCatalog,
  type UserModelCatalog,
} from "@/lib/models";
import type { PublicUserSettings } from "@/lib/user-settings";
import {
  formatConnectionStatus,
  type ConnectionResponse,
  type ConnectionStatus,
} from "@/components/settings/provider-connection-tester";
import type { EditableCustomProvider } from "@/components/settings/custom-provider-editor";

type ModelCatalogStreamEvent =
  | {
      type: "metadata";
      customProviders: UserModelCatalog["customProviders"];
      hasOpenAIKey: boolean;
      lmstudioBaseUrl: string | null;
      selectedModelId: string | null;
    }
  | { type: "provider"; provider: ProviderCatalog }
  | { type: "done"; catalog: UserModelCatalog };

async function fetchSettings(): Promise<PublicUserSettings> {
  const response = await fetch("/api/settings");

  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, "Failed to load settings"));
  }

  return response.json() as Promise<PublicUserSettings>;
}

function modelsFromProviders(providers: ProviderCatalog[]): AvailableModel[] {
  return [
    ...providers
      .filter((provider) => provider.provider === "openai")
      .flatMap((provider) => provider.models),
    ...providers
      .filter((provider) => provider.provider === "lmstudio")
      .flatMap((provider) => provider.models),
    ...providers
      .filter((provider) => provider.provider === "custom")
      .flatMap((provider) => provider.models)
      .sort((a, b) => a.name.localeCompare(b.name)),
  ];
}

function applyProviderCatalog(
  providers: ProviderCatalog[],
  nextProvider: ProviderCatalog,
): ProviderCatalog[] {
  const nextProviders = providers.filter(
    (provider) => provider.providerId !== nextProvider.providerId,
  );
  nextProviders.push(nextProvider);
  return nextProviders;
}

async function readModelCatalogStream({
  lmstudioBaseUrl,
  onDone,
  onProvider,
  signal,
}: {
  lmstudioBaseUrl?: string;
  onDone: (catalog: UserModelCatalog) => void;
  onProvider: (provider: ProviderCatalog) => void;
  signal: AbortSignal;
}) {
  const query = new URLSearchParams({ stream: "1" });
  if (lmstudioBaseUrl) {
    query.set("lmstudioBaseUrl", lmstudioBaseUrl);
  }

  const response = await fetch(`/api/models?${query.toString()}`, { signal });

  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, "Failed to fetch models"));
  }

  if (!response.body) {
    const catalog: UserModelCatalog = await response.json();
    onDone(catalog);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function processLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const event = JSON.parse(trimmed) as ModelCatalogStreamEvent;
    if (event.type === "provider") {
      onProvider(event.provider);
    }
    if (event.type === "done") {
      onDone(event.catalog);
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      processLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  processLine(buffer);
}

export function useSettingsForm({
  open,
  onSaved,
}: {
  open: boolean;
  onSaved: () => void;
}) {
  const [modelsLoading, setModelsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogState, setCatalogState] = useState<{
    models: AvailableModel[];
    providerCatalogs: ProviderCatalog[];
  }>({ models: [], providerCatalogs: [] });
  const [openaiKey, setOpenaiKey] = useState("");
  const [lmstudioBaseUrl, setLmstudioBaseUrl] = useState("");
  const [customProviders, setCustomProviders] = useState<EditableCustomProvider[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [selectedLmStudioModelId, setSelectedLmStudioModelId] = useState<string>("");
  const [testingConnection, setTestingConnection] = useState<string | null>(null);
  const [lmstudioConnection, setLmstudioConnection] =
    useState<ConnectionStatus | null>(null);
  const [mcpConnection, setMcpConnection] = useState<ConnectionStatus | null>(null);
  const [openaiConnection, setOpenaiConnection] =
    useState<ConnectionStatus | null>(null);
  const [customProviderConnections, setCustomProviderConnections] = useState<
    Record<string, ConnectionStatus | null>
  >({});

  const {
    data: settings,
    error: settingsError,
    isLoading: settingsLoading,
  } = useClientQuery<PublicUserSettings>({
    key: ["settings"],
    fetcher: fetchSettings,
    enabled: open,
    keepPreviousData: true,
    revalidateOn: [SETTINGS_UPDATED_EVENT],
  });

  useEffect(() => {
    if (!settingsError) {
      return;
    }

    setError(settingsError.message);
  }, [settingsError]);

  useEffect(() => {
    if (!open || !settings) {
      return;
    }

    setLmstudioBaseUrl(settings.lmstudioBaseUrl ?? "");
    setCustomProviders(
      settings.customProviders.map((provider) => ({
        ...provider,
        apiKey: "",
      })),
    );
    setSelectedModelId(settings.modelId ?? "");
    setSelectedLmStudioModelId(settings.lmstudioModelId ?? "");
  }, [open, settings]);

  const loadModels = useCallback(async (options?: { lmstudioBaseUrl?: string }) => {
    const controller = new AbortController();
    setModelsLoading(true);
    setError(null);
    setCatalogState({ models: [], providerCatalogs: [] });

    try {
      await readModelCatalogStream({
        lmstudioBaseUrl: options?.lmstudioBaseUrl,
        signal: controller.signal,
        onProvider: (provider) => {
          setCatalogState((current) => {
            const nextProviders = applyProviderCatalog(
              current.providerCatalogs,
              provider,
            );
            return {
              models: modelsFromProviders(nextProviders),
              providerCatalogs: nextProviders,
            };
          });
        },
        onDone: (catalog) => {
          setCatalogState({
            models: catalog.models,
            providerCatalogs: catalog.providers,
          });
        },
      });
    } catch (loadError) {
      if (loadError instanceof Error && loadError.name === "AbortError") {
        return;
      }
      setError(
        loadError instanceof Error ? loadError.message : "Failed to fetch models",
      );
    } finally {
      setModelsLoading(false);
    }

  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    const controller = new AbortController();
    setModelsLoading(true);
    setError(null);
    setCatalogState({ models: [], providerCatalogs: [] });

    void readModelCatalogStream({
      signal: controller.signal,
      onProvider: (provider) => {
        setCatalogState((current) => {
          const nextProviders = applyProviderCatalog(
            current.providerCatalogs,
            provider,
          );
          return {
            models: modelsFromProviders(nextProviders),
            providerCatalogs: nextProviders,
          };
        });
      },
      onDone: (catalog) => {
        setCatalogState({
          models: catalog.models,
          providerCatalogs: catalog.providers,
        });
      },
    })
      .catch((loadError) => {
        if (loadError instanceof Error && loadError.name === "AbortError") {
          return;
        }
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to fetch models",
        );
      })
      .finally(() => {
        setModelsLoading(false);
      });

    return () => controller.abort();
  }, [open]);

  const openAiModels = useMemo(
    () => catalogState.models.filter((model) => model.provider === "openai"),
    [catalogState.models],
  );
  const lmStudioModels = useMemo(
    () => catalogState.models.filter((model) => model.provider === "lmstudio"),
    [catalogState.models],
  );
  const customModels = useMemo(
    () => catalogState.models.filter((model) => model.provider === "custom"),
    [catalogState.models],
  );
  const openAiProvider = catalogState.providerCatalogs.find(
    (provider) => provider.providerId === "openai",
  );
  const lmStudioProvider = catalogState.providerCatalogs.find(
    (provider) => provider.providerId === "lmstudio",
  );
  const customProviderById = useMemo(
    () =>
      new Map(
        catalogState.providerCatalogs
          .filter((provider) => provider.provider === "custom")
          .map((provider) => [provider.providerId, provider]),
      ),
    [catalogState.providerCatalogs],
  );

  async function refreshModels(nextLmStudioBaseUrl?: string) {
    await loadModels({ lmstudioBaseUrl: nextLmStudioBaseUrl });
  }

  async function handleSave() {
    setSaving(true);
    setError(null);

    try {
      const selectedModel = catalogState.models.find(
        (model) => model.id === selectedModelId,
      );
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId: selectedModelId || null,
          openaiApiKey: openaiKey.trim() ? openaiKey : undefined,
          lmstudioBaseUrl: lmstudioBaseUrl.trim() || null,
          lmstudioModelId:
            selectedModel?.provider === "lmstudio"
              ? selectedModel.id
              : selectedLmStudioModelId || null,
          customProviders: customProviders
            .filter(
              (provider) =>
                provider.displayName.trim() || provider.baseUrl.trim(),
            )
            .map((provider) => ({
              id: provider.id,
              displayName: provider.displayName,
              baseUrl: provider.baseUrl,
              apiKey: provider.apiKey.trim()
                ? provider.apiKey.trim()
                : undefined,
            })),
        }),
      });

      if (!response.ok) {
        throw new Error(
          await readApiErrorMessage(response, "Failed to save settings"),
        );
      }

      const nextSettings: PublicUserSettings = await response.json();
      setCustomProviders(
        nextSettings.customProviders.map((provider) => ({
          ...provider,
          apiKey: "",
        })),
      );
      setOpenaiKey("");
      window.dispatchEvent(new Event(SETTINGS_UPDATED_EVENT));
      onSaved();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Failed to save settings",
      );
    } finally {
      setSaving(false);
    }
  }

  async function testMcpConnection() {
    setTestingConnection("mcp");
    setMcpConnection(null);

    try {
      const response = await fetch("/api/settings/test-mcp", { method: "POST" });
      const body: ConnectionResponse = await response.json();
      setMcpConnection(formatConnectionStatus(body, "tool"));
    } catch {
      setMcpConnection({
        tone: "error",
        message: "Connection test failed",
      });
    } finally {
      setTestingConnection(null);
    }
  }

  async function testModelConnection(provider: "lmstudio" | "openai") {
    setTestingConnection(provider);
    const setStatus =
      provider === "openai" ? setOpenaiConnection : setLmstudioConnection;
    setStatus(null);

    try {
      const response = await fetch("/api/settings/test-model-provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          apiKey: provider === "openai" && openaiKey.trim()
            ? openaiKey.trim()
            : undefined,
          baseUrl: provider === "lmstudio" ? lmstudioBaseUrl.trim() : undefined,
        }),
      });
      const body: ConnectionResponse = await response.json();
      setStatus(formatConnectionStatus(body, "model"));
    } catch {
      setStatus({
        tone: "error",
        message: "Connection test failed",
      });
    } finally {
      setTestingConnection(null);
    }
  }

  function updateCustomProvider(
    id: string,
    patch: Partial<EditableCustomProvider>,
  ) {
    setCustomProviders((current) =>
      current.map((provider) =>
        provider.id === id ? { ...provider, ...patch } : provider,
      ),
    );
  }

  function addCustomProvider() {
    const id = crypto.randomUUID().replace(/-/g, "");
    setCustomProviders((current) => [
      ...current,
      {
        id,
        displayName: "",
        baseUrl: "",
        hasApiKey: false,
        apiKey: "",
      },
    ]);
  }

  function removeCustomProvider(id: string) {
    setCustomProviders((current) =>
      current.filter((provider) => provider.id !== id),
    );
    setCustomProviderConnections((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  async function testCustomProviderConnection(provider: EditableCustomProvider) {
    const testingId = `custom:${provider.id}`;
    setTestingConnection(testingId);
    setCustomProviderConnections((current) => ({
      ...current,
      [provider.id]: null,
    }));

    try {
      const response = await fetch("/api/settings/test-model-provider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "custom",
          customProviderId: provider.id,
          apiKey: provider.apiKey.trim() ? provider.apiKey.trim() : undefined,
          baseUrl: provider.baseUrl.trim() || undefined,
        }),
      });
      const body: ConnectionResponse = await response.json();
      setCustomProviderConnections((current) => ({
        ...current,
        [provider.id]: formatConnectionStatus(body, "model"),
      }));
    } catch {
      setCustomProviderConnections((current) => ({
        ...current,
        [provider.id]: {
          tone: "error",
          message: "Connection test failed",
        },
      }));
    } finally {
      setTestingConnection(null);
    }
  }

  return {
    addCustomProvider,
    customModels,
    customProviderById,
    customProviderConnections,
    customProviders,
    error,
    handleSave,
    lmStudioModels,
    lmStudioProvider,
    lmstudioBaseUrl,
    lmstudioConnection,
    mcpConnection,
    modelsLoading,
    openAiModels,
    openAiProvider,
    openaiConnection,
    openaiKey,
    refreshModels,
    removeCustomProvider,
    saving,
    selectedLmStudioModelId,
    selectedModelId,
    setLmstudioBaseUrl,
    setOpenaiKey,
    setSelectedLmStudioModelId,
    setSelectedModelId,
    settings,
    settingsLoading,
    testCustomProviderConnection,
    testMcpConnection,
    testModelConnection,
    testingConnection,
    updateCustomProvider,
  };
}
