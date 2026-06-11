import { redirect } from "next/navigation";
import { eq, and, asc } from "drizzle-orm";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { conversations, messages } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ChatInterface } from "@/components/chat/ChatInterface";
import { ConversationSidebar } from "@/components/conversations/conversation-sidebar";
import { SettingsModal } from "@/components/settings/settings-modal";
import { ModelPickerDropdown } from "@/components/settings/model-picker-dropdown";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { getEnv } from "@/lib/env";
import { formatTokenUsage, sumTokenUsage } from "@/lib/token-usage";

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

  const conversation = await db.query.conversations.findFirst({
    where: and(
      eq(conversations.id, id),
      eq(conversations.user_id, user.id),
    ),
  });

  if (!conversation) {
    redirect("/");
  }

  const initialMessages = await db.query.messages.findMany({
    where: eq(messages.conversation_id, id),
    orderBy: [asc(messages.created_at)],
  });
  const conversationUsage = sumTokenUsage(
    initialMessages
      .filter((message) => message.role === "assistant")
      .map((message) => ({
        inputTokens: message.input_tokens,
        outputTokens: message.output_tokens,
      })),
  );

  const initials = user.display_name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
  const env = getEnv();

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
            <div className="hidden items-center gap-2 rounded-full border border-border/70 bg-card/80 px-2.5 py-1.5 md:flex">
              <Avatar className="h-8 w-8">
                <AvatarFallback className="text-xs">{initials}</AvatarFallback>
              </Avatar>
              <span className="text-sm text-muted-foreground">
                {user.display_name}
              </span>
            </div>
            <ThemeToggle />
            <ModelPickerDropdown className="hidden md:inline-flex" />
            <SettingsModal
              displayName={user.display_name}
              typo3BaseUrl={env.TYPO3_BASE_URL || "Not configured"}
            />
            <a href={`/api/conversations/${id}/export`}>
              <Button variant="outline" size="sm">
                Export Markdown
              </Button>
            </a>
            <form action="/api/auth/logout">
              <Button variant="outline" size="sm">
                Logout
              </Button>
            </form>
          </div>
        </header>

        {/* Chat interface */}
        <ChatInterface
          conversationId={id}
          initialAutoApproveWrites={Boolean(conversation.auto_approve_writes)}
          initialMessages={initialMessages}
        />
        </div>
    </div>
  );
}
