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
import { getEnv } from "@/lib/env";

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

  const initials = user.display_name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
  const env = getEnv();

  return (
    <div className="flex h-full min-h-0">
      <ConversationSidebar activeConversationId={id} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex items-center justify-between border-b px-4 py-3">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">
              {conversation.title}
            </h1>
            <p className="text-sm text-muted-foreground">Conversation workspace</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Avatar className="h-8 w-8">
                <AvatarFallback className="text-xs">{initials}</AvatarFallback>
              </Avatar>
              <span className="hidden text-sm text-muted-foreground md:inline">
                {user.display_name}
              </span>
            </div>
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
          initialMessages={initialMessages}
        />
        </div>
    </div>
  );
}
