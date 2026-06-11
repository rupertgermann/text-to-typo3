"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MessageSquare, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { Conversation } from "@/lib/db/schema";
import {
  mutateClientQueries,
  revalidateClientQueries,
  SETTINGS_UPDATED_EVENT,
  serializeClientQueryKey,
  useClientQuery,
  useDebouncedValue,
} from "@/lib/client-query";

interface ConversationSidebarProps {
  activeConversationId?: string;
  className?: string;
}

function formatRelativeTime(epochSeconds: number | null): string {
  if (!epochSeconds) {
    return "just now";
  }

  const diffSeconds = Math.floor(Date.now() / 1000) - epochSeconds;
  const absolute = Math.abs(diffSeconds);

  if (absolute < 60) return "just now";
  if (absolute < 3600) return `${Math.round(absolute / 60)}m ago`;
  if (absolute < 86400) return `${Math.round(absolute / 3600)}h ago`;
  if (absolute < 604800) return `${Math.round(absolute / 86400)}d ago`;

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(epochSeconds * 1000));
}

function ConversationPanel({
  conversations,
  activeConversationId,
  query,
  setQuery,
  onCreateConversation,
  onNavigate,
  onRenameConversation,
  onDeleteConversation,
  isLoading,
  isRefreshing,
  editingConversationId,
  setEditingConversationId,
  editingTitle,
  setEditingTitle,
}: {
  conversations: Conversation[];
  activeConversationId?: string;
  query: string;
  setQuery: (value: string) => void;
  onCreateConversation: () => Promise<void>;
  onNavigate: (id: string) => void;
  onRenameConversation: (conversation: Conversation) => Promise<void>;
  onDeleteConversation: (conversation: Conversation) => Promise<void>;
  isLoading: boolean;
  isRefreshing: boolean;
  editingConversationId: string | null;
  setEditingConversationId: (id: string | null) => void;
  editingTitle: string;
  setEditingTitle: (value: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col border-r border-border/70 bg-sidebar/90 backdrop-blur">
      <div className="border-b border-border/70 px-4 py-5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-sm font-semibold tracking-wide">Conversations</p>
            <p className="text-xs text-muted-foreground">
              Search, rename, and manage your chats
            </p>
          </div>
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            onClick={() => void onCreateConversation()}
            title="New conversation"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-4 flex items-center gap-2 rounded-2xl border border-border/70 bg-card/80 px-3 shadow-sm">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search conversations"
            className="border-0 px-0 shadow-none focus-visible:ring-0"
          />
        </div>
        {isRefreshing ? (
          <p className="mt-2 text-xs text-muted-foreground">Refreshing...</p>
        ) : null}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-3">
          {isLoading ? (
            <div className="rounded-xl border border-dashed px-3 py-4 text-sm text-muted-foreground">
              Loading conversations...
            </div>
          ) : conversations.length === 0 ? (
            <div className="rounded-xl border border-dashed px-3 py-4 text-sm text-muted-foreground">
              No conversations found.
            </div>
          ) : (
            conversations.map((conversation) => {
              const isActive = conversation.id === activeConversationId;
              const isEditing = editingConversationId === conversation.id;

              return (
                <div
                  key={conversation.id}
                  className={cn(
                    "group flex items-start gap-2 rounded-xl border px-3 py-2 transition-colors",
                    isActive
                      ? "border-primary/40 bg-primary/8 shadow-sm"
                      : "border-transparent hover:border-border/80 hover:bg-card/80",
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 flex-col items-start text-left"
                    onClick={() => onNavigate(conversation.id)}
                    onDoubleClick={() => {
                      setEditingConversationId(conversation.id);
                      setEditingTitle(conversation.title);
                    }}
                  >
                    {isEditing ? (
                      <Input
                        autoFocus
                        value={editingTitle}
                        onChange={(event) => setEditingTitle(event.target.value)}
                        onBlur={() => void onRenameConversation(conversation)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void onRenameConversation(conversation);
                          }
                          if (event.key === "Escape") {
                            setEditingConversationId(null);
                            setEditingTitle(conversation.title);
                          }
                        }}
                        className="h-8"
                      />
                    ) : (
                      <>
                        <span className="truncate text-sm font-medium">
                          {conversation.title}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatRelativeTime(conversation.updated_at)}
                        </span>
                      </>
                    )}
                  </button>

                  <div className="flex items-center gap-1 opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => {
                        setEditingConversationId(conversation.id);
                        setEditingTitle(conversation.title);
                      }}
                      title="Rename"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => void onDeleteConversation(conversation)}
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export function ConversationSidebar({
  activeConversationId,
  className,
}: ConversationSidebarProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim(), 250);
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const conversationsKey = useMemo(
    () => ["conversations", debouncedQuery] as const,
    [debouncedQuery],
  );
  const serializedConversationsPrefix = serializeClientQueryKey(["conversations"]).slice(0, -1);
  const fetchConversations = useCallback(async () => {
    const url = debouncedQuery
      ? `/api/conversations?q=${encodeURIComponent(debouncedQuery)}`
      : "/api/conversations";
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error("Failed to load conversations");
    }

    return response.json() as Promise<Conversation[]>;
  }, [debouncedQuery]);
  const {
    data: conversations = [],
    isLoading,
    isRefreshing,
  } = useClientQuery<Conversation[]>({
    key: conversationsKey,
    fetcher: fetchConversations,
    keepPreviousData: true,
    revalidateOn: [SETTINGS_UPDATED_EVENT],
  });

  const panelHandlers = useMemo(
    () => ({
      async createConversation() {
        const response = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });

        if (!response.ok) {
          return;
        }

        const conversation: Conversation = await response.json();
        void revalidateClientQueries((key) =>
          key.startsWith(serializedConversationsPrefix),
        );
        router.push(`/conversations/${conversation.id}`);
        setMobileOpen(false);
      },
      navigate(id: string) {
        router.push(`/conversations/${id}`);
        setMobileOpen(false);
      },
      async renameConversation(conversation: Conversation) {
        const nextTitle = editingTitle.trim();
        setEditingConversationId(null);

        if (!nextTitle || nextTitle === conversation.title) {
          setEditingTitle(conversation.title);
          return;
        }

        const response = await fetch(`/api/conversations/${conversation.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: nextTitle }),
        });

        if (!response.ok) {
          setEditingTitle(conversation.title);
          return;
        }

        const updated: Conversation = await response.json();
        mutateClientQueries<Conversation[]>(
          (key) => key.startsWith(serializedConversationsPrefix),
          (current) =>
            current?.map((entry) =>
              entry.id === updated.id ? updated : entry,
            ),
        );
        setEditingTitle(updated.title);
      },
      async deleteConversation(conversation: Conversation) {
        if (!window.confirm(`Delete "${conversation.title}"?`)) {
          return;
        }

        const response = await fetch(`/api/conversations/${conversation.id}`, {
          method: "DELETE",
        });

        if (!response.ok && response.status !== 204) {
          return;
        }

        mutateClientQueries<Conversation[]>(
          (key) => key.startsWith(serializedConversationsPrefix),
          (current) =>
            current?.filter((entry) => entry.id !== conversation.id),
        );

        if (activeConversationId === conversation.id) {
          router.push("/");
        }
      },
    }),
    [activeConversationId, editingTitle, router, serializedConversationsPrefix],
  );

  const panel = (
    <ConversationPanel
      conversations={conversations}
      activeConversationId={activeConversationId}
      query={query}
      setQuery={setQuery}
      onCreateConversation={panelHandlers.createConversation}
      onNavigate={panelHandlers.navigate}
      onRenameConversation={panelHandlers.renameConversation}
      onDeleteConversation={panelHandlers.deleteConversation}
      isLoading={isLoading}
      isRefreshing={isRefreshing}
      editingConversationId={editingConversationId}
      setEditingConversationId={setEditingConversationId}
      editingTitle={editingTitle}
      setEditingTitle={setEditingTitle}
    />
  );

  return (
    <>
      <aside
        className={cn(
          "hidden h-full min-h-0 w-80 shrink-0 lg:flex",
          className,
        )}
      >
        {panel}
      </aside>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="fixed left-4 top-4 z-40 lg:hidden"
        onClick={() => setMobileOpen(true)}
      >
        <MessageSquare className="h-4 w-4" />
        Conversations
      </Button>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-[min(22rem,100vw)] p-0">
          <SheetHeader className="border-b px-4 py-4">
            <SheetTitle>Conversations</SheetTitle>
          </SheetHeader>
          {panel}
        </SheetContent>
      </Sheet>
    </>
  );
}
