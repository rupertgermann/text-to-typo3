"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type FileUIPart,
  type UIMessage,
} from "ai";
import { Button } from "@/components/ui/button";
import { MessageBubble } from "./MessageBubble";
import type { Message } from "@/lib/db/schema";
import { ActivitySidebar } from "./ActivitySidebar";
import {
  FilePlus2,
  ExternalLink,
  ImagePlus,
  Languages,
  Loader2,
  Newspaper,
  Paperclip,
  PanelRight,
  Pencil,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Square,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  deserializeMessageParts,
  extractMessageText,
} from "@/lib/chat-message-parts";
import { readApiErrorMessage } from "@/lib/api-client";
import {
  starterPrompts,
  type StarterPromptCategory,
} from "@/lib/starter-prompts";
import {
  getChatAutoScrollBehavior,
  isNearChatBottom,
} from "./chat-scroll";
import { derivePendingApprovals } from "@/lib/pending-approvals";
import { deriveQueuedWorkspaceChanges } from "./tool-rendering";

interface ChatInterfaceProps {
  initialAutoApproveWrites: boolean;
  conversationId: string;
  initialMessages: Message[];
  typo3BaseUrl: string;
}

type PendingAttachment = {
  file: File;
};

const starterPromptIcons: Record<StarterPromptCategory, LucideIcon> = {
  inspection: Search,
  content: FilePlus2,
  news: Newspaper,
  translation: Languages,
};

