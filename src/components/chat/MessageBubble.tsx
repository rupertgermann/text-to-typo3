"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import type { UIMessage } from "ai";

interface MessageBubbleProps {
  message: UIMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  // Extract text content from parts
  const textContent = message.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { type: "text"; text: string }).text)
    .join("");

  return (
    <div
      className={cn(
        "flex w-full",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm",
          isUser
            ? "bg-primary text-primary-foreground rounded-br-sm"
            : "bg-muted text-foreground rounded-bl-sm",
        )}
      >
        {isUser ? (
          <span className="whitespace-pre-wrap">{textContent}</span>
        ) : (
          <div className="prose prose-sm max-w-none dark:prose-invert prose-pre:overflow-x-auto prose-pre:rounded-md prose-pre:bg-muted prose-pre:p-3">
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
              {textContent}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
