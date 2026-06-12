import { describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import { addWebSearchTool, supportsWebSearchTool } from "@/lib/chat-tools";
import type { ChatProviderResolution } from "@/lib/chat-provider-resolution";

describe("chat tools", () => {
  it("enables web search for OpenAI Responses models", () => {
    expect(
      supportsWebSearchTool({
        providerKind: "openai",
        isChatCompletionsPath: false,
      }),
    ).toBe(true);
  });

  it("does not enable web search for chat-completions providers", () => {
    expect(
      supportsWebSearchTool({
        providerKind: "lmstudio",
        isChatCompletionsPath: true,
      }),
    ).toBe(false);
    expect(
      supportsWebSearchTool({
        providerKind: "custom",
        isChatCompletionsPath: true,
      }),
    ).toBe(false);
  });

  it("adds the OpenAI web search provider tool without removing TYPO3 tools", () => {
    const typo3Tools = {
      GetPageTree: {} as ToolSet[string],
    };
    const webSearch = vi.fn(() => "web-search-tool" as unknown as ToolSet[string]);
    const tools = addWebSearchTool({
      tools: typo3Tools,
      providerResolution: {
        providerKind: "openai",
        isChatCompletionsPath: false,
        provider: {
          tools: {
            webSearch,
          },
        },
      } as unknown as Pick<
        ChatProviderResolution,
        "isChatCompletionsPath" | "provider" | "providerKind"
      >,
    });

    expect(tools).toEqual({
      GetPageTree: typo3Tools.GetPageTree,
      web_search: "web-search-tool",
    });
    expect(webSearch).toHaveBeenCalledWith({ searchContextSize: "medium" });
  });
});
