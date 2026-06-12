import type { ToolSet } from "ai";
import type { ChatProviderResolution } from "@/lib/chat-provider-resolution";

type WebSearchCapableProvider = Pick<
  ChatProviderResolution,
  "isChatCompletionsPath" | "provider" | "providerKind"
>;

export function supportsWebSearchTool(
  providerResolution: Pick<
    WebSearchCapableProvider,
    "isChatCompletionsPath" | "providerKind"
  >,
): boolean {
  return (
    providerResolution.providerKind === "openai" &&
    !providerResolution.isChatCompletionsPath
  );
}

export function addWebSearchTool({
  providerResolution,
  tools,
}: {
  providerResolution: WebSearchCapableProvider;
  tools: ToolSet;
}): ToolSet {
  if (!supportsWebSearchTool(providerResolution)) {
    return tools;
  }

  return {
    ...tools,
    web_search: providerResolution.provider.tools.webSearch({
      searchContextSize: "medium",
    }),
  };
}
