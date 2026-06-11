import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { derivePendingApprovals } from "./pending-approvals";

function assistantMessage(
  id: string,
  parts: UIMessage["parts"],
): UIMessage {
  return {
    id,
    role: "assistant",
    parts,
  };
}

function approvalPart({
  approvalId,
  toolCallId,
  state = "approval-requested",
  approved,
}: {
  approvalId: string;
  toolCallId: string;
  state?: "approval-requested" | "approval-responded";
  approved?: boolean;
}): UIMessage["parts"][number] {
  return ({
    type: "tool-WriteTable",
    toolCallId,
    state,
    input: {},
    approval: {
      id: approvalId,
      ...(typeof approved === "boolean" ? { approved } : {}),
    },
  } as unknown) as UIMessage["parts"][number];
}

describe("derivePendingApprovals", () => {
  it("returns no pending approvals when none exist", () => {
    expect(
      derivePendingApprovals([
        assistantMessage("assistant-1", [{ type: "text", text: "Done" }]),
      ]),
    ).toEqual([]);
  });

  it("returns one pending approval with tool and message context", () => {
    const message = assistantMessage("assistant-1", [
      approvalPart({
        approvalId: "approval-1",
        toolCallId: "call-1",
      }),
    ]);

    expect(derivePendingApprovals([message])).toEqual([
      {
        id: "approval-1",
        toolCallId: "call-1",
        toolName: "WriteTable",
        message,
      },
    ]);
  });

  it("returns multiple pending approvals", () => {
    expect(
      derivePendingApprovals([
        assistantMessage("assistant-1", [
          approvalPart({
            approvalId: "approval-1",
            toolCallId: "call-1",
          }),
        ]),
        assistantMessage("assistant-2", [
          approvalPart({
            approvalId: "approval-2",
            toolCallId: "call-2",
          }),
        ]),
      ]).map((approval) => approval.id),
    ).toEqual(["approval-1", "approval-2"]);
  });

  it("excludes resolved approvals", () => {
    expect(
      derivePendingApprovals([
        assistantMessage("assistant-pending", [
          approvalPart({
            approvalId: "approval-1",
            toolCallId: "call-1",
          }),
          approvalPart({
            approvalId: "approval-2",
            toolCallId: "call-2",
          }),
        ]),
        assistantMessage("assistant-resolved", [
          approvalPart({
            approvalId: "approval-1",
            toolCallId: "call-1",
            state: "approval-responded",
            approved: true,
          }),
        ]),
      ]).map((approval) => approval.id),
    ).toEqual(["approval-2"]);
  });
});
