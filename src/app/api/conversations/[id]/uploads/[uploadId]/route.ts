import { apiError, notFound, withAuth } from "@/lib/api-route";
import { getConversationForUser } from "@/lib/conversations";
import { getEnv } from "@/lib/env";
import { forwardTypo3Upload } from "@/lib/typo3-upload";

type RouteContext = { params: Promise<{ id: string; uploadId: string }> };

const UPLOAD_ERRORS = {
  upload_unavailable: [404, "This upload request is unavailable or has expired. If you already sent the file, check TYPO3 file storage first. Ask for a new upload if you still need one."],
  invalid_file_name: [400, "Choose a valid file name for this upload."],
  invalid_upload_body: [400, "The selected file could not be read. Choose it again."],
  upload_too_large: [413, "The selected file exceeds the 500 MiB upload limit."],
  typo3_upload_rejected: [422, "TYPO3 rejected the file. Ask for a new upload to try again."],
  typo3_upload_unknown: [502, "The upload outcome is unknown. Check TYPO3 before requesting another upload."],
} as const;

export const PUT = withAuth<RouteContext>(async (request, auth, { params }) => {
  const { APP_URL } = getEnv();
  const appUrl = URL.canParse(APP_URL) ? new URL(APP_URL) : null;
  if (!appUrl || (appUrl.protocol !== "http:" && appUrl.protocol !== "https:")
    || request.headers.get("origin") !== appUrl.origin) {
    return apiError("invalid_origin", "Upload requests must come from this app.", 403);
  }

  const { id, uploadId } = await params;
  if (!await getConversationForUser(auth.user.id, id)) {
    return notFound("Conversation not found");
  }

  const result = await forwardTypo3Upload({
    userId: auth.user.id,
    conversationId: id,
    id: uploadId,
    fileName: new URL(request.url).searchParams.get("fileName"),
    body: request.body,
    contentLength: request.headers.get("content-length"),
    requestSignal: request.signal,
  });
  if (result.kind === "uploaded") {
    return Response.json(result.file);
  }

  const [status, message] = UPLOAD_ERRORS[result.code];
  return apiError(result.code, message, status);
});
