"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ToolState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied";

export interface GenericToolPart {
  type: string;
  toolCallId: string;
  state: ToolState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: {
    id: string;
    approved?: boolean;
    reason?: string;
  };
  providerExecuted?: boolean;
  title?: string;
  toolName?: string;
}

function getToolName(part: GenericToolPart): string {
  if (part.toolName) {
    return part.toolName;
  }

  return part.type.replace(/^tool-/, "");
}

function getOperationType(part: GenericToolPart): "read" | "write" | "error" | "unknown" {
  if (part.state === "output-error") {
    return "error";
  }

  const meta =
    part.output && typeof part.output === "object"
      ? (part.output as { _meta?: { operation?: string } })._meta
      : undefined;

  if (meta?.operation === "read" || meta?.operation === "write") {
    return meta.operation;
  }

  const toolName = getToolName(part);

  if (/write|create|update|delete|translate/i.test(toolName)) {
    return "write";
  }

  if (/get|read|search|list/i.test(toolName)) {
    return "read";
  }

  return "unknown";
}

function getBackendRecordUrl(part: GenericToolPart): string | null {
  if (!part.output || typeof part.output !== "object") {
    return null;
  }

  const meta = (part.output as { _meta?: { backendRecordUrl?: string | null } })._meta;
  return meta?.backendRecordUrl || null;
}

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
  onApprovalResponse,
}: {
  part: GenericToolPart;
  defaultOpen?: boolean;
  compact?: boolean;
  isPendingApproval?: boolean;
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
    unknown:
      "border-border bg-muted/40 text-foreground dark:bg-muted/50",
  }[operation];

  const output = part.output && typeof part.output === "object"
    ? Object.fromEntries(
        Object.entries(part.output as Record<string, unknown>).filter(
          ([key]) => key !== "_meta",
        ),
      )
    : part.output;

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
