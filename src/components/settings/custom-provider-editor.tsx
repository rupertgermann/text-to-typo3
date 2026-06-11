"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  ConnectionResult,
  ConnectionTestButton,
  type ConnectionStatus,
} from "@/components/settings/provider-connection-tester";
import { ModelCard, ProviderStatusLine } from "@/components/settings/model-selector";
import type { AvailableModel, ProviderCatalog } from "@/lib/models";
import type { PublicCustomProvider } from "@/lib/user-settings";

export type EditableCustomProvider = PublicCustomProvider & {
  apiKey: string;
};

export function CustomProviderEditor({
  connections,
  customProviderById,
  isLoadingModels,
  models,
  onAdd,
  onRemove,
  onSelectModel,
  onTest,
  onUpdate,
  providers,
  selectedModelId,
  testingConnection,
}: {
  connections: Record<string, ConnectionStatus | null>;
  customProviderById: Map<string, ProviderCatalog>;
  isLoadingModels: boolean;
  models: AvailableModel[];
  onAdd: () => void;
  onRemove: (id: string) => void;
  onSelectModel: (model: AvailableModel) => void;
  onTest: (provider: EditableCustomProvider) => void;
  onUpdate: (id: string, patch: Partial<EditableCustomProvider>) => void;
  providers: EditableCustomProvider[];
  selectedModelId: string;
  testingConnection: string | null;
}) {
  return (
    <section className="space-y-3 rounded-xl border p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge variant="secondary">Custom Endpoints</Badge>
          <span className="text-sm text-muted-foreground">
            Add OpenAI-compatible providers.
          </span>
        </div>
        <Button type="button" variant="outline" onClick={onAdd}>
          <Plus className="h-4 w-4" />
          Add
        </Button>
      </div>

      <div className="space-y-3">
        {providers.length === 0 ? (
          <div className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
            No custom endpoints configured.
          </div>
        ) : (
          providers.map((provider) => {
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
                      onUpdate(provider.id, {
                        displayName: event.target.value,
                      })
                    }
                    placeholder="Provider name"
                  />
                  <Input
                    value={provider.baseUrl}
                    onChange={(event) =>
                      onUpdate(provider.id, {
                        baseUrl: event.target.value,
                      })
                    }
                    placeholder="https://provider.example/v1"
                  />
                  <Input
                    value={provider.apiKey}
                    onChange={(event) =>
                      onUpdate(provider.id, {
                        apiKey: event.target.value,
                      })
                    }
                    placeholder={provider.hasApiKey ? "Key configured" : "API key"}
                    type="password"
                  />
                  <div className="flex gap-2">
                    <ConnectionTestButton
                      isTesting={testingConnection === testingId}
                      onClick={() => onTest(provider)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => onRemove(provider.id)}
                      aria-label="Remove custom endpoint"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <ProviderStatusLine
                  isLoading={isLoadingModels}
                  provider={customProviderById.get(provider.id)}
                />
                <ConnectionResult status={connections[provider.id] ?? null} />
              </div>
            );
          })
        )}
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        {models.length === 0 ? (
          <div className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
            {isLoadingModels
              ? "Custom endpoint models loading."
              : "No custom endpoint models loaded."}
          </div>
        ) : (
          models.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              selected={selectedModelId === model.id}
              onSelect={onSelectModel}
            />
          ))
        )}
      </div>
    </section>
  );
}
