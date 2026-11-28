import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ReadableStream } from "node:stream/web";
import { getEnv } from "@/lib/env";

const MAX_ACTIVE_GRANTS = 256;
const MAX_GRANT_LIFETIME_MS = 15 * 60 * 1000;
const MAX_FILE_BYTES = 500 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const UPLOAD_DEADLINE_MS = 60_000;

type UploadScope = { userId: string; conversationId: string };

type NewUpload = UploadScope & {
  uploadUrl: string;
  uploadToken: string;
  fileName: string | null;
  targetFolder: string;
  validUntil: string;
};

type UploadGrant = UploadScope & {
  url: URL;
  token: string;
  fileName: string | null;
  expiresAt: number;
  inProgress: boolean;
};

type UploadReceipt = { uid: number; fileName: string; publicUrl?: string };

type UploadFailure =
  | "upload_unavailable"
  | "invalid_file_name"
  | "invalid_upload_body"
  | "upload_too_large"
  | "typo3_upload_rejected"
  | "typo3_upload_unknown";

type UploadResult = { kind: "uploaded"; file: UploadReceipt }
  | { kind: "failed"; code: UploadFailure };

declare global {
  var textToTypo3UploadGrants: Map<string, UploadGrant> | undefined;
}

// shortcut: grants expire in this app process, use a shared store before adding app instances.
const grants = globalThis.textToTypo3UploadGrants ??= new Map();

function asHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) {
      return url;
    }
  } catch {
    return null;
  }
  return null;
}

function validateUploadEndpoint(value: string): URL | null {
  const { TYPO3_BASE_URL, TYPO3_MCP_URL } = getEnv();
  const base = asHttpUrl(TYPO3_BASE_URL);
  const mcp = asHttpUrl(TYPO3_MCP_URL);
  const url = asHttpUrl(value);
  const rawPath = /^https?:\/\/[^/?#@\s\\]+(\/[^?#\s\\]*)$/i.exec(value)?.[1];

  if (!base || !url || url.origin !== base.origin || rawPath !== url.pathname) return null;

  const paths = ["/mcp_upload", base.pathname.replace(/\/+$/, "") + "/mcp_upload"];
  if (mcp?.origin === base.origin && mcp.pathname.endsWith("/mcp")) {
    paths.push(mcp.pathname + "_upload");
  }

  return paths.includes(url.pathname) ? url : null;
}

function isFileName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 255 && Boolean(value.trim())
    && value !== "." && value !== ".." && !/[\\/\p{Cc}]/u.test(value);
}

export function registerTypo3Upload({ userId, conversationId, uploadUrl, uploadToken, fileName, targetFolder, validUntil }: NewUpload) {
  const url = validateUploadEndpoint(uploadUrl);
  const now = Date.now();
  const expiresAt = Math.min(Date.parse(validUntil), now + MAX_GRANT_LIFETIME_MS);
  if (!url || !Number.isFinite(expiresAt) || expiresAt <= now
    || !/^[A-Za-z0-9._~+/=-]{1,256}$/.test(uploadToken)
    || (fileName !== null && (!isFileName(fileName) || fileName.includes(uploadToken)))
    || !targetFolder || targetFolder.length > 1024 || targetFolder.includes(uploadToken)) return null;

  for (const [id, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(id);
  }
  if (grants.size >= MAX_ACTIVE_GRANTS) return null;

  const id = randomUUID();
  grants.set(id, { userId, conversationId, url, token: uploadToken, fileName, expiresAt, inProgress: false });
  return { id, fileName, targetFolder, validUntil: new Date(expiresAt).toISOString() };
}

class InvalidUpload extends Error {
  constructor(readonly code: "invalid_upload_body" | "upload_too_large") {
    super(code);
  }
}

async function readReceipt(response: IncomingMessage, grant: UploadGrant): Promise<UploadResult> {
  const status = response.statusCode ?? 502;
  if (status < 200 || status >= 300) {
    response.destroy();
    return { kind: "failed", code: status >= 400 && status < 500
      ? "typo3_upload_rejected" : "typo3_upload_unknown" };
  }

  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > MAX_RECEIPT_BYTES) throw new Error("TYPO3 upload response is too large");
    chunks.push(chunk);
  }

  const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof data !== "object" || data === null
    || !("uid" in data) || typeof data.uid !== "number" || !Number.isSafeInteger(data.uid) || data.uid <= 0
    || !("fileName" in data) || !isFileName(data.fileName) || data.fileName.includes(grant.token)) {
    throw new Error("Invalid TYPO3 upload response");
  }

  const file: UploadReceipt = { uid: data.uid, fileName: data.fileName };
  if ("publicUrl" in data && typeof data.publicUrl === "string" && !data.publicUrl.includes(grant.token)) {
    const url = asHttpUrl(data.publicUrl);
    if (url?.origin === grant.url.origin && !url.search && !url.hash) file.publicUrl = url.href;
  }
  return { kind: "uploaded", file };
}

