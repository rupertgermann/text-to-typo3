"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
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
  title?: string;
}

function getToolName(part: GenericToolPart): string {
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

export function ToolCallCard({
  part,
  defaultOpen = false,
  compact = false,
}: {
  part: GenericToolPart;
  defaultOpen?: boolean;
  compact?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const toolName = useMemo(() => getToolName(part), [part]);
  const operation = useMemo(() => getOperationType(part), [part]);
  const backendRecordUrl = useMemo(() => getBackendRecordUrl(part), [part]);

  const toneClasses = {
    read: "border-sky-200 bg-sky-50/70 text-sky-950",
    write: "border-amber-200 bg-amber-50/80 text-amber-950",
    error: "border-red-200 bg-red-50/80 text-red-950",
    unknown: "border-border bg-muted/40 text-foreground",
  }[operation];

  const output = part.output && typeof part.output === "object"
    ? Object.fromEntries(
        Object.entries(part.output as Record<string, unknown>).filter(
          ([key]) => key !== "_meta",
        ),
      )
    : part.output;

  return (
    <div className={cn("rounded-xl border", toneClasses)}>
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        className={cn(
          "flex w-full items-center justify-between gap-3 px-3 py-2 text-left",
          compact ? "text-xs" : "text-sm",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
          <span className="truncate font-medium">{part.title || toolName}</span>
          <span className="rounded-full border border-current/15 px-2 py-0.5 text-[10px] uppercase tracking-wide opacity-75">
            {part.state.replace(/-/g, " ")}
          </span>
        </div>

        {backendRecordUrl ? (
          <span className="inline-flex items-center gap-1 text-[11px] opacity-80">
            Record link
            <ExternalLink className="h-3 w-3" />
          </span>
        ) : null}
      </button>

      {isOpen ? (
        <div className={cn("space-y-3 border-t border-current/10 px-3 py-3", compact ? "text-xs" : "text-sm")}>
          {part.input !== undefined ? (
            <div className="space-y-1">
              <div className="font-medium opacity-80">Input</div>
              <pre className="overflow-x-auto rounded-md bg-background/70 p-3 text-xs">
                <code>{safeStringify(part.input)}</code>
              </pre>
            </div>
          ) : null}

          {part.errorText ? (
            <div className="space-y-1">
              <div className="font-medium opacity-80">Error</div>
              <div className="rounded-md bg-background/70 p-3 text-xs">{part.errorText}</div>
            </div>
          ) : null}

          {output !== undefined ? (
            <div className="space-y-1">
              <div className="font-medium opacity-80">Output</div>
              <pre className="overflow-x-auto rounded-md bg-background/70 p-3 text-xs">
                <code>{safeStringify(output)}</code>
              </pre>
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
        </div>
      ) : null}
    </div>
  );
}
