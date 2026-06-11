"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Loader2,
  PlugZap,
  Plus,
  Settings as SettingsIcon,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  getModelContextWindowLabel,
  getModelContextWindowShortLabel,
  type AvailableModel,
  type ProviderCatalog,
  type UserModelCatalog,
} from "@/lib/models";
import type { PublicCustomProvider, PublicUserSettings } from "@/lib/user-settings";

interface SettingsModalProps {
  displayName: string;
  typo3BaseUrl: string;
}

type RemoteModelCatalog = UserModelCatalog;
const SETTINGS_UPDATED_EVENT = "text-to-typo3-settings-updated";

type ConnectionStatus = {
  tone: "success" | "error";
  message: string;
};

type ConnectionResponse = {
  ok: boolean;
  error?: { message?: string };
  modelCount?: number;
  toolCount?: number;
};

type EditableCustomProvider = PublicCustomProvider & {
  apiKey: string;
};

function ConnectionResult({ status }: { status: ConnectionStatus | null }) {
  if (!status) {
    return null;
  }

  const Icon = status.tone === "success" ? CheckCircle2 : AlertCircle;

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-xs",
        status.tone === "success" ? "text-emerald-600" : "text-destructive",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      <span>{status.message}</span>
    </div>
  );
}

function ProviderStatusLine({
  isLoading,
  provider,
}: {
  isLoading: boolean;
  provider?: ProviderCatalog;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Loading models</span>
      </div>
    );
  }

  if (provider?.status === "unavailable") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-destructive">
        <AlertCircle className="h-3.5 w-3.5" />
        <span>Unavailable</span>
      </div>
    );
  }

  return null;
}

