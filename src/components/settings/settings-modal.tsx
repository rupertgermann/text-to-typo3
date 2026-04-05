"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  Loader2,
  Settings as SettingsIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AvailableModel, UserModelCatalog } from "@/lib/models";
import type { PublicUserSettings } from "@/lib/user-settings";

interface SettingsModalProps {
  displayName: string;
  typo3BaseUrl: string;
}

type RemoteModelCatalog = UserModelCatalog;

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
      title={model.contextWindow ? `${model.name} • ${model.contextWindow.toLocaleString()} tokens` : model.name}
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
            {model.provider}
          </Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {model.contextWindow
            ? `${model.contextWindow.toLocaleString()} token context`
            : "Context window unknown"}
        </p>
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
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<PublicUserSettings | null>(null);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [openaiKey, setOpenaiKey] = useState("");
  const [lmstudioBaseUrl, setLmstudioBaseUrl] = useState("");
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [selectedLmStudioModelId, setSelectedLmStudioModelId] = useState<string>("");

  const openAiModels = useMemo(
    () => models.filter((model) => model.provider === "openai"),
    [models],
  );
  const lmStudioModels = useMemo(
    () => models.filter((model) => model.provider === "lmstudio"),
    [models],
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const [settingsResponse, modelsResponse] = await Promise.all([
          fetch("/api/settings", { signal: controller.signal }),
          fetch("/api/models", { signal: controller.signal }),
        ]);

        if (!settingsResponse.ok || !modelsResponse.ok) {
          throw new Error("Failed to load settings");
        }

        const settingsData: PublicUserSettings = await settingsResponse.json();
        const catalog: RemoteModelCatalog = await modelsResponse.json();

        if (cancelled) {
          return;
        }

        setSettings(settingsData);
        setModels(catalog.models);
        setLmstudioBaseUrl(settingsData.lmstudioBaseUrl ?? "");
        setSelectedModelId(settingsData.modelId ?? "");
        setSelectedLmStudioModelId(settingsData.lmstudioModelId ?? "");
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === "AbortError") {
          return;
        }
        setError("Failed to load settings");
      } finally {
        setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open]);

  async function refreshModels(nextLmStudioBaseUrl?: string) {
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
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Failed to fetch models",
      );
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
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to save settings");
      }

      const nextSettings: PublicUserSettings = await response.json();
      setSettings(nextSettings);
      setOpenaiKey("");
      setOpen(false);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Failed to save settings",
      );
    } finally {
      setSaving(false);
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
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure your model, LM Studio endpoint, and account details.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 rounded-xl border px-3 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading settings...
          </div>
        ) : (
          <ScrollArea className="max-h-[70vh] pr-2">
            <div className="space-y-6 pb-2">
              <section className="space-y-3 rounded-xl border p-4">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">AI Model</Badge>
                  <span className="text-sm text-muted-foreground">
                    Select the model used for responses.
                  </span>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">OpenAI API Key</label>
                  <Input
                    value={openaiKey}
                    onChange={(event) => setOpenaiKey(event.target.value)}
                    placeholder={
                      settings?.hasOpenAIKey ? "Key configured" : "sk-..."
                    }
                    type="password"
                  />
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {openAiModels.length === 0 ? (
                    <div className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
                      No OpenAI models available yet.
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
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">LM Studio</Badge>
                  <span className="text-sm text-muted-foreground">
                    Point the app at a local OpenAI-compatible endpoint.
                  </span>
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
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {lmStudioModels.length === 0 ? (
                    <div className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
                      No LM Studio models loaded.
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
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    window.location.assign("/api/auth/logout");
                  }}
                >
                  Logout
                </Button>
              </section>

              {error ? (
                <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              ) : null}
            </div>
          </ScrollArea>
        )}

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
