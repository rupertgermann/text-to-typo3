"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  getModelContextWindowLabel,
  getModelContextWindowShortLabel,
  type AvailableModel,
  type UserModelCatalog,
} from "@/lib/models";

const SETTINGS_UPDATED_EVENT = "text-to-typo3-settings-updated";

function ModelContextChip({ model }: { model: AvailableModel }) {
  const shortLabel = getModelContextWindowShortLabel(model.contextWindow);
  const fullLabel = getModelContextWindowLabel(model.contextWindow);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex items-center rounded-full border border-border/70 bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {shortLabel}
          </span>
        }
      />
      <TooltipContent>{fullLabel}</TooltipContent>
    </Tooltip>
  );
}

export function ModelPickerDropdown({
  className,
}: {
  className?: string;
}) {
  const [catalog, setCatalog] = useState<UserModelCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingModelId, setSavingModelId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadCatalog() {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/models");

      if (!response.ok) {
        throw new Error("Failed to load models");
      }

      const nextCatalog: UserModelCatalog = await response.json();
      setCatalog(nextCatalog);
    } catch {
      setError("Failed to load models");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCatalog();

    const refresh = () => {
      void loadCatalog();
    };

    window.addEventListener(SETTINGS_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, refresh);
  }, []);

  const selectedModel =
    catalog?.models.find((model) => model.id === catalog.selectedModelId) ?? null;

  async function handleSelectModel(model: AvailableModel) {
    if (catalog?.selectedModelId === model.id) {
      return;
    }

    setSavingModelId(model.id);
    setError(null);

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId: model.id,
          lmstudioModelId: model.provider === "lmstudio" ? model.id : undefined,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to save model selection");
      }

      setCatalog((current) =>
        current
          ? {
              ...current,
              selectedModelId: model.id,
            }
          : current,
      );

      window.dispatchEvent(new Event(SETTINGS_UPDATED_EVENT));
    } catch {
      setError("Failed to save model selection");
    } finally {
      setSavingModelId(null);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              "min-w-0 max-w-72 justify-between gap-2",
              className,
            )}
          >
            <span className="flex min-w-0 flex-1 flex-col items-start text-left leading-tight">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Model
              </span>
              <span className="truncate text-sm font-medium">
                {selectedModel?.name ?? (loading ? "Loading models..." : "Select model")}
              </span>
            </span>

            <span className="flex items-center gap-2">
              {selectedModel ? (
                <>
                  <Badge variant="secondary" className="hidden sm:inline-flex">
                    {selectedModel.provider}
                  </Badge>
                  <ModelContextChip model={selectedModel} />
                </>
              ) : null}
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </span>
          </Button>
        }
      />

      <DropdownMenuContent className="w-[min(28rem,calc(100vw-1rem))]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Choose a model</DropdownMenuLabel>
        </DropdownMenuGroup>

        {error ? (
          <div className="px-2 py-2 text-sm text-destructive">{error}</div>
        ) : null}

        {catalog?.models.length ? (
          <DropdownMenuRadioGroup
            value={catalog.selectedModelId ?? ""}
            onValueChange={(value) => {
              const model = catalog.models.find((entry) => entry.id === value);
              if (model) {
                void handleSelectModel(model);
              }
            }}
          >
            {catalog.models.map((model) => {
              const isSaving = savingModelId === model.id;

              return (
                <DropdownMenuRadioItem
                  key={model.id}
                  value={model.id}
                  closeOnClick
                  className="items-start gap-3 py-2"
                >
                  <span className="mt-0.5 flex h-4 w-4 items-center justify-center">
                    {isSaving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <span className="h-3.5 w-3.5" />
                    )}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {model.name}
                      </span>
                      <Badge variant={model.provider === "openai" ? "default" : "secondary"}>
                        {model.provider}
                      </Badge>
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {getModelContextWindowLabel(model.contextWindow)}
                    </span>
                  </span>

                  <ModelContextChip model={model} />
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        ) : loading ? (
          <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading available models...
          </div>
        ) : (
          <div className="px-2 py-2 text-sm text-muted-foreground">
            No models are available yet. Add an OpenAI key or LM Studio endpoint in settings.
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
