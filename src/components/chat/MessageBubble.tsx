"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { isFileUIPart, isToolUIPart, type UIMessage } from "ai";
import { Check, Copy, Pencil, RotateCcw } from "lucide-react";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ToolCallCard, type GenericToolPart } from "./ToolCallCard";
import { extractMessageText } from "@/lib/chat-message-parts";
import { formatTokenUsage } from "@/lib/token-usage";

interface MessageBubbleProps {
  message: UIMessage;
  allowEdit?: boolean;
  allowRegenerate?: boolean;
  onEdit?: () => void;
  onRegenerate?: () => void;
  onToolApprovalResponse?: (response: {
    approved: boolean;
    id: string;
    reason?: string;
  }) => void;
}

export function MessageBubble({
  message,
  allowEdit = true,
  allowRegenerate = false,
  onEdit,
  onRegenerate,
  onToolApprovalResponse,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  const textContent = extractMessageText(message.parts);
  const createdAt =
    typeof message.metadata === "object" &&
    message.metadata &&
    "createdAt" in message.metadata &&
    typeof message.metadata.createdAt === "number"
      ? new Date(message.metadata.createdAt * 1000)
      : null;
  const formattedCreatedAt = createdAt ? createdAt.toLocaleString() : null;
  const inputTokens =
    typeof message.metadata === "object" &&
    message.metadata &&
    "inputTokens" in message.metadata &&
    typeof message.metadata.inputTokens === "number"
      ? message.metadata.inputTokens
      : null;
  const outputTokens =
    typeof message.metadata === "object" &&
    message.metadata &&
    "outputTokens" in message.metadata &&
    typeof message.metadata.outputTokens === "number"
      ? message.metadata.outputTokens
      : null;
  const tokenUsageLabel = !isUser
    ? formatTokenUsage({ inputTokens, outputTokens })
    : null;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(textContent);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div
      className={cn(
        "group flex w-full",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "max-w-[85%] space-y-3 rounded-2xl px-4 py-2.5 text-sm",
          isUser
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : "rounded-bl-sm bg-muted text-foreground",
        )}
      >
        <div className="flex items-center justify-between gap-3 opacity-0 transition-opacity group-hover:opacity-100">
          <div className="text-[11px] text-muted-foreground">
            <time dateTime={createdAt?.toISOString()} suppressHydrationWarning>
              {formattedCreatedAt ?? (createdAt ? createdAt.toISOString() : "")}
            </time>
          </div>
          <div className="flex items-center gap-1">
            {isUser && onEdit ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={onEdit}
                disabled={!allowEdit}
                title="Edit message"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            ) : null}
            {!isUser && onRegenerate ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={onRegenerate}
                disabled={!allowRegenerate}
                title="Regenerate response"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => void handleCopy()}
              title="Copy message"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>

        {message.parts.map((part, index) => {
          if (part.type === "text") {
            return isUser ? (
              <span key={index} className="whitespace-pre-wrap">
                {part.text}
              </span>
            ) : (
              <div
                key={index}
                className="prose prose-sm max-w-none dark:prose-invert prose-pre:overflow-x-auto prose-pre:rounded-md prose-pre:bg-muted prose-pre:p-3"
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    code(props) {
                      const { className, children, ...rest } = props;
                      const isInline = !className;

                      if (isInline) {
                        return (
                          <code
                            {...rest}
                            className="rounded bg-background/70 px-1 py-0.5 font-mono text-sm"
                          >
                            {children}
                          </code>
                        );
                      }

                      return (
                        <code {...rest} className={className}>
                          {children}
                        </code>
                      );
                    },
                    table(props) {
                      return (
                        <div className="my-4 overflow-x-auto">
                          <table {...props} />
                        </div>
                      );
                    },
                  }}
                >
                  {part.text}
                </ReactMarkdown>
              </div>
            );
          }

          if (isFileUIPart(part)) {
            const isImage = part.mediaType.startsWith("image/");

            return (
              <div key={index} className="space-y-2">
                {isImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={part.url}
                    alt={part.filename ?? "Attachment"}
                    className="max-h-80 w-full rounded-xl border border-border/60 object-contain"
                  />
                ) : (
                  <div className="rounded-xl border border-border/60 bg-background/60 px-3 py-2 text-xs">
                    {part.filename ?? "Attachment"}
                  </div>
                )}
                {part.filename ? (
                  <div className="text-[11px] text-muted-foreground">
                    {part.filename}
                  </div>
                ) : null}
              </div>
            );
          }

          if (isToolUIPart(part)) {
            return (
              <ToolCallCard
                key={part.toolCallId}
                part={part as GenericToolPart}
                onApprovalResponse={onToolApprovalResponse}
              />
            );
          }

          return null;
        })}

        {tokenUsageLabel ? (
          <div className="border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
            {tokenUsageLabel}
          </div>
        ) : null}
      </div>
    </div>
  );
}
