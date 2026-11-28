import { readApiErrorMessage } from "@/lib/api-client";
import { getMcpOutputMeta } from "@/lib/mcp-outcome";
import { resolvePublicUrl } from "./tool-rendering";

export type Typo3Upload = {
  id: string;
  fileName: string | null;
  targetFolder: string;
  expiresAt: number;
};

type UploadReceipt = {
  uid: number;
  fileName: string;
  publicUrl: string | null;
};

export type UploadStatus =
  | { kind: "uploading" }
  | { kind: "failed" | "unavailable"; message: string }
  | { kind: "complete"; receipt: UploadReceipt };

export type Typo3UploadControls = {
  conversationId: string;
  statuses: ReadonlyMap<string, UploadStatus>;
  onUpload: (upload: Typo3Upload, file: File) => void;
  onUseFile?: (uid: number) => void;
};

export function getTypo3Upload(output: unknown): Typo3Upload | null {
  const meta = getMcpOutputMeta(output);
  if (meta?.outcome !== "pending") return null;
  const upload = meta.upload;
  if (!upload || typeof upload !== "object" ||
      !("id" in upload) || typeof upload.id !== "string" || !/^[a-z0-9_-]+$/i.test(upload.id) ||
      !("fileName" in upload) || (upload.fileName !== null && typeof upload.fileName !== "string") ||
      !("targetFolder" in upload) || typeof upload.targetFolder !== "string" ||
      !("validUntil" in upload) || typeof upload.validUntil !== "string") {
    return null;
  }

  const expiresAt = Date.parse(upload.validUntil);
  if (!Number.isFinite(expiresAt)) return null;
  return { id: upload.id, fileName: upload.fileName, targetFolder: upload.targetFolder, expiresAt };
}

function parseReceipt(value: unknown): UploadReceipt | null {
  if (!value || typeof value !== "object" ||
      !("uid" in value) || typeof value.uid !== "number" || !Number.isSafeInteger(value.uid) || value.uid < 1 ||
      !("fileName" in value) || typeof value.fileName !== "string" || !value.fileName) {
    return null;
  }
  return {
    uid: value.uid,
    fileName: value.fileName,
    publicUrl: resolvePublicUrl("publicUrl" in value ? value.publicUrl : null),
  };
}

export const EXPIRED_UPLOAD_MESSAGE = "This upload request expired. If you already sent the file, check TYPO3 file storage first. Ask for a new upload if you still need one.";
const failedMessage = "The upload could not be confirmed. Check TYPO3 file storage before requesting another upload.";

export async function putTypo3File({
  conversationId,
  upload,
  file,
}: {
  conversationId: string;
  upload: Typo3Upload;
  file: File;
}): Promise<UploadStatus> {
  if (Date.now() >= upload.expiresAt) return { kind: "unavailable", message: EXPIRED_UPLOAD_MESSAGE };

  const path = `/api/conversations/${encodeURIComponent(conversationId)}/uploads/${encodeURIComponent(upload.id)}`;
  const query = upload.fileName === null ? `?${new URLSearchParams({ fileName: file.name })}` : "";
  try {
    const response = await fetch(path + query, {
      method: "PUT",
      redirect: "error",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!response.ok) {
      return {
        kind: [400, 413].includes(response.status) ? "failed" : "unavailable",
        message: await readApiErrorMessage(response, failedMessage),
      };
    }

    const receipt = parseReceipt(await response.json());
    if (receipt) return { kind: "complete", receipt };
  } catch {
    // The file may have been stored before the response was lost.
  }
  return { kind: "unavailable", message: failedMessage };
}

function receiptKey(conversationId: string, uploadId: string): string {
  return `text-to-typo3:file:${conversationId}:${uploadId}`;
}

export function saveTypo3UploadReceipt(conversationId: string, uploadId: string, receipt: UploadReceipt) {
  try {
    sessionStorage.setItem(receiptKey(conversationId, uploadId), JSON.stringify(receipt));
  } catch {
    // Browser storage may be disabled. The current chat can still show the receipt.
  }
}

export function getStoredTypo3UploadReceipt(conversationId: string, uploadId: string): string | null {
  try {
    return sessionStorage.getItem(receiptKey(conversationId, uploadId));
  } catch {
    return null;
  }
}

export function parseStoredTypo3UploadReceipt(value: string | null): UploadReceipt | null {
  if (!value) return null;
  try {
    return parseReceipt(JSON.parse(value));
  } catch {
    return null;
  }
}
