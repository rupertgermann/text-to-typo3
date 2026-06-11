import type { NextRequest } from "next/server";
import {
  getAuthenticatedUser,
  type AuthenticatedUserContext,
} from "@/lib/auth";

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
  };
};

type ApiRouteResult = Response | Promise<Response>;
type EmptyRouteContext = { params: Promise<Record<string, never>> };
type ApiRouteHandler<TContext> = {
  (request: NextRequest, context: TContext): Promise<Response>;
  (request: NextRequest): Promise<Response>;
  (): Promise<Response>;
};

export function apiError(
  code: string,
  message: string,
  status: number,
): Response {
  return Response.json({ error: { code, message } } satisfies ApiErrorBody, {
    status,
  });
}

export function badRequest(message: string, code = "bad_request"): Response {
  return apiError(code, message, 400);
}

export function notFound(message: string, code = "not_found"): Response {
  return apiError(code, message, 404);
}

export function unauthorized(): Response {
  return apiError("unauthorized", "Unauthorized", 401);
}

export function upstreamError(message: string, code = "upstream_error"): Response {
  return apiError(code, message, 502);
}

export function withApiRoute<TContext = EmptyRouteContext>(
  handler: (request: NextRequest, context: TContext) => ApiRouteResult,
): ApiRouteHandler<TContext> {
  return (async (
    request?: NextRequest,
    context?: TContext,
  ): Promise<Response> =>
    handler(
      request as NextRequest,
      (context ?? { params: Promise.resolve({}) }) as TContext,
    )) as ApiRouteHandler<TContext>;
}

export function withAuth<TContext = EmptyRouteContext>(
  handler: (
    request: NextRequest,
    auth: AuthenticatedUserContext,
    context: TContext,
  ) => ApiRouteResult,
) {
  return withApiRoute<TContext>(async (request, context) => {
    const auth = await getAuthenticatedUser();

    if (!auth) {
      return unauthorized();
    }

    return handler(request, auth, context);
  });
}