function ModelCard({
  model,
  selected,
  onSelect,
}: {
  model: AvailableModel;
  selected: boolean;
  onSelect: (model: AvailableModel) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(model)}
      title={
        model.description ??
        (model.contextWindow ? `${model.name} • ${model.contextWindow.toLocaleString()} tokens` : model.name)
      }
      className={cn(
        "flex w-full items-start justify-between gap-3 rounded-xl border px-3 py-2 text-left transition-colors",
        selected
          ? "border-primary bg-primary/5"
          : "border-border bg-background hover:bg-muted/50",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{model.name}</span>
          <Badge variant={model.provider === "openai" ? "default" : "secondary"}>
            {model.providerName ?? model.provider}
          </Badge>
          {model.contextWindow ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex items-center rounded-full border border-border/70 bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {getModelContextWindowShortLabel(model.contextWindow)}
                  </span>
                }
              />
              <TooltipContent>
                {getModelContextWindowLabel(model.contextWindow)}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {model.description ??
            (model.contextWindow
              ? `${model.contextWindow.toLocaleString()} token context`
              : "Context window unknown")}
        </p>
        {model.description ? (
          <p className="mt-0.5 text-[11px] text-muted-foreground/80">
            {model.contextWindow
              ? `${model.contextWindow.toLocaleString()} token context`
              : "Context window unknown"}
          </p>
        ) : null}
      </div>
      {selected ? <Check className="mt-0.5 h-4 w-4" /> : null}
    </button>
  );
}

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
          throw new Error("Failed to load settings");
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
        setError("Failed to load settings");
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
          throw new Error("Failed to fetch models");
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
        setError("Failed to fetch models");
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
        throw new Error("Failed to fetch models");
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
        throw new Error("Failed to save settings");
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
          <Button variant="outline" size="sm" className="gap-2">
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

              <section className="space-y-3 rounded-xl border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">AI Model</Badge>
                    <span className="text-sm text-muted-foreground">
                      Select the model used for responses.
                    </span>
                  </div>
                  <ProviderStatusLine
                    isLoading={modelsLoading}
                    provider={openAiProvider}
                  />
                </div>
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
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void testModelConnection("openai")}
                      disabled={testingConnection === "openai"}
                    >
                      {testingConnection === "openai" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <PlugZap className="h-4 w-4" />
                      )}
                      Test
                    </Button>
                  </div>
                  <ConnectionResult status={openaiConnection} />
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {openAiModels.length === 0 ? (
                    <div className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
                      {modelsLoading
                        ? "OpenAI models loading."
                        : "No OpenAI models available yet."}
                    </div>
                  ) : (
                    openAiModels.map((model) => (
                      <ModelCard
                        key={model.id}
                        model={model}
                        selected={selectedModelId === model.id}
                        onSelect={(nextModel) => {
                          setSelectedModelId(nextModel.id);
                          setSelectedLmStudioModelId(
                            nextModel.provider === "lmstudio" ? nextModel.id : selectedLmStudioModelId,
                          );
                        }}
                      />
                    ))
                  )}
                </div>
              </section>

              <section className="space-y-3 rounded-xl border p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">Custom Endpoints</Badge>
                    <span className="text-sm text-muted-foreground">
                      Add OpenAI-compatible providers.
                    </span>
                  </div>
                  <Button type="button" variant="outline" onClick={addCustomProvider}>
                    <Plus className="h-4 w-4" />
                    Add
                  </Button>
                </div>

                <div className="space-y-3">
                  {customProviders.length === 0 ? (
                    <div className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
                      No custom endpoints configured.
                    </div>
                  ) : (
                    customProviders.map((provider) => {
                      const testingId = `custom:${provider.id}`;
                      return (
                        <div
                          key={provider.id}
                          className="space-y-2 rounded-xl border bg-muted/20 p-3"
                        >
                          <div className="grid gap-2 md:grid-cols-[1fr_1.5fr_1fr_auto]">
                            <Input
                              value={provider.displayName}
                              onChange={(event) =>
                                updateCustomProvider(provider.id, {
                                  displayName: event.target.value,
                                })
                              }
                              placeholder="Provider name"
                            />
                            <Input
                              value={provider.baseUrl}
                              onChange={(event) =>
                                updateCustomProvider(provider.id, {
                                  baseUrl: event.target.value,
                                })
                              }
                              placeholder="https://provider.example/v1"
                            />
                            <Input
                              value={provider.apiKey}
                              onChange={(event) =>
                                updateCustomProvider(provider.id, {
                                  apiKey: event.target.value,
                                })
                              }
                              placeholder={provider.hasApiKey ? "Key configured" : "API key"}
                              type="password"
                            />
                            <div className="flex gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() =>
                                  void testCustomProviderConnection(provider)
                                }
                                disabled={testingConnection === testingId}
                              >
                                {testingConnection === testingId ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <PlugZap className="h-4 w-4" />
                                )}
                                Test
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                onClick={() => removeCustomProvider(provider.id)}
                                aria-label="Remove custom endpoint"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                          <ProviderStatusLine
                            isLoading={modelsLoading}
                            provider={customProviderById.get(provider.id)}
                          />
                          <ConnectionResult
                            status={customProviderConnections[provider.id] ?? null}
                          />
                        </div>
                      );
                    })
                  )}
                </div>

                <div className="grid gap-2 md:grid-cols-2">
                  {customModels.length === 0 ? (
                    <div className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
                      {modelsLoading
                        ? "Custom endpoint models loading."
                        : "No custom endpoint models loaded."}
                    </div>
                  ) : (
                    customModels.map((model) => (
                      <ModelCard
                        key={model.id}
                        model={model}
                        selected={selectedModelId === model.id}
                        onSelect={(nextModel) => {
                          setSelectedModelId(nextModel.id);
                        }}
                      />
                    ))
                  )}
                </div>
              </section>

              <section className="space-y-3 rounded-xl border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">LM Studio</Badge>
                    <span className="text-sm text-muted-foreground">
                      Point the app at a local OpenAI-compatible endpoint.
                    </span>
                  </div>
                  <ProviderStatusLine
                    isLoading={modelsLoading && Boolean(lmstudioBaseUrl.trim())}
                    provider={lmStudioProvider}
                  />
                </div>
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
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void testModelConnection("lmstudio")}
                    disabled={testingConnection === "lmstudio"}
                  >
                    {testingConnection === "lmstudio" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <PlugZap className="h-4 w-4" />
                    )}
                    Test
                  </Button>
                </div>
                <ConnectionResult status={lmstudioConnection} />
                <div className="grid gap-2 md:grid-cols-2">
                  {lmStudioModels.length === 0 ? (
                    <div className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
                      {modelsLoading && lmstudioBaseUrl.trim()
                        ? "LM Studio models loading."
                        : "No LM Studio models loaded."}
                    </div>
                  ) : (
                    lmStudioModels.map((model) => (
                      <ModelCard
                        key={model.id}
                        model={model}
                        selected={
                          selectedModelId === model.id ||
                          selectedLmStudioModelId === model.id
                        }
                        onSelect={(nextModel) => {
                          setSelectedModelId(nextModel.id);
                          setSelectedLmStudioModelId(nextModel.id);
                        }}
                      />
                    ))
                  )}
                </div>
              </section>

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
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void testMcpConnection()}
                    disabled={testingConnection === "mcp"}
                  >
                    {testingConnection === "mcp" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <PlugZap className="h-4 w-4" />
                    )}
                    Test MCP
                  </Button>
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

function formatConnectionStatus(
  body: ConnectionResponse,
  noun: "model" | "tool",
): ConnectionStatus {
  if (body.ok) {
    const count = noun === "model" ? body.modelCount : body.toolCount;
    const label = noun === "model" ? "model" : "tool";
    return {
      tone: "success",
      message: `${count ?? 0} ${label}${count === 1 ? "" : "s"} found`,
    };
  }

  return {
    tone: "error",
    message: body.error?.message ?? "Connection failed",
  };
}
