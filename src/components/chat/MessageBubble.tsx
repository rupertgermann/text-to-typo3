"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { isToolUIPart, type UIMessage } from "ai";
import { Check, Copy } from "lucide-react";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ToolCallCard, type GenericToolPart } from "./ToolCallCard";

interface MessageBubbleProps {
  message: UIMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  const textContent = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const createdAt =
    typeof message.metadata === "object" &&
    message.metadata &&
    "createdAt" in message.metadata &&
    typeof message.metadata.createdAt === "number"
      ? new Date(message.metadata.createdAt * 1000)
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
            ? "bg-primary text-primary-foreground rounded-br-sm"
            : "bg-muted text-foreground rounded-bl-sm",
        )}
      >
        <div className="flex items-center justify-between gap-3 opacity-0 transition-opacity group-hover:opacity-100">
          <div className="text-[11px] text-muted-foreground">
            {createdAt ? createdAt.toLocaleString() : ""}
          </div>
          <Button type="button" variant="ghost" size="icon-xs" onClick={() => void handleCopy()}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
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

          if (isToolUIPart(part)) {
            return <ToolCallCard key={part.toolCallId} part={part as GenericToolPart} />;
          }

          return null;
        })}
      </div>
    </div>
  );
}
