import { isToolUIPart, type UIMessage } from "ai";

export type ToolState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied";

export interface GenericToolPart {
  type: string;
  toolCallId: string;
  state: ToolState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: {
    id: string;
    approved?: boolean;
    reason?: string;
  };
  providerExecuted?: boolean;
  title?: string;
  toolName?: string;
}

export type ToolIntent = "read" | "write";
export type ToolOperation = ToolIntent | "error";

export type QueuedWorkspaceChanges = {
  count: number;
  workspaceModuleUrl: string | null;
};

export type PublicUrlAsset = {
  rawUrl: string;
  href: string;
  displayName: string;
  mimeType: string | null;
  isImage: boolean;
  thumbnailUrl: string | null;
};

const WORKSPACE_MODULE_PATH = "/typo3/module/web/workspaces";
const IMAGE_EXTENSION_PATTERN = /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;
const MIME_FIELD_NAMES = [
  "mime",
  "mimeType",
  "mime_type",
  "mediaType",
  "media_type",
  "contentType",
  "content_type",
  "file_mime_type",
];
const DISPLAY_NAME_FIELD_NAMES = [
  "filename",
  "fileName",
  "name",
  "title",
  "identifier",
];

export function getToolName(part: GenericToolPart): string {
  if (part.toolName) {
    return part.toolName;
  }

  return part.type.replace(/^tool-/, "");
}

export function getToolIntent(part: GenericToolPart): ToolIntent {
  const meta =
    part.output && typeof part.output === "object"
      ? (part.output as { _meta?: { operation?: string } })._meta
      : undefined;

  if (meta?.operation === "read" || meta?.operation === "write") {
    return meta.operation;
  }

  return getToolName(part) === "WriteTable" ? "write" : "read";
}

export function getOperationType(part: GenericToolPart): ToolOperation {
  if (part.state === "output-error") {
    return "error";
  }

  return getToolIntent(part);
}

export function getBackendRecordUrl(part: GenericToolPart): string | null {
  if (!part.output || typeof part.output !== "object") {
    return null;
  }

  const meta = (part.output as { _meta?: { backendRecordUrl?: string | null } })._meta;
  return meta?.backendRecordUrl || null;
}

export function buildWorkspaceModuleUrl(typo3BaseUrl: string): string | null {
  const baseUrl = parseConfiguredBaseUrl(typo3BaseUrl);
  if (!baseUrl) {
    return null;
  }

  return new URL(WORKSPACE_MODULE_PATH, baseUrl).toString();
}

export function isSuccessfulWorkspaceWrite(part: GenericToolPart): boolean {
  if (getToolIntent(part) !== "write") {
    return false;
  }

  if (
    part.state !== "output-available" ||
    part.errorText ||
    part.approval?.approved === false
  ) {
    return false;
  }

  if (
    part.output &&
    typeof part.output === "object" &&
    (part.output as { isError?: unknown }).isError === true
  ) {
    return false;
  }

  return true;
}

export function deriveQueuedWorkspaceChanges(
  messages: UIMessage[],
  typo3BaseUrl: string,
): QueuedWorkspaceChanges {
  const writeStatuses = new Map<string, boolean>();

  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolUIPart(part)) {
        continue;
      }

      const toolPart = part as GenericToolPart;
      if (getToolIntent(toolPart) !== "write") {
        continue;
      }

      writeStatuses.set(
        toolPart.toolCallId,
        isSuccessfulWorkspaceWrite(toolPart),
      );
    }
  }

  return {
    count: Array.from(writeStatuses.values()).filter(Boolean).length,
    workspaceModuleUrl: buildWorkspaceModuleUrl(typo3BaseUrl),
  };
}

export function stripToolOutputMeta(output: unknown): unknown {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return output;
  }

  return Object.fromEntries(
    Object.entries(output as Record<string, unknown>).filter(
      ([key]) => key !== "_meta",
    ),
  );
}

export function collectPublicUrlAssets(
  value: unknown,
  typo3BaseUrl: string,
): PublicUrlAsset[] {
  const assets: PublicUrlAsset[] = [];
  const seenHrefs = new Set<string>();

  function visit(current: unknown) {
    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item);
      }
      return;
    }

    if (!isRecord(current)) {
      return;
    }

    const rawPublicUrl = current.public_url;
    if (typeof rawPublicUrl === "string" && rawPublicUrl.trim()) {
      const href = resolvePublicUrl(rawPublicUrl, typo3BaseUrl);
      if (href && !seenHrefs.has(href)) {
        seenHrefs.add(href);
        const mimeType = getMimeType(current);
        const isImage = isImagePublicUrl(href, mimeType);
        assets.push({
          rawUrl: rawPublicUrl,
          href,
          displayName: getDisplayName(current, href),
          mimeType,
          isImage,
          thumbnailUrl:
            isImage && isConfiguredTypo3Host(href, typo3BaseUrl) ? href : null,
        });
      }
    }

    for (const [key, child] of Object.entries(current)) {
      if (key === "_meta") {
        continue;
      }
      visit(child);
    }
  }

  visit(value);
  return assets;
}

function resolvePublicUrl(
  rawUrl: string,
  typo3BaseUrl: string,
): string | null {
  const trimmedUrl = rawUrl.trim();
  const baseUrl = parseConfiguredBaseUrl(typo3BaseUrl);

  try {
    return baseUrl
      ? new URL(trimmedUrl, baseUrl).toString()
      : new URL(trimmedUrl).toString();
  } catch {
    return null;
  }
}

function parseConfiguredBaseUrl(typo3BaseUrl: string): URL | null {
  const trimmedBaseUrl = typo3BaseUrl.trim();
  if (!trimmedBaseUrl) {
    return null;
  }

  try {
    return new URL(trimmedBaseUrl);
  } catch {
    return null;
  }
}

function isConfiguredTypo3Host(href: string, typo3BaseUrl: string): boolean {
  const baseUrl = parseConfiguredBaseUrl(typo3BaseUrl);
  if (!baseUrl) {
    return false;
  }

  try {
    return new URL(href).origin === baseUrl.origin;
  } catch {
    return false;
  }
}

function isImagePublicUrl(href: string, mimeType: string | null): boolean {
  if (mimeType?.toLowerCase().startsWith("image/")) {
    return true;
  }

  try {
    return IMAGE_EXTENSION_PATTERN.test(new URL(href).pathname);
  } catch {
    return IMAGE_EXTENSION_PATTERN.test(href.split(/[?#]/, 1)[0] ?? href);
  }
}

function getMimeType(record: Record<string, unknown>): string | null {
  for (const fieldName of MIME_FIELD_NAMES) {
    const value = record[fieldName];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return null;
}

function getDisplayName(record: Record<string, unknown>, href: string): string {
  for (const fieldName of DISPLAY_NAME_FIELD_NAMES) {
    const value = record[fieldName];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  try {
    const pathnameParts = new URL(href).pathname.split("/").filter(Boolean);
    const fileName = pathnameParts[pathnameParts.length - 1];
    return fileName ? safeDecodeURIComponent(fileName) : href;
  } catch {
    return href;
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
