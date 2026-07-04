"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  buildWorkspaceModuleUrl,
  collectPublicUrlAssets,
  getBackendRecordUrl,
  getOperationType,
  getToolName,
  isSuccessfulWorkspaceWrite,
  stripToolOutputMeta,
  type GenericToolPart,
  type PublicUrlAsset,
} from "./tool-rendering";

export type { GenericToolPart } from "./tool-rendering";

function parseObjectInput(input: unknown): Record<string, unknown> | null {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return null;
}

function getApprovalLabel(part: GenericToolPart): string {
  if (part.state === "approval-requested") {
    return "pending approval";
  }

  if (part.state === "output-denied" || part.approval?.approved === false) {
    return "rejected";
  }

  if (part.approval?.approved === true) {
    return "approved";
  }

  const meta =
    part.output && typeof part.output === "object"
      ? (part.output as { _meta?: { approval?: string } })._meta
      : undefined;

  if (meta?.approval === "auto-approved") {
    return "auto-approved";
  }

  return part.state.replace(/-/g, " ");
}

function safeStringify(value: unknown): string {
  if (value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-w-full overflow-hidden whitespace-pre-wrap break-words rounded-md border border-current/10 bg-background/70 p-3 font-mono text-xs leading-5">
      <code className="break-words">{safeStringify(value)}</code>
    </pre>
  );
}

