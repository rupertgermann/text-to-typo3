import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { unknownWriteResult, UNKNOWN_WRITE_MESSAGE } from "@/lib/mcp-outcome";
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
