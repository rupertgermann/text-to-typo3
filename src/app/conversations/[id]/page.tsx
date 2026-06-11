import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ChatInterface } from "@/components/chat/ChatInterface";
import { ConversationSidebar } from "@/components/conversations/conversation-sidebar";
import { SettingsModal } from "@/components/settings/settings-modal";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { getEnv } from "@/lib/env";
import { getSelectedModelSummary } from "@/lib/models";
import { formatTokenUsage } from "@/lib/token-usage";
import {
  getAssistantTokenUsage,
  getConversationWithMessagesForUser,
} from "@/lib/conversations";
import { getPublicUserSettings } from "@/lib/user-settings";

interface ConversationPageProps {
  params: Promise<{ id: string }>;
}

export default async function ConversationPage({
  params,
}: ConversationPageProps) {
  const { id } = await params;
  const auth = await getAuthenticatedUser();
  const user = auth?.user;

  if (!user) {
    redirect("/api/auth/login");
  }

  const conversation = await getConversationWithMessagesForUser(user.id, id);

  if (!conversation) {
    redirect("/");
  }

  const conversationUsage = await getAssistantTokenUsage(id);

  const initials = user.display_name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
  const env = getEnv();
  const userSettings = await getPublicUserSettings(user.id);
  const selectedModel = getSelectedModelSummary(userSettings);

  return (
    <div className="flex h-full min-h-0 bg-transparent">
      <ConversationSidebar activeConversationId={id} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border/70 bg-background/75 px-5 py-4 backdrop-blur">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">
              {conversation.title}
            </h1>
            <p className="text-sm text-muted-foreground">
              Conversation workspace · {formatTokenUsage(conversationUsage)}
            </p>
          </div>
          <div className="flex items-center gap-2 md:gap-3">
            <div className="hidden h-9 items-center gap-2 rounded-full border border-border/70 bg-card/80 px-2.5 text-sm md:flex">
              <Avatar className="h-6 w-6">
                <AvatarFallback className="text-xs">{initials}</AvatarFallback>
              </Avatar>
              <span className="text-sm text-muted-foreground">
                {user.display_name}
              </span>
            </div>
            <ThemeToggle />
            <div
              className="hidden h-9 max-w-72 items-center gap-2 rounded-full border border-border/70 bg-card/80 px-3 text-sm md:flex"
              title={selectedModel.id}
            >
              <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
                Model
              </span>
              <span className="truncate font-semibold">{selectedModel.name}</span>
              {selectedModel.providerName ? (
                <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
                  {selectedModel.providerName}
                </span>
              ) : null}
            </div>
            <SettingsModal
              displayName={user.display_name}
              typo3BaseUrl={env.TYPO3_BASE_URL || "Not configured"}
            />
            <a href={`/api/conversations/${id}/export`}>
              <Button variant="outline" size="sm" className="h-9">
                Export Markdown
              </Button>
            </a>
            <form action="/api/auth/logout">
              <Button variant="outline" size="sm" className="h-9">
                Logout
              </Button>
            </form>
          </div>
        </header>

        {/* Chat interface */}
        <ChatInterface
          conversationId={id}
          initialAutoApproveWrites={Boolean(conversation.auto_approve_writes)}
          initialMessages={conversation.messages}
        />
        </div>
    </div>
  );
}