export function ToolCallCard({
  part,
  defaultOpen = false,
  compact = false,
  isPendingApproval = false,
  typo3BaseUrl = "",
  onApprovalResponse,
}: {
  part: GenericToolPart;
  defaultOpen?: boolean;
  compact?: boolean;
  isPendingApproval?: boolean;
  typo3BaseUrl?: string;
  onApprovalResponse?: (response: {
    approved: boolean;
    id: string;
    reason?: string;
  }) => void;
}) {
  const [isOpen, setIsOpen] = useState(
    defaultOpen || part.state === "approval-requested",
  );
  const [rejectionReason, setRejectionReason] = useState("");
  const toolName = useMemo(() => getToolName(part), [part]);
  const operation = useMemo(() => getOperationType(part), [part]);
  const backendRecordUrl = useMemo(() => getBackendRecordUrl(part), [part]);
  const workspaceModuleUrl = useMemo(
    () => buildWorkspaceModuleUrl(typo3BaseUrl),
    [typo3BaseUrl],
  );
  const isQueuedWorkspaceWrite = useMemo(
    () => isSuccessfulWorkspaceWrite(part),
    [part],
  );
  const inputObject = useMemo(() => parseObjectInput(part.input), [part.input]);
  const targetTable =
    typeof inputObject?.table === "string" ? inputObject.table : null;
  const fieldPayload =
    inputObject && "data" in inputObject ? inputObject.data : undefined;
  const approvalLabel = getApprovalLabel(part);

  const toneClasses = {
    read: "border-sky-200 bg-sky-50/70 text-sky-950 dark:border-sky-400/35 dark:bg-sky-950/30 dark:text-sky-100",
    write:
      "border-amber-200 bg-amber-50/80 text-amber-950 dark:border-amber-400/40 dark:bg-amber-950/35 dark:text-amber-100",
    error:
      "border-red-200 bg-red-50/80 text-red-950 dark:border-red-400/40 dark:bg-red-950/35 dark:text-red-100",
  }[operation];

  const output = useMemo(() => stripToolOutputMeta(part.output), [part.output]);
  const publicUrlAssets = useMemo(
    () => collectPublicUrlAssets(output, typo3BaseUrl),
    [output, typo3BaseUrl],
  );

  return (
    <div
      id={`tool-call-${part.toolCallId}`}
      className={cn(
        "min-w-0 scroll-mt-8 overflow-hidden rounded-xl border transition-shadow",
        toneClasses,
        isPendingApproval &&
          "border-amber-500 ring-2 ring-amber-400/70 shadow-lg shadow-amber-950/10",
      )}
    >
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        className={cn(
          "flex w-full items-center justify-between gap-3 px-3 py-2 text-left",
          compact ? "text-xs" : "text-sm",
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {isOpen ? (
            <ChevronDown className="h-4 w-4 shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0" />
          )}
          <span className="min-w-0 max-w-full truncate font-medium">
            {part.title || toolName}
          </span>
          <span className="shrink-0 rounded-full border border-current/15 px-2 py-0.5 text-[10px] uppercase tracking-wide opacity-75">
            {approvalLabel}
          </span>
        </div>

        {backendRecordUrl ? (
          <span className="hidden shrink-0 items-center gap-1 text-[11px] opacity-80 sm:inline-flex">
            Record link
            <ExternalLink className="h-3 w-3" />
          </span>
        ) : null}
      </button>

      {isQueuedWorkspaceWrite && workspaceModuleUrl ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-current/10 bg-background/45 px-3 py-2 text-xs">
          <span className="font-medium">Queued in workspace - not live yet.</span>
          <a
            href={workspaceModuleUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:no-underline"
          >
            Open workspace module
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      ) : null}

      {isOpen ? (
        <div
          className={cn(
            "space-y-3 border-t border-current/10 px-3 py-3",
            compact ? "text-xs" : "text-sm",
          )}
        >
          {targetTable || fieldPayload !== undefined ? (
            <div className="grid min-w-0 gap-2 md:grid-cols-2">
              {targetTable ? (
                <div className="min-w-0 space-y-1">
                  <div className="font-medium opacity-80">Table</div>
                  <div className="break-words rounded-md bg-background/70 p-3 text-xs">
                    {targetTable}
                  </div>
                </div>
              ) : null}

              {fieldPayload !== undefined ? (
                <div className="min-w-0 space-y-1">
                  <div className="font-medium opacity-80">Payload</div>
                  <JsonBlock value={fieldPayload} />
                </div>
              ) : null}
            </div>
          ) : null}

          {part.input !== undefined ? (
            <div className="min-w-0 space-y-1">
              <div className="font-medium opacity-80">Input</div>
              <JsonBlock value={part.input} />
            </div>
          ) : null}

          {part.errorText ? (
            <div className="space-y-1">
              <div className="font-medium opacity-80">Error</div>
              <div className="rounded-md bg-background/70 p-3 text-xs">{part.errorText}</div>
            </div>
          ) : null}

          {output !== undefined ? (
            <div className="min-w-0 space-y-1">
              <div className="font-medium opacity-80">Output</div>
              {publicUrlAssets.length > 0 ? (
                <PublicUrlList assets={publicUrlAssets} />
              ) : null}
              <JsonBlock value={output} />
            </div>
          ) : null}

          {backendRecordUrl ? (
            <div>
              <a href={backendRecordUrl} target="_blank" rel="noreferrer">
                <Button size="sm" variant="outline">
                  Open TYPO3 Record
                </Button>
              </a>
            </div>
          ) : null}

          {part.state === "approval-requested" &&
          part.approval &&
          onApprovalResponse ? (
            <div className="space-y-2 rounded-md bg-background/70 p-3">
              <textarea
                value={rejectionReason}
                onChange={(event) => setRejectionReason(event.target.value)}
                placeholder="Optional rejection reason"
                className="min-h-16 w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() =>
                    onApprovalResponse?.({
                      id: part.approval!.id,
                      approved: true,
                    })
                  }
                >
                  <Check className="h-3.5 w-3.5" />
                  Approve
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onApprovalResponse?.({
                      id: part.approval!.id,
                      approved: false,
                      reason: rejectionReason.trim() || undefined,
                    })
                  }
                >
                  <X className="h-3.5 w-3.5" />
                  Reject
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PublicUrlList({ assets }: { assets: PublicUrlAsset[] }) {
  return (
    <div className="mb-2 grid min-w-0 gap-2">
      {assets.map((asset) => (
        <PublicUrlPreview key={asset.href} asset={asset} />
      ))}
    </div>
  );
}

function PublicUrlPreview({ asset }: { asset: PublicUrlAsset }) {
  const [imageFailed, setImageFailed] = useState(false);
  const showThumbnail = Boolean(asset.thumbnailUrl && !imageFailed);

  return (
    <div className="min-w-0 rounded-md border border-current/10 bg-background/70 p-2">
      {showThumbnail ? (
        <a
          href={asset.href}
          target="_blank"
          rel="noreferrer"
          className="mb-2 block"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={asset.thumbnailUrl ?? undefined}
            alt={asset.displayName}
            loading="lazy"
            onError={() => setImageFailed(true)}
            className="max-h-40 max-w-full rounded-md border border-border/60 bg-background object-contain"
          />
        </a>
      ) : null}
      <a
        href={asset.href}
        target="_blank"
        rel="noreferrer"
        className="inline-flex max-w-full items-center gap-1 break-all text-xs font-medium underline underline-offset-2 hover:no-underline"
      >
        <span className="min-w-0 truncate">{asset.displayName}</span>
        <ExternalLink className="h-3 w-3 shrink-0" />
      </a>
      {asset.mimeType ? (
        <div className="mt-1 text-[11px] opacity-70">{asset.mimeType}</div>
      ) : null}
    </div>
  );
}
