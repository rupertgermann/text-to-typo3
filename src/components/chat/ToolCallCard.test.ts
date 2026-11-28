import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { getUnknownWriteMessage, unknownWriteResult, UNKNOWN_WRITE_MESSAGE } from "@/lib/mcp-outcome";
import { ToolCallCard } from "./ToolCallCard";

it("shows recovery guidance on a collapsed uncertain write without claiming success", () => {
  const html = renderToStaticMarkup(createElement(ToolCallCard, {
    part: {
      type: "tool-WriteTable",
      toolCallId: "uncertain",
      state: "output-available",
      output: unknownWriteResult(),
    },
    typo3BaseUrl: "https://typo3.test",
  }));
  expect(html).toContain('role="alert"');
  expect(html).toContain(UNKNOWN_WRITE_MESSAGE);
  expect(html).toContain("outcome unknown");
  expect(html).not.toContain("Queued in workspace");
});

it.each([
  { type: "tool-UploadFile", output: unknownWriteResult() },
  { type: "tool-OtherFileTool", output: unknownWriteResult("storage") },
])("shows file storage recovery guidance for $type", ({ type, output }) => {
  const html = renderToStaticMarkup(createElement(ToolCallCard, {
    part: { type, output, toolCallId: "uncertain-storage", state: "output-available" },
  }));
  expect(html).toContain(getUnknownWriteMessage("storage"));
  expect(html).not.toContain(UNKNOWN_WRITE_MESSAGE);
  expect(html).not.toContain("Applied in TYPO3 file storage");
});

it("renders checked live and workspace preview links on a collapsed tool result", () => {
  const html = renderToStaticMarkup(createElement(ToolCallCard, {
    part: {
      type: "tool-WriteTable",
      toolCallId: "links",
      state: "output-available",
      output: {
        _meta: {
          operation: "write",
          recordLinks: [
            { kind: "live", url: "https://typo3.test/story" },
            { kind: "live", url: "https://typo3.test/story" },
            { kind: "preview", url: "https://typo3.test/story?ADMCMD_prev=preview" },
            { kind: "preview", url: "javascript:alert(1)" },
            { kind: "live", url: "https://user:pass@typo3.test/story" },
          ],
        },
      },
    },
    typo3BaseUrl: "https://typo3.test",
  }));
  expect(html).toContain("Open live record");
  expect(html).toContain("Open workspace preview");
  expect(html.match(/href="https:\/\/typo3\.test\/story"/g)).toHaveLength(1);
  expect(html).toContain('href="https://typo3.test/story?ADMCMD_prev=preview"');
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("user:pass");
});

it.each([true, false])("renders an explicit file handoff on a collapsed tool call (compact=%s)", (compact) => {
  const html = renderToStaticMarkup(createElement(ToolCallCard, {
    part: {
      type: "tool-UploadFile",
      toolCallId: "upload",
      state: "output-available",
      output: {
        _meta: {
          operation: "write",
          changeTarget: "storage",
          outcome: "pending",
          upload: {
            id: "app-grant",
            fileName: null,
            targetFolder: "1:/media/",
            validUntil: "2099-11-28T10:00:00Z",
          },
        },
      },
    },
    typo3BaseUrl: "https://typo3.test",
    compact,
    uploadControls: { conversationId: "current", statuses: new Map(), onUpload() {} },
  }));
  expect(html).toContain("Upload a local file to TYPO3 file storage");
  expect(html).toContain("Choose a file");
  expect(html).toContain('type="file"');
  expect(html).toContain("1:/media/");
  expect(html).not.toContain("Queued in workspace");
  expect(html).not.toContain("Applied in TYPO3 file storage");
});

it("does not show a pending upload as applied even when its chooser is unavailable", () => {
  const html = renderToStaticMarkup(createElement(ToolCallCard, {
    part: {
      type: "tool-UploadFile",
      toolCallId: "pending-upload",
      state: "output-available",
      output: { _meta: { operation: "write", changeTarget: "storage", outcome: "pending" } },
    },
  }));
  expect(html).not.toContain("Applied in TYPO3 file storage");
  expect(html).not.toContain("Queued in workspace");
});
