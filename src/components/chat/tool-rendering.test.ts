import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { ToolCallCard } from "./ToolCallCard";
import {
  buildWorkspaceModuleUrl,
  collectPublicUrlAssets,
  deriveQueuedWorkspaceChanges,
  type GenericToolPart,
} from "./tool-rendering";
import { deserializeMessageParts } from "@/lib/chat-message-parts";

const TYPO3_BASE_URL = "https://typo3.example.test";

describe("tool rendering helpers", () => {
  it("builds the TYPO3 workspace module URL from the configured base URL", () => {
    expect(buildWorkspaceModuleUrl(TYPO3_BASE_URL)).toBe(
      "https://typo3.example.test/typo3/module/web/workspaces",
    );
  });

  it("counts only executed successful write tool parts for queued workspace changes", () => {
    const messages = [
      assistantMessage("assistant-1", [
        toolPart({
          type: "tool-WriteTable",
          toolCallId: "call-approved",
          state: "output-available",
          approval: { id: "approval-1", approved: true },
          output: {
            uid: 123,
            _meta: { operation: "write" },
          },
        }),
        toolPart({
          type: "tool-WriteTable",
          toolCallId: "call-denied",
          state: "output-denied",
          approval: { id: "approval-2", approved: false },
        }),
        toolPart({
          type: "tool-WriteTable",
          toolCallId: "call-failed",
          state: "output-available",
          output: {
            isError: true,
            _meta: { operation: "write" },
          },
        }),
        toolPart({
          type: "tool-ReadTable",
          toolCallId: "call-read",
          state: "output-available",
          output: {
            rows: [],
            _meta: { operation: "read" },
          },
        }),
      ]),
    ];

    expect(deriveQueuedWorkspaceChanges(messages, TYPO3_BASE_URL)).toEqual({
      count: 1,
      workspaceModuleUrl:
        "https://typo3.example.test/typo3/module/web/workspaces",
    });
  });

  it("derives queued workspace changes from persisted UIMessage tool parts after reload", () => {
    const persistedParts = JSON.stringify([
      {
        type: "tool-WriteTable",
        toolCallId: "call-auto",
        state: "output-available",
        output: {
          uid: 456,
          _meta: { operation: "write", approval: "auto-approved" },
        },
      },
    ]);
    const reloadedParts = deserializeMessageParts(persistedParts);

    expect(
      deriveQueuedWorkspaceChanges(
        [assistantMessage("assistant-reloaded", reloadedParts ?? [])],
        TYPO3_BASE_URL,
      ).count,
    ).toBe(1);
  });

  it("extracts public_url assets as resolved links and same-host thumbnails", () => {
    const assets = collectPublicUrlAssets(
      {
        rows: [
          {
            public_url: "/fileadmin/hero.jpg",
            mime_type: "image/jpeg",
            title: "Hero image",
          },
          {
            public_url: "/fileadmin/manual.pdf",
            mime_type: "application/pdf",
            filename: "manual.pdf",
          },
          {
            public_url: "https://cdn.example.test/off-host.png",
            mime_type: "image/png",
          },
        ],
      },
      TYPO3_BASE_URL,
    );

    expect(assets).toMatchObject([
      {
        href: "https://typo3.example.test/fileadmin/hero.jpg",
        displayName: "Hero image",
        isImage: true,
        thumbnailUrl: "https://typo3.example.test/fileadmin/hero.jpg",
      },
      {
        href: "https://typo3.example.test/fileadmin/manual.pdf",
        displayName: "manual.pdf",
        isImage: false,
        thumbnailUrl: null,
      },
      {
        href: "https://cdn.example.test/off-host.png",
        isImage: true,
        thumbnailUrl: null,
      },
    ]);
  });
});

describe("ToolCallCard rendering", () => {
  it("shows a workspace note and module link on successful write cards", () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallCard, {
        part: toolPart({
          type: "tool-WriteTable",
          toolCallId: "call-write",
          state: "output-available",
          output: {
            uid: 123,
            _meta: { operation: "write" },
          },
        }) as GenericToolPart,
        defaultOpen: true,
        typo3BaseUrl: TYPO3_BASE_URL,
      }),
    );

    expect(html).toContain("Queued in workspace - not live yet.");
    expect(html).toContain(
      'href="https://typo3.example.test/typo3/module/web/workspaces"',
    );
  });

  it("renders public_url links and lazy same-host image thumbnails", () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallCard, {
        part: toolPart({
          type: "tool-ReadTable",
          toolCallId: "call-read",
          state: "output-available",
          output: {
            rows: [
              {
                public_url: "/fileadmin/hero.jpg",
                mime_type: "image/jpeg",
                title: "Hero image",
              },
            ],
            _meta: { operation: "read" },
          },
        }) as GenericToolPart,
        defaultOpen: true,
        typo3BaseUrl: TYPO3_BASE_URL,
      }),
    );

    expect(html).toContain('href="https://typo3.example.test/fileadmin/hero.jpg"');
    expect(html).toContain('src="https://typo3.example.test/fileadmin/hero.jpg"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("max-h-40");
  });

  it("renders non-image and off-host public_url values as links without thumbnails", () => {
    const html = renderToStaticMarkup(
      React.createElement(ToolCallCard, {
        part: toolPart({
          type: "tool-ReadTable",
          toolCallId: "call-read",
          state: "output-available",
          output: {
            rows: [
              {
                public_url: "/fileadmin/manual.pdf",
                mime_type: "application/pdf",
              },
              {
                public_url: "https://cdn.example.test/off-host.png",
                mime_type: "image/png",
              },
            ],
            _meta: { operation: "read" },
          },
        }) as GenericToolPart,
        defaultOpen: true,
        typo3BaseUrl: TYPO3_BASE_URL,
      }),
    );

    expect(html).toContain('href="https://typo3.example.test/fileadmin/manual.pdf"');
    expect(html).toContain('href="https://cdn.example.test/off-host.png"');
    expect(html).not.toContain('src="https://typo3.example.test/fileadmin/manual.pdf"');
    expect(html).not.toContain('src="https://cdn.example.test/off-host.png"');
  });
});

function assistantMessage(id: string, parts: UIMessage["parts"]): UIMessage {
  return {
    id,
    role: "assistant",
    parts,
  };
}

function toolPart(part: {
  type: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: {
    id: string;
    approved?: boolean;
    reason?: string;
  };
}): UIMessage["parts"][number] {
  return part as UIMessage["parts"][number];
}