/** Convert DB messages to UIMessage format. Only user/assistant/system roles are included. */
function toUIMessages(dbMessages: Message[]): UIMessage[] {
  const validRoles: UIMessage["role"][] = ["user", "assistant", "system"];
  return dbMessages
    .filter((m) => validRoles.includes(m.role as UIMessage["role"]))
    .map((m) => ({
      id: m.id,
      role: m.role as UIMessage["role"],
      metadata: {
        createdAt: m.created_at,
        inputTokens: m.input_tokens,
        outputTokens: m.output_tokens,
      },
      parts:
        deserializeMessageParts(m.tool_calls) ??
        [{ type: "text" as const, text: m.content }],
    }));
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Failed to read file"));
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function createPendingAttachments(files: File[]): PendingAttachment[] {
  return files.map((file) => ({ file }));
}

export function ChatInterface({
  initialAutoApproveWrites,
  conversationId,
  initialMessages,
  typo3BaseUrl,
}: ChatInterfaceProps) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const [autoApproveWrites, setAutoApproveWrites] = useState(
    initialAutoApproveWrites,
  );
  const [savingAutoApproveWrites, setSavingAutoApproveWrites] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const transcriptViewportRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const initialUiMessages = useMemo(
    () => toUIMessages(initialMessages),
    [initialMessages],
  );
  const {
    messages,
    status,
    error,
    clearError,
    addToolApprovalResponse,
    sendMessage,
    regenerate,
    stop,
  } = useChat({
    messages: initialUiMessages,
    transport: new DefaultChatTransport({
      body: { conversationId },
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });

  const isLoading = status === "submitted" || status === "streaming";
  const lastTranscriptMessage = messages[messages.length - 1];
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(messages),
    [messages],
  );
  const pendingApprovalToolCallIds = useMemo(
    () => new Set(pendingApprovals.map((approval) => approval.toolCallId)),
    [pendingApprovals],
  );
  const firstPendingApproval = pendingApprovals[0] ?? null;
  const queuedWorkspaceChanges = useMemo(
    () => deriveQueuedWorkspaceChanges(messages, typo3BaseUrl),
    [messages, typo3BaseUrl],
  );

  const handleTranscriptScroll = useCallback(() => {
    const viewport = transcriptViewportRef.current;
    if (!viewport) {
      return;
    }

    shouldStickToBottomRef.current = isNearChatBottom(viewport);
  }, []);

  useLayoutEffect(() => {
    const viewport = transcriptViewportRef.current;
    if (!viewport || !shouldStickToBottomRef.current) {
      return;
    }

    const top = viewport.scrollHeight;
    const behavior = getChatAutoScrollBehavior(status);
    if (behavior === "auto") {
      viewport.scrollTop = top;
      return;
    }

    viewport.scrollTo({ top, behavior });
  }, [messages, status]);

  const addFiles = (files: File[]) => {
    const imageFiles = files.filter(isImageFile);
    if (imageFiles.length === 0) {
      return;
    }

    setAttachments((current) => [...current, ...createPendingAttachments(imageFiles)]);
    setComposerError(null);
  };

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;

    const currentAttachments = attachments;
    const currentText = input;
    const currentEditingMessageId = editingMessageId;

    try {
      const files: FileUIPart[] = await Promise.all(
        currentAttachments.map(async (attachment) => ({
          type: "file" as const,
          mediaType: attachment.file.type || "application/octet-stream",
          filename: attachment.file.name,
          url: await fileToDataUrl(attachment.file),
        })),
      );

      setInput("");
      setAttachments([]);
      setEditingMessageId(null);
      setComposerError(null);

      if (currentEditingMessageId) {
        if (currentText.trim() && files.length > 0) {
          await sendMessage({
            text: currentText.trim(),
            files,
            messageId: currentEditingMessageId,
          });
        } else if (currentText.trim()) {
          await sendMessage({
            text: currentText.trim(),
            messageId: currentEditingMessageId,
          });
        } else {
          await sendMessage({
            files,
            messageId: currentEditingMessageId,
          });
        }
        return;
      }

      if (currentText.trim()) {
        await sendMessage({
          text: currentText.trim(),
          ...(files.length > 0 ? { files } : {}),
        });
        return;
      }

      await sendMessage({ files });
    } catch (sendError) {
      setComposerError(
        sendError instanceof Error ? sendError.message : "Failed to send message",
      );
    }
  };

  const startEditing = (message: UIMessage) => {
    setEditingMessageId(message.id);
    setInput(extractMessageText(message.parts));
    setAttachments([]);
    setComposerError(null);
    queueMicrotask(() => textareaRef.current?.focus());
  };

  const retryLastUserMessage = async () => {
    const lastUserMessage = messages.findLast((message) => message.role === "user");
    if (!lastUserMessage || isLoading) {
      return;
    }

    clearError();
    await sendMessage({
      text: extractMessageText(lastUserMessage.parts),
      messageId: lastUserMessage.id,
    });
  };

  const toggleAutoApproveWrites = async () => {
    const nextValue = !autoApproveWrites;
    setSavingAutoApproveWrites(true);
    setComposerError(null);

    try {
      const response = await fetch(`/api/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoApproveWrites: nextValue }),
      });

      if (!response.ok) {
        throw new Error(
          await readApiErrorMessage(
            response,
            "Failed to update auto-approve setting",
          ),
        );
      }

      const updated = await response.json() as {
        auto_approve_writes?: number | null;
      };
      setAutoApproveWrites(Boolean(updated.auto_approve_writes));
    } catch (toggleError) {
      setComposerError(
        toggleError instanceof Error
          ? toggleError.message
          : "Failed to update auto-approve setting",
      );
    } finally {
      setSavingAutoApproveWrites(false);
    }
  };

  const selectStarterPrompt = (prompt: string) => {
    setEditingMessageId(null);
    setInput(prompt);
    setComposerError(null);
    queueMicrotask(() => textareaRef.current?.focus());
  };

  const handleToolApprovalResponse = useCallback(
    (approval: { approved: boolean; id: string; reason?: string }) => {
      void addToolApprovalResponse(approval);
    },
    [addToolApprovalResponse],
  );

  const jumpToPendingApproval = useCallback((toolCallId: string) => {
    const target = document.getElementById(`tool-call-${toolCallId}`);
    if (!target) {
      return;
    }

    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  const removeAttachment = (index: number) => {
    setAttachments((current) => {
      const next = current.filter((_, currentIndex) => currentIndex !== index);
      return next;
    });
  };

  const handleFileSelection = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    addFiles(files);
    event.currentTarget.value = "";
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (isLoading) {
      return;
    }

    const files = Array.from(event.dataTransfer.files ?? []);
    addFiles(files);
  };

  const handleSubmitEvent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isLoading) return;
    await handleSubmit();
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 bg-background/60 px-4 py-3 backdrop-blur">
          <div className="min-w-0">
            {queuedWorkspaceChanges.count > 0 ? (
              queuedWorkspaceChanges.workspaceModuleUrl ? (
                <a
                  href={queuedWorkspaceChanges.workspaceModuleUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex max-w-full items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-950 shadow-sm hover:bg-amber-100 dark:border-amber-500/60 dark:bg-amber-950/40 dark:text-amber-100 dark:hover:bg-amber-950/60"
                >
                  <span className="truncate">
                    {queuedWorkspaceChanges.count}{" "}
                    {queuedWorkspaceChanges.count === 1 ? "change" : "changes"}{" "}
                    queued in workspace
                  </span>
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              ) : (
                <div className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-950 dark:border-amber-500/60 dark:bg-amber-950/40 dark:text-amber-100">
                  {queuedWorkspaceChanges.count}{" "}
                  {queuedWorkspaceChanges.count === 1 ? "change" : "changes"}{" "}
                  queued in workspace
                </div>
              )
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={autoApproveWrites ? "default" : "outline"}
              className={autoApproveWrites ? "" : "bg-card/80"}
              onClick={() => void toggleAutoApproveWrites()}
              disabled={savingAutoApproveWrites || isLoading}
            >
              {savingAutoApproveWrites ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="mr-2 h-4 w-4" />
              )}
              Auto-approve writes
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="bg-card/80"
              onClick={() => setShowActivity((open) => !open)}
            >
              <PanelRight className="mr-2 h-4 w-4" />
              Activity
            </Button>
          </div>
        </div>

        <div
          ref={transcriptViewportRef}
          className="flex-1 overflow-y-auto px-4 py-6 md:px-8"
          onScroll={handleTranscriptScroll}
        >
          <div className="mx-auto max-w-4xl space-y-5">
            {messages.length === 0 ? (
              <div className="mx-auto flex min-h-[420px] w-full max-w-3xl flex-col justify-center py-6">
                <div className="text-center">
                  <p className="text-lg font-medium text-foreground">
                    What would you like to do in TYPO3?
                  </p>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    Start with a common task and adjust the prompt before sending.
                  </p>
                </div>

                <div className="mt-6 grid gap-3 sm:grid-cols-2">
                  {starterPrompts.map((starterPrompt) => {
                    const Icon = starterPromptIcons[starterPrompt.category];

                    return (
                      <button
                        key={starterPrompt.id}
                        type="button"
                        disabled={isLoading}
                        className="group flex min-h-36 flex-col rounded-lg border border-border bg-card/80 p-4 text-left shadow-sm transition-colors hover:border-primary/50 hover:bg-card focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => selectStarterPrompt(starterPrompt.prompt)}
                      >
                        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                          <Icon className="h-4 w-4 text-primary" />
                          {starterPrompt.title}
                        </span>
                        <span className="mt-2 text-sm leading-5 text-muted-foreground">
                          {starterPrompt.description}
                        </span>
                        <span className="mt-4 text-xs leading-5 text-muted-foreground/80">
                          {starterPrompt.prompt}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  allowEdit={!isLoading}
                  allowRegenerate={
                    !isLoading &&
                    message.role === "assistant" &&
                    lastTranscriptMessage?.id === message.id
                  }
                  onEdit={
                    message.role === "user" ? () => startEditing(message) : undefined
                  }
                  onRegenerate={
                    message.role === "assistant"
                      ? () => regenerate({ messageId: message.id })
                      : undefined
                  }
                  onToolApprovalResponse={handleToolApprovalResponse}
                  pendingApprovalToolCallIds={pendingApprovalToolCallIds}
                  typo3BaseUrl={typo3BaseUrl}
                />
              ))
            )}

            {error ? (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive shadow-sm">
                  <div className="flex items-start gap-2">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="space-y-2">
                      <p>{getChatErrorDisplayMessage(error)}</p>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => void retryLastUserMessage()}
                        disabled={isLoading}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Retry
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {status === "submitted" && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-border/70 bg-card/80 px-4 py-2.5 text-sm text-muted-foreground shadow-sm">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Thinking...</span>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-border/70 bg-background/80 px-4 py-4 backdrop-blur">
          {firstPendingApproval ? (
            <div className="mx-auto mb-3 flex max-w-3xl flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-950 shadow-sm dark:border-amber-500/70 dark:bg-amber-950/40 dark:text-amber-100 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="font-medium">Write approval pending</div>
                <button
                  type="button"
                  className="mt-0.5 max-w-full truncate text-left text-xs underline decoration-amber-700/40 underline-offset-2 hover:decoration-current dark:decoration-amber-200/40"
                  onClick={() => jumpToPendingApproval(firstPendingApproval.toolCallId)}
                >
                  Jump to {firstPendingApproval.toolName}
                  {pendingApprovals.length > 1
                    ? ` and ${pendingApprovals.length - 1} more`
                    : ""}
                </button>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() =>
                    handleToolApprovalResponse({
                      id: firstPendingApproval.id,
                      approved: true,
                    })
                  }
                >
                  Approve
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="border-amber-700/30 bg-background/80 text-amber-950 hover:bg-background dark:text-amber-100"
                  onClick={() =>
                    handleToolApprovalResponse({
                      id: firstPendingApproval.id,
                      approved: false,
                    })
                  }
                >
                  Deny
                </Button>
              </div>
            </div>
          ) : null}
          <form onSubmit={handleSubmitEvent} className="mx-auto max-w-3xl">
            <div
              className={cn(
                "rounded-[1.75rem] border bg-card/90 p-3 shadow-lg shadow-black/5",
                composerError ? "border-destructive/50" : "border-border",
              )}
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
            >
              {editingMessageId ? (
                <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <Pencil className="h-3.5 w-3.5" />
                    <span>Editing a previous message</span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditingMessageId(null);
                      setInput("");
                      setAttachments([]);
                      setComposerError(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              ) : null}

              {attachments.length > 0 ? (
                <div className="mb-3 flex flex-wrap gap-2">
                  {attachments.map((attachment, index) => (
                    <div
                      key={`${attachment.file.name}-${attachment.file.lastModified}-${index}`}
                      className="flex items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2 text-xs"
                    >
                      <ImagePlus className="h-4 w-4" />
                      <span className="max-w-48 truncate">{attachment.file.name}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => removeAttachment(index)}
                        title="Remove attachment"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}

              <textarea
                ref={textareaRef}
                value={input}
                onChange={(event) => {
                  setInput(event.target.value);
                  setComposerError(null);
                }}
                placeholder={
                  editingMessageId
                    ? "Edit your previous message..."
                    : "Message your TYPO3 assistant..."
                }
                disabled={isLoading}
                rows={2}
                className="min-h-20 w-full resize-none rounded-xl border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleSubmit();
                  }
                }}
              />

              <div className="mt-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={handleFileSelection}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isLoading}
                    title="Attach images"
                  >
                    <Paperclip className="h-4 w-4" />
                    Attach
                  </Button>
                </div>

                <div className="flex items-center gap-2">
                  {isLoading ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => {
                        void stop();
                      }}
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
                      disabled={!input.trim() && attachments.length === 0}
                      title={
                        editingMessageId ? "Update message" : "Send message"
                      }
                      className="h-10 w-10 shrink-0 rounded-xl"
                    >
                      <Send className="h-4 w-4" />
                      <span className="sr-only">Send</span>
                    </Button>
                  )}
                </div>
              </div>

              {composerError ? (
                <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {composerError}
                </div>
              ) : null}
            </div>
          </form>
        </div>
      </div>

      {showActivity ? (
        <ActivitySidebar messages={messages} typo3BaseUrl={typo3BaseUrl} />
      ) : null}
    </div>
  );
}

function getChatErrorDisplayMessage(error: Error): string {
  if (/MCP|TYPO3/i.test(error.message)) {
    return error.message;
  }

  return "Model provider error. Try again or test the provider connection in Settings.";
}
