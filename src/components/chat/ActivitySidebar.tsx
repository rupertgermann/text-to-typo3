"use client";

import { isToolUIPart, type UIMessage } from "ai";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ToolCallCard, type GenericToolPart } from "./ToolCallCard";
import { getToolIntent } from "./tool-rendering";

function getOperation(part: GenericToolPart): "read" | "write" | "all" {
  return getToolIntent(part);
}

export function ActivitySidebar({
  messages,
  typo3BaseUrl,
}: {
  messages: UIMessage[];
  typo3BaseUrl: string;
}) {
  const [filter, setFilter] = useState<"all" | "read" | "write">("all");

  const toolParts = useMemo(
    () =>
      messages
        .flatMap((message) => message.parts)
        .filter(isToolUIPart)
        .filter((part) => filter === "all" || getOperation(part as GenericToolPart) === filter),
    [filter, messages],
  );

  return (
    <aside className="flex h-full w-full max-w-sm flex-col border-l border-border/70 bg-card/70 backdrop-blur">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-4">
        <div>
          <div className="text-sm font-semibold">Activity</div>
          <div className="text-xs text-muted-foreground">Tool calls in this conversation</div>
        </div>
      </div>

      <div className="flex gap-2 border-b border-border/70 px-4 py-3">
        <Button size="sm" variant={filter === "all" ? "default" : "outline"} onClick={() => setFilter("all")}>
          All
        </Button>
        <Button size="sm" variant={filter === "read" ? "default" : "outline"} onClick={() => setFilter("read")}>
          Reads
        </Button>
        <Button size="sm" variant={filter === "write" ? "default" : "outline"} onClick={() => setFilter("write")}>
          Writes
        </Button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {toolParts.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No tool activity yet.
          </div>
        ) : (
          toolParts.map((part) => (
            <ToolCallCard
              key={part.toolCallId}
              part={part as GenericToolPart}
              compact
              defaultOpen={false}
              typo3BaseUrl={typo3BaseUrl}
            />
          ))
        )}
      </div>
    </aside>
  );
}