async function putFile(grant: UploadGrant, fileName: string, path: string, size: number, signal: AbortSignal) {
  const url = new URL(grant.url);
  if (grant.fileName === null) url.searchParams.set("fileName", fileName);
  const { hostname } = url;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(hostname)
    || hostname.endsWith(".ddev.site") || hostname.endsWith(".test");
  const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${grant.token}`,
      "Content-Length": size,
      "Content-Type": "application/octet-stream",
    },
    signal,
    ...(url.protocol === "https:" && local ? { rejectUnauthorized: false } : {}),
  });
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    request.once("response", resolve);
    request.once("error", reject);
  });
  const sent = pipeline(createReadStream(path), request, { signal }).then(() => true, () => false);

  try {
    const result = await response.then((incoming) => readReceipt(incoming, grant));
    if (result.kind === "uploaded" && !await sent) throw new Error("TYPO3 upload did not finish");
    return result;
  } finally {
    request.destroy();
    await sent;
  }
}

export async function forwardTypo3Upload({
  userId, conversationId, id, fileName, body, contentLength, requestSignal,
}: UploadScope & {
  id: string;
  fileName: string | null;
  body: Request["body"];
  contentLength: string | null;
  requestSignal: AbortSignal;
}): Promise<UploadResult> {
  const grant = grants.get(id);
  if (!grant || grant.userId !== userId || grant.conversationId !== conversationId
    || grant.inProgress || grant.expiresAt <= Date.now()) {
    return { kind: "failed", code: "upload_unavailable" };
  }

  const name = grant.fileName ?? fileName;
  if (!isFileName(name) || (grant.fileName !== null && fileName !== null && fileName !== grant.fileName)) {
    return { kind: "failed", code: "invalid_file_name" };
  }

  const expectedBytes = contentLength === null ? null : Number(contentLength);
  if (!(body instanceof ReadableStream) || expectedBytes === 0 || (contentLength !== null && !/^\d+$/.test(contentLength))) {
    return { kind: "failed", code: "invalid_upload_body" };
  }
  if (expectedBytes !== null && expectedBytes > MAX_FILE_BYTES) {
    return { kind: "failed", code: "upload_too_large" };
  }

  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(UPLOAD_DEADLINE_MS)]);
  grant.inProgress = true;
  let directory: string | undefined;
  let dispatched = false;
  try {
    directory = await mkdtemp(join(tmpdir(), "text-to-typo3-upload-"));
    const path = join(directory, "file");
    let bytes = 0;

    // Stage the bytes so a truncated or oversized input cannot reach TYPO3 as a partial file.
    await pipeline(Readable.fromWeb(body, { signal }), async function* (source: AsyncIterable<Uint8Array>) {
      for await (const chunk of source) {
        bytes += chunk.byteLength;
        if (bytes > MAX_FILE_BYTES) throw new InvalidUpload("upload_too_large");
        if (expectedBytes !== null && bytes > expectedBytes) throw new InvalidUpload("invalid_upload_body");
        yield chunk;
      }
      if (!bytes || (expectedBytes !== null && bytes !== expectedBytes)) {
        throw new InvalidUpload("invalid_upload_body");
      }
    }, createWriteStream(path, { mode: 0o600 }), { signal });

    if (grant.expiresAt <= Date.now() || !validateUploadEndpoint(grant.url.href)) {
      return { kind: "failed", code: "upload_unavailable" };
    }
    signal.throwIfAborted();
    grants.delete(id);
    dispatched = true;
    return await putFile(grant, name, path, bytes, signal);
  } catch (error) {
    const code = error instanceof InvalidUpload ? error.code : dispatched
      ? "typo3_upload_unknown" : "invalid_upload_body";
    return { kind: "failed", code };
  } finally {
    grant.inProgress = false;
    if (directory) {
      await rm(directory, { recursive: true, force: true }).catch(() => {
        console.error("Could not remove temporary TYPO3 upload");
      });
    }
  }
}
