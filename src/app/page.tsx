import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/session";
import { db } from "@/lib/db";
import { users, conversations } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

export default async function Home() {
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

  // Check for existing conversations or create a default one
  const existingConversations = await db.query.conversations.findMany({
    where: eq(conversations.user_id, user.id),
    orderBy: (c, { desc }) => [desc(c.updated_at)],
    limit: 1,
  });

  if (existingConversations.length > 0) {
    redirect(`/conversations/${existingConversations[0].id}`);
  }

  // Create a default conversation for new users
  const [newConversation] = await db
    .insert(conversations)
    .values({
      user_id: user.id,
      title: "New conversation",
    })
    .returning();

  redirect(`/conversations/${newConversation.id}`);
}
