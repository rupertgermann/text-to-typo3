export function getEnv() {
  return {
    TYPO3_BASE_URL: process.env.TYPO3_BASE_URL || "",
    TYPO3_MCP_URL: process.env.TYPO3_MCP_URL || "",
    TYPO3_MCP_ACCESS_TOKEN: process.env.TYPO3_MCP_ACCESS_TOKEN || "",
    TYPO3_LOCAL_USER_NAME: process.env.TYPO3_LOCAL_USER_NAME || "Local TYPO3 Token",
    TYPO3_OAUTH_CLIENT_ID: process.env.TYPO3_OAUTH_CLIENT_ID || "",
    TYPO3_OAUTH_CLIENT_SECRET: process.env.TYPO3_OAUTH_CLIENT_SECRET || "",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || "",
    SESSION_SECRET: process.env.SESSION_SECRET || "",
    APP_URL: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
    TYPO3_MCP_SYSTEM_PROMPT: process.env.TYPO3_MCP_SYSTEM_PROMPT || "",
  };
}
