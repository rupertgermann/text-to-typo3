"use client";

import { useState, useRef, useCallback } from "react";
import { generateId } from "ai";
import type { UIMessage, ChatStatus } from "ai";

export interface UseStreamingChatOptions {
  conversationId: string;
  api?: string;
  initialMessages?: UIMessage[];
}

export interface UseStreamingChatReturn {
  messages: UIMessage[];
  status: ChatStatus;
  error: Error | undefined;
  sendMessage: (text: string) => Promise<void>;
  stop: () => void;
}

export function useStreamingChat({
  conversationId,
  api = "/api/chat",
  initialMessages = [],
}: UseStreamingChatOptions): UseStreamingChatReturn {
  const [messages, setMessages] = useState<UIMessage[]>(initialMessages);
  const [status, setStatus] = useState<ChatStatus>("ready");
  const [error, setError] = useState<Error | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (text: string) => {
      const userMsg: UIMessage = {
        id: generateId(),
        role: "user",
        parts: [{ type: "text", text }],
      };

      setMessages((prev) => [...prev, userMsg]);
      setStatus("submitted");
      setError(undefined);

      const assistantId = generateId();
      abortRef.current = new AbortController();

      try {
        const resp = await fetch(api, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            messages: [{ role: "user", content: text }],
          }),
          signal: abortRef.current.signal,
        });

        if (!resp.ok) {
          const message = (await resp.text()) || "Request failed";
          throw new Error(message);
        }
        if (!resp.body) throw new Error("No response body");

        setStatus("streaming");
        setMessages((prev) => [
          ...prev,
          {
            id: assistantId,
            role: "assistant",
            parts: [{ type: "text", text: "" }],
          },
        ]);

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          const snapshot = accumulated;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, parts: [{ type: "text" as const, text: snapshot }] }
                : m,
            ),
          );
        }

        setStatus("ready");
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          setStatus("ready");
          return;
        }
        const err = e instanceof Error ? e : new Error("Unknown error");
        setStatus("error");
        setError(err);
      }
    },
    [api, conversationId],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setStatus("ready");
  }, []);

  return { messages, status, error, sendMessage, stop };
}
