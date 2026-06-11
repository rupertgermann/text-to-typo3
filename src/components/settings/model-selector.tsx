"use client";

import type { ReactNode } from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  getModelContextWindowLabel,
  getModelContextWindowShortLabel,
  type AvailableModel,
  type ProviderCatalog,
} from "@/lib/models";

export function ProviderStatusLine({
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

export function ModelCard({
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
        (model.contextWindow
          ? `${model.name} • ${model.contextWindow.toLocaleString()} tokens`
          : model.name)
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

export function ModelSelector({
  children,
  description,
  emptyMessage,
  loadingMessage,
  models,
  onSelect,
  provider,
  selectedModelId,
  title,
  isLoading,
}: {
  children?: ReactNode;
  description: string;
  emptyMessage: string;
  loadingMessage: string;
  models: AvailableModel[];
  onSelect: (model: AvailableModel) => void;
  provider?: ProviderCatalog;
  selectedModelId: string;
  title: string;
  isLoading: boolean;
}) {
  return (
    <section className="space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{title}</Badge>
          <span className="text-sm text-muted-foreground">{description}</span>
        </div>
        <ProviderStatusLine isLoading={isLoading} provider={provider} />
      </div>
      {children}
      <div className="grid gap-2 md:grid-cols-2">
        {models.length === 0 ? (
          <div className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
            {isLoading ? loadingMessage : emptyMessage}
          </div>
        ) : (
          models.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              selected={selectedModelId === model.id}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </section>
  );
}
