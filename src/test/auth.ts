import { vi } from "vitest";
import { db } from "@/test/database";
import { users } from "@/lib/db/schema";

export const LOCAL_TOKEN_USER_ID = "local-token-user";

export function stubTokenAuthEnv(overrides?: {
  mcpUrl?: string;
  mcpToken?: string;
}) {
  vi.stubEnv(
    "ENCRYPTION_KEY",
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  );
  vi.stubEnv("SESSION_SECRET", "complex_password_at_least_32_characters_long");
  vi.stubEnv("TYPO3_BASE_URL", "https://typo3.example.test");
  vi.stubEnv("TYPO3_MCP_URL", overrides?.mcpUrl ?? "https://typo3.example.test/mcp");
  vi.stubEnv("TYPO3_MCP_ACCESS_TOKEN", overrides?.mcpToken ?? "test-mcp-token");
  vi.stubEnv("TYPO3_LOCAL_USER_NAME", "Local Test Editor");
}

export async function seedLocalTokenUser() {
  await db.insert(users).values({
    id: LOCAL_TOKEN_USER_ID,
    typo3_uid: LOCAL_TOKEN_USER_ID,
    display_name: "Local Test Editor",
  });
}
