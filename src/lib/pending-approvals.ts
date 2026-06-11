import { isToolUIPart, type UIMessage } from "ai";

export type PendingApproval = {
  id: string;
  toolCallId: string;
  toolName: string;
  message: UIMessage;
};

type ToolPartWithApproval = UIMessage["parts"][number] & {
  toolCallId?: string;
  state?: string;
  toolName?: string;
  approval?: {
    id?: string;
    approved?: boolean;
  };
};

export function derivePendingApprovals(
  messages: UIMessage[],
): PendingApproval[] {
  const resolvedApprovalIds = new Set<string>();

  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolUIPart(part)) {
        continue;
      }

      const toolPart = part as ToolPartWithApproval;
      const approvalId = toolPart.approval?.id;
      if (!approvalId) {
        continue;
      }

      if (
        toolPart.state !== "approval-requested" ||
        typeof toolPart.approval?.approved === "boolean"
      ) {
        resolvedApprovalIds.add(approvalId);
      }
    }
  }

  return messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (!isToolUIPart(part)) {
        return [];
      }

      const toolPart = part as ToolPartWithApproval;
      const approvalId = toolPart.approval?.id;
      const toolCallId = toolPart.toolCallId;
      if (
        !approvalId ||
        !toolCallId ||
        toolPart.state !== "approval-requested" ||
        resolvedApprovalIds.has(approvalId)
      ) {
        return [];
      }

      return [
        {
          id: approvalId,
          toolCallId,
          toolName: toolPart.toolName ?? toolPart.type.replace(/^tool-/, ""),
          message,
        },
      ];
    }),
  );
}
