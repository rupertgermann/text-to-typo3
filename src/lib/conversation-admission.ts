// shortcut: admission is process-local; use shared locking before running multiple app processes.
const activeConversations = new Set<string>();

export function tryAcquireConversation(userId: string, conversationId: string): (() => void) | null {
  const key = JSON.stringify([userId, conversationId]);
  if (activeConversations.has(key)) return null;

  activeConversations.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeConversations.delete(key);
  };
}
