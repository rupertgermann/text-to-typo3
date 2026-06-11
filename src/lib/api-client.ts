type ApiErrorLike = {
  error?: string | { message?: unknown };
};

export async function readApiErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const body = await response.clone().json() as ApiErrorLike;
    const error = body.error;

    if (typeof error === "string" && error.trim()) {
      return error;
    }

    if (
      error &&
      typeof error === "object" &&
      typeof error.message === "string" &&
      error.message.trim()
    ) {
      return error.message;
    }
  } catch {
    // Non-JSON responses keep the caller's contextual fallback.
  }

  return fallback;
}
