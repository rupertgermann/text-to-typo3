import type { ChatStatus } from "ai";

export const CHAT_SCROLL_BOTTOM_THRESHOLD = 96;

type ScrollMetrics = {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
};

export function isNearChatBottom(
  metrics: ScrollMetrics,
  threshold = CHAT_SCROLL_BOTTOM_THRESHOLD,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

export function getChatAutoScrollBehavior(_status: ChatStatus): ScrollBehavior {
  return _status === "submitted" || _status === "streaming" ? "auto" : "smooth";
}
