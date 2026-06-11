"use client";

import { AlertCircle, CheckCircle2, Loader2, PlugZap, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ConnectionStatus = {
  tone: "success" | "error";
  message: string;
};

export type ConnectionResponse = {
  ok: boolean;
  error?: { message?: string };
  modelCount?: number;
  toolCount?: number;
};

export function ConnectionResult({ status }: { status: ConnectionStatus | null }) {
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

export function ConnectionTestButton({
  disabled,
  icon: Icon = PlugZap,
  isTesting,
  label = "Test",
  onClick,
}: {
  disabled?: boolean;
  icon?: LucideIcon;
  isTesting: boolean;
  label?: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      disabled={disabled ?? isTesting}
    >
      {isTesting ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Icon className="h-4 w-4" />
      )}
      {label}
    </Button>
  );
}

export function formatConnectionStatus(
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
