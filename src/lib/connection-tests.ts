import { McpHttpError, testMcpConnection } from "@/lib/mcp";

export type ConnectionErrorCode =
  | "auth_failed"
  | "bad_url"
  | "provider_error"
  | "unreachable";

export type ConnectionTestError = {
  code: ConnectionErrorCode;
  message: string;
};

export type McpConnectionTestResult =
  | { ok: true; toolCount: number }
  | { ok: false; error: ConnectionTestError };

export type ModelProviderConnectionTestResult =
  | { ok: true; modelCount: number }
  | { ok: false; error: ConnectionTestError };

export async function runMcpConnectionTest(
  accessToken: string,
): Promise<McpConnectionTestResult> {
  try {
    const toolCount = await testMcpConnection(accessToken);
    return { ok: true, toolCount };
  } catch (error) {
    return { ok: false, error: categorizeConnectionError(error, "MCP") };
  }
}

export async function runModelProviderConnectionTest({
  apiKey,
  baseUrl,
}: {
  apiKey?: string | null;
  baseUrl: string;
}): Promise<ModelProviderConnectionTestResult> {
  let modelsUrl: URL;

  try {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    modelsUrl = new URL(`${normalizedBaseUrl}/models`);
  } catch {
    return {
      ok: false,
      error: {
        code: "bad_url",
        message: "The provider URL is not valid.",
      },
    };
  }

  try {
    const response = await fetch(modelsUrl, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    });

    if (!response.ok) {
      return {
        ok: false,
        error: categorizeHttpStatus(response.status, "provider"),
      };
    }

    const json = await response.json() as { data?: unknown };
    const modelCount = Array.isArray(json.data) ? json.data.length : 0;
    return { ok: true, modelCount };
  } catch (error) {
    return {
      ok: false,
      error: categorizeConnectionError(error, "provider"),
    };
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Unsupported protocol");
  }

  return url.toString().replace(/\/+$/, "");
}

function categorizeConnectionError(
  error: unknown,
  target: "MCP" | "provider",
): ConnectionTestError {
  if (error instanceof McpHttpError) {
    return categorizeHttpStatus(error.status, target);
  }

  if (
    error instanceof TypeError &&
    /invalid url|failed to parse url|url is not valid/i.test(error.message)
  ) {
    return {
      code: "bad_url",
      message: `The ${target} URL is not valid.`,
    };
  }

  if (error instanceof SyntaxError) {
    return {
      code: "provider_error",
      message: `The ${target} endpoint returned an invalid response.`,
    };
  }

  return {
    code: "unreachable",
    message: `The ${target} endpoint could not be reached.`,
  };
}

function categorizeHttpStatus(
  status: number,
  target: "MCP" | "provider",
): ConnectionTestError {
  if (status === 401 || status === 403) {
    return {
      code: "auth_failed",
      message: `The ${target} endpoint rejected the configured credentials.`,
    };
  }

  return {
    code: "provider_error",
    message: `The ${target} endpoint returned HTTP ${status}.`,
  };
}
