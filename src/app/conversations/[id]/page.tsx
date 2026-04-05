import { redirect } from "next/navigation";
import { eq, and, asc } from "drizzle-orm";
import { getSession } from "@/lib/session";
import { db } from "@/lib/db";
import { users, conversations, messages } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ChatInterface } from "@/components/chat/ChatInterface";

interface ConversationPageProps {
  params: Promise<{ id: string }>;
}

export default async function ConversationPage({
  params,
}: ConversationPageProps) {
  const { id } = await params;
  const session = await getSession();

  if (!session.userId) {
    redirect("/api/auth/login");
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, session.userId),
  });

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

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b px-4 py-3">
        <h1 className="text-lg font-semibold">{conversation.title}</h1>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Avatar className="h-8 w-8">
              <AvatarFallback className="text-xs">{initials}</AvatarFallback>
            </Avatar>
            <span className="text-sm text-muted-foreground">
              {user.display_name}
            </span>
          </div>
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
  );
}
