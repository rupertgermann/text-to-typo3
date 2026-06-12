"use client";

import { useState } from "react";
import { ArrowRight, Loader2, Settings as SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  ConnectionResult,
  ConnectionTestButton,
} from "@/components/settings/provider-connection-tester";
import { ModelSelector } from "@/components/settings/model-selector";
import { CustomProviderEditor } from "@/components/settings/custom-provider-editor";
import { useSettingsForm } from "@/components/settings/use-settings-form";

interface SettingsModalProps {
  displayName: string;
  typo3BaseUrl: string;
}

export function SettingsModal({
  displayName,
  typo3BaseUrl,
}: SettingsModalProps) {
  const [open, setOpen] = useState(false);
  const form = useSettingsForm({
    open,
    onSaved: () => setOpen(false),
  });

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
            {form.settingsLoading ? (
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
              models={form.openAiModels}
              selectedModelId={form.selectedModelId}
              isLoading={form.modelsLoading}
              provider={form.openAiProvider}
              onSelect={(nextModel) => {
                form.setSelectedModelId(nextModel.id);
                form.setSelectedLmStudioModelId(
                  nextModel.provider === "lmstudio"
                    ? nextModel.id
                    : form.selectedLmStudioModelId,
                );
              }}
            >
              <div className="space-y-2">
                <label className="text-sm font-medium">OpenAI API Key</label>
                <div className="flex gap-2">
                  <Input
                    value={form.openaiKey}
                    onChange={(event) => form.setOpenaiKey(event.target.value)}
                    placeholder={
                      form.settings?.hasOpenAIKey ? "Key configured" : "sk-..."
                    }
                    type="password"
                    className="flex-1"
                  />
                  <ConnectionTestButton
                    isTesting={form.testingConnection === "openai"}
                    onClick={() => void form.testModelConnection("openai")}
                  />
                </div>
                <ConnectionResult status={form.openaiConnection} />
              </div>
            </ModelSelector>

            <CustomProviderEditor
              connections={form.customProviderConnections}
              customProviderById={form.customProviderById}
              isLoadingModels={form.modelsLoading}
              models={form.customModels}
              onAdd={form.addCustomProvider}
              onRemove={form.removeCustomProvider}
              onSelectModel={(nextModel) => {
                form.setSelectedModelId(nextModel.id);
              }}
              onTest={(provider) => void form.testCustomProviderConnection(provider)}
              onUpdate={form.updateCustomProvider}
              providers={form.customProviders}
              selectedModelId={form.selectedModelId}
              testingConnection={form.testingConnection}
            />

            <ModelSelector
              title="LM Studio"
              description="Point the app at a local OpenAI-compatible endpoint."
              emptyMessage="No LM Studio models loaded."
              loadingMessage="LM Studio models loading."
              models={form.lmStudioModels}
              selectedModelId={
                form.selectedModelId || form.selectedLmStudioModelId
              }
              isLoading={
                form.modelsLoading && Boolean(form.lmstudioBaseUrl.trim())
              }
              provider={form.lmStudioProvider}
              onSelect={(nextModel) => {
                form.setSelectedModelId(nextModel.id);
                form.setSelectedLmStudioModelId(nextModel.id);
              }}
            >
              <div className="flex gap-2">
                <Input
                  value={form.lmstudioBaseUrl}
                  onChange={(event) =>
                    form.setLmstudioBaseUrl(event.target.value)
                  }
                  placeholder="http://localhost:1234/v1"
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    void form.refreshModels(
                      form.lmstudioBaseUrl.trim() || undefined,
                    )
                  }
                >
                  Fetch models
                </Button>
                <ConnectionTestButton
                  isTesting={form.testingConnection === "lmstudio"}
                  onClick={() => void form.testModelConnection("lmstudio")}
                />
              </div>
              <ConnectionResult status={form.lmstudioConnection} />
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
                  isTesting={form.testingConnection === "mcp"}
                  label="Test MCP"
                  onClick={() => void form.testMcpConnection()}
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
                <ConnectionResult status={form.mcpConnection} />
              </div>
            </section>

            {form.error ? (
              <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {form.error}
              </div>
            ) : null}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={form.saving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void form.handleSave()}
            disabled={form.saving}
          >
            {form.saving ? "Saving..." : "Save settings"}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
