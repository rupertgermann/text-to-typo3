"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MessageBubble } from "./MessageBubble";
import { useStreamingChat } from "@/hooks/useStreamingChat";
import type { Message } from "@/lib/db/schema";
import type { UIMessage } from "ai";
import { Send, Square, Loader2 } from "lucide-react";

interface ChatInterfaceProps {
  conversationId: string;
  initialMessages: Message[];
}

/** Convert DB messages to UIMessage format. Only user/assistant/system roles are included. */
function toUIMessages(dbMessages: Message[]): UIMessage[] {
  const validRoles: UIMessage["role"][] = ["user", "assistant", "system"];
  return dbMessages
    .filter((m) => validRoles.includes(m.role as UIMessage["role"]))
    .map((m) => ({
      id: m.id,
      role: m.role as UIMessage["role"],
      parts: [{ type: "text" as const, text: m.content }],
    }));
}

export function ChatInterface({
  conversationId,
  initialMessages,
}: ChatInterfaceProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { messages, status, error, sendMessage, stop } = useStreamingChat({
    conversationId,
    initialMessages: toUIMessages(initialMessages),
  });

  const isLoading = status === "submitted" || status === "streaming";

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isLoading) return;
    setInput("");
    await sendMessage(text);
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.length === 0 ? (
            <div className="flex h-full min-h-[300px] flex-col items-center justify-center text-muted-foreground">
              <p className="text-base">What would you like to know about your TYPO3 instance?</p>
              <p className="mt-1 text-sm">Ask anything — pages, content, settings, or configuration.</p>
            </div>
          ) : (
            messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))
          )}

          {/* Thinking indicator */}
          {status === "submitted" && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-muted px-4 py-2.5 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Thinking…</span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="mx-auto w-full max-w-3xl px-4 py-2">
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error.message || "An error occurred. Please try again."}
          </div>
        </div>
      )}

      {/* Input area */}
      <div className="border-t bg-background px-4 py-3">
        <form
          onSubmit={handleSubmit}
          className="mx-auto flex max-w-3xl items-end gap-2"
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message your TYPO3 assistant…"
            disabled={isLoading}
            className="h-10 flex-1 resize-none rounded-xl text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e as unknown as React.FormEvent);
              }
            }}
          />

          {isLoading ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={stop}
              title="Stop generating"
              className="h-10 w-10 shrink-0 rounded-xl"
            >
              <Square className="h-4 w-4" />
              <span className="sr-only">Stop</span>
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              disabled={!input.trim()}
              title="Send message"
              className="h-10 w-10 shrink-0 rounded-xl"
            >
              <Send className="h-4 w-4" />
              <span className="sr-only">Send</span>
            </Button>
          )}
        </form>
      </div>
    </div>
  );
}
