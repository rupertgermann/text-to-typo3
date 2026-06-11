import { describe, expect, it } from "vitest";
import { starterPrompts } from "./starter-prompts";

describe("starter prompts", () => {
  it("contains complete prompt cards with stable ids", () => {
    expect(starterPrompts.length).toBeGreaterThanOrEqual(4);
    expect(new Set(starterPrompts.map((prompt) => prompt.id)).size).toBe(
      starterPrompts.length,
    );

    for (const prompt of starterPrompts) {
      expect(prompt.id).toMatch(/^[a-z0-9-]+$/);
      expect(prompt.title.trim()).not.toBe("");
      expect(prompt.description.trim()).not.toBe("");
      expect(prompt.prompt.trim().length).toBeGreaterThan(40);
    }
  });

  it("covers the core TYPO3 task templates", () => {
    expect(starterPrompts.map((prompt) => prompt.category).sort()).toEqual([
      "content",
      "inspection",
      "news",
      "translation",
    ]);
  });
});
