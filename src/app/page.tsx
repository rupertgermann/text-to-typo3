import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { conversations } from "@/lib/db/schema";

export default async function Home() {
  const auth = await getAuthenticatedUser();
  const user = auth?.user;

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
