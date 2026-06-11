"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Loader2,
  PlugZap,
  Settings as SettingsIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  type AvailableModel,
  type ProviderCatalog,
  type UserModelCatalog,
} from "@/lib/models";
import type { PublicUserSettings } from "@/lib/user-settings";
import { readApiErrorMessage } from "@/lib/api-client";
import {
  ConnectionResult,
  ConnectionTestButton,
  formatConnectionStatus,
  type ConnectionResponse,
  type ConnectionStatus,
} from "@/components/settings/provider-connection-tester";
import {
  ModelCard,
  ModelSelector,
  ProviderStatusLine,
} from "@/components/settings/model-selector";
import {
  CustomProviderEditor,
  type EditableCustomProvider,
} from "@/components/settings/custom-provider-editor";

interface SettingsModalProps {
  displayName: string;
  typo3BaseUrl: string;
}

type RemoteModelCatalog = UserModelCatalog;
const SETTINGS_UPDATED_EVENT = "text-to-typo3-settings-updated";

export function SettingsModal({
  displayName,
  typo3BaseUrl,
}: SettingsModalProps) {
  const [open, setOpen] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<PublicUserSettings | null>(null);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [providerCatalogs, setProviderCatalogs] = useState<ProviderCatalog[]>([]);
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

  const openAiModels = useMemo(
    () => models.filter((model) => model.provider === "openai"),
    [models],
  );
  const lmStudioModels = useMemo(
    () => models.filter((model) => model.provider === "lmstudio"),
    [models],
  );
  const customModels = useMemo(
    () => models.filter((model) => model.provider === "custom"),
    [models],
  );
  const openAiProvider = providerCatalogs.find(
    (provider) => provider.providerId === "openai",
  );
  const lmStudioProvider = providerCatalogs.find(
    (provider) => provider.providerId === "lmstudio",
  );
  const customProviderById = useMemo(
    () =>
      new Map(
        providerCatalogs
          .filter((provider) => provider.provider === "custom")
          .map((provider) => [provider.providerId, provider]),
      ),
    [providerCatalogs],
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    async function loadSettings() {
      setSettingsLoading(true);
      setError(null);

      try {
        const settingsResponse = await fetch("/api/settings", {
          signal: controller.signal,
        });

        if (!settingsResponse.ok) {
          throw new Error(
            await readApiErrorMessage(settingsResponse, "Failed to load settings"),
          );
        }

        const settingsData: PublicUserSettings = await settingsResponse.json();

        if (cancelled) {
          return;
        }

        setSettings(settingsData);
        setLmstudioBaseUrl(settingsData.lmstudioBaseUrl ?? "");
        setCustomProviders(
          settingsData.customProviders.map((provider) => ({
            ...provider,
            apiKey: "",
          })),
        );
        setSelectedModelId(settingsData.modelId ?? "");
        setSelectedLmStudioModelId(settingsData.lmstudioModelId ?? "");
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === "AbortError") {
          return;
        }
        setError(
          loadError instanceof Error ? loadError.message : "Failed to load settings",
        );
      } finally {
        setSettingsLoading(false);
      }
    }

    async function loadModels() {
      setModelsLoading(true);

      try {
        const modelsResponse = await fetch("/api/models", {
          signal: controller.signal,
        });

        if (!modelsResponse.ok) {
          throw new Error(
            await readApiErrorMessage(modelsResponse, "Failed to fetch models"),
          );
        }

        const catalog: RemoteModelCatalog = await modelsResponse.json();

        if (cancelled) {
          return;
        }

        setModels(catalog.models);
        setProviderCatalogs(catalog.providers);
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
    }

    void loadSettings();
    void loadModels();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open]);

  async function refreshModels(nextLmStudioBaseUrl?: string) {
    setModelsLoading(true);
    try {
      const response = await fetch(
        nextLmStudioBaseUrl
          ? `/api/models?lmstudioBaseUrl=${encodeURIComponent(nextLmStudioBaseUrl)}`
          : "/api/models",
      );

      if (!response.ok) {
        throw new Error(
          await readApiErrorMessage(response, "Failed to fetch models"),
        );
      }

      const catalog: RemoteModelCatalog = await response.json();
      setModels(catalog.models);
      setProviderCatalogs(catalog.providers);
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Failed to fetch models",
      );
    } finally {
      setModelsLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);

    try {
      const selectedModel = models.find((model) => model.id === selectedModelId);

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
      setSettings(nextSettings);
      setCustomProviders(
        nextSettings.customProviders.map((provider) => ({
          ...provider,
          apiKey: "",
        })),
      );
      setOpenaiKey("");
      window.dispatchEvent(new Event(SETTINGS_UPDATED_EVENT));
      setOpen(false);
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
          apiKey: provider === "openai" && openaiKey.trim() ? openaiKey.trim() : undefined,
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" className="h-9 gap-2">
            <SettingsIcon className="h-4 w-4" />
            Settings
          </Button>
        }
      />
      <DialogContent className="w-[min(72rem,calc(100vw-2rem))] max-w-none sm:max-w-none">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure your model, LM Studio endpoint, and account details.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[70vh] pr-2">
            <div className="space-y-6 pb-2">
              {settingsLoading ? (
                <div className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading saved settings...
                </div>
              ) : null}

              <ModelSelector
                title="AI Model"
                description="Select the model used for responses."
                emptyMessage="No OpenAI models available yet."
                loadingMessage="OpenAI models loading."
                models={openAiModels}
                selectedModelId={selectedModelId}
                isLoading={modelsLoading}
                provider={openAiProvider}
                onSelect={(nextModel) => {
                  setSelectedModelId(nextModel.id);
                  setSelectedLmStudioModelId(
                    nextModel.provider === "lmstudio"
                      ? nextModel.id
                      : selectedLmStudioModelId,
                  );
                }}
              >
                <div className="space-y-2">
                  <label className="text-sm font-medium">OpenAI API Key</label>
                  <div className="flex gap-2">
                    <Input
                      value={openaiKey}
                      onChange={(event) => setOpenaiKey(event.target.value)}
                      placeholder={
                        settings?.hasOpenAIKey ? "Key configured" : "sk-..."
                      }
                      type="password"
                      className="flex-1"
                    />
                    <ConnectionTestButton
                      isTesting={testingConnection === "openai"}
                      onClick={() => void testModelConnection("openai")}
                    />
                  </div>
                  <ConnectionResult status={openaiConnection} />
                </div>
              </ModelSelector>

              <CustomProviderEditor
                connections={customProviderConnections}
                customProviderById={customProviderById}
                isLoadingModels={modelsLoading}
                models={customModels}
                onAdd={addCustomProvider}
                onRemove={removeCustomProvider}
                onSelectModel={(nextModel) => {
                  setSelectedModelId(nextModel.id);
                }}
                onTest={(provider) => void testCustomProviderConnection(provider)}
                onUpdate={updateCustomProvider}
                providers={customProviders}
                selectedModelId={selectedModelId}
                testingConnection={testingConnection}
              />

              <ModelSelector
                title="LM Studio"
                description="Point the app at a local OpenAI-compatible endpoint."
                emptyMessage="No LM Studio models loaded."
                loadingMessage="LM Studio models loading."
                models={lmStudioModels}
                selectedModelId={selectedModelId || selectedLmStudioModelId}
                isLoading={modelsLoading && Boolean(lmstudioBaseUrl.trim())}
                provider={lmStudioProvider}
                onSelect={(nextModel) => {
                  setSelectedModelId(nextModel.id);
                  setSelectedLmStudioModelId(nextModel.id);
                }}
              >
                <div className="flex gap-2">
                  <Input
                    value={lmstudioBaseUrl}
                    onChange={(event) => setLmstudioBaseUrl(event.target.value)}
                    placeholder="http://localhost:1234/v1"
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void refreshModels(lmstudioBaseUrl.trim() || undefined)}
                  >
                    Fetch models
                  </Button>
                  <ConnectionTestButton
                    isTesting={testingConnection === "lmstudio"}
                    onClick={() => void testModelConnection("lmstudio")}
                  />
                </div>
                <ConnectionResult status={lmstudioConnection} />
              </ModelSelector>

              <section className="space-y-3 rounded-xl border p-4">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">Account</Badge>
                  <span className="text-sm text-muted-foreground">
                    Current TYPO3 identity and instance.
                  </span>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-xl bg-muted/50 p-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      TYPO3 user
                    </div>
                    <div className="mt-1 text-sm font-medium">{displayName}</div>
                  </div>
                  <div className="rounded-xl bg-muted/50 p-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      TYPO3 base URL
                    </div>
                    <div className="mt-1 break-all text-sm font-medium">
                      {typo3BaseUrl}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <ConnectionTestButton
                    isTesting={testingConnection === "mcp"}
                    label="Test MCP"
                    onClick={() => void testMcpConnection()}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      window.location.assign("/api/auth/logout");
                    }}
                  >
                    Logout
                  </Button>
                  <ConnectionResult status={mcpConnection} />
                </div>
              </section>

              {error ? (
                <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              ) : null}
            </div>
          </ScrollArea>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving..." : "Save settings"}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
