export type StarterPromptCategory =
  | "inspection"
  | "content"
  | "news"
  | "translation";

export type StarterPrompt = {
  id: string;
  category: StarterPromptCategory;
  title: string;
  description: string;
  prompt: string;
};

export const starterPrompts: StarterPrompt[] = [
  {
    id: "inspect-site-structure",
    category: "inspection",
    title: "Inspect site structure",
    description: "Map the page tree and identify the main content areas.",
    prompt:
      "Inspect the TYPO3 page tree, summarize the main sections, and call out any pages that look like content hubs or landing pages.",
  },
  {
    id: "create-content-element",
    category: "content",
    title: "Create content element",
    description: "Draft a content element for an existing page.",
    prompt:
      "Help me create a new TYPO3 content element on a page. First inspect the available page structure and content schema, then ask me for any missing page, column, or copy details before writing.",
  },
  {
    id: "create-news-record",
    category: "news",
    title: "Create news record",
    description: "Prepare a news item with the right fields and placement.",
    prompt:
      "Create a TYPO3 news record. Inspect the news table schema first, then help me fill title, teaser, body, date, category, and storage location before writing the record.",
  },
  {
    id: "translate-content",
    category: "translation",
    title: "Translate content",
    description: "Translate page or record content while preserving structure.",
    prompt:
      "Translate existing TYPO3 content into another language. Start by inspecting the source page or record, preserve the original structure, and ask which target language and records I want translated.",
  },
];
