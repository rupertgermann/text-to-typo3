import { getChangeTarget, getMcpOutputMeta, hasUnknownWriteOutcome } from "@/lib/mcp-outcome";
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

type RecordLink = { kind: "live" | "preview"; href: string };

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
  const meta = getMcpOutputMeta(part.output);
  if (meta?.operation === "read" || meta?.operation === "write") {
    return meta.operation;
  }

  return getChangeTarget(getToolName(part)) ? "write" : "read";
}

export function getOperationType(part: GenericToolPart): ToolOperation {
  if (part.state === "output-error" || hasUnknownWriteOutcome(part.output)) {
    return "error";
  }

  return getToolIntent(part);
}

export function getBackendRecordUrl(part: GenericToolPart): string | null {
  return resolvePublicUrl(getMcpOutputMeta(part.output)?.backendRecordUrl);
}

export function buildWorkspaceModuleUrl(typo3BaseUrl: string): string | null {
  const baseUrl = parseConfiguredBaseUrl(typo3BaseUrl);
  if (!baseUrl) {
    return null;
  }

  return new URL(WORKSPACE_MODULE_PATH, baseUrl).toString();
}

function isSuccessfulWrite(part: GenericToolPart): boolean {
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

  const outcome = getMcpOutputMeta(part.output)?.outcome;
  if (
    outcome === "pending" || outcome === "unknown" || outcome === "blocked" || outcome === "rejected" ||
    (isRecord(part.output) && part.output.isError === true)
  ) {
    return false;
  }

  return true;
}

export function getToolChangeTarget(part: GenericToolPart) {
  const target = getMcpOutputMeta(part.output)?.changeTarget;
  return target === "workspace" || target === "storage" ? target : getChangeTarget(getToolName(part));
}

export function isSuccessfulStorageWrite(part: GenericToolPart): boolean {
  return getToolChangeTarget(part) === "storage" && isSuccessfulWrite(part);
}

export function isSuccessfulWorkspaceWrite(part: GenericToolPart): boolean {
  return getToolChangeTarget(part) !== "storage" && isSuccessfulWrite(part);
}

export function getRecordLinks(output: unknown): RecordLink[] {
  const rawLinks = getMcpOutputMeta(output)?.recordLinks;
  if (!Array.isArray(rawLinks)) return [];

  const links: RecordLink[] = [];
  const seen = new Set<string>();
  for (const link of rawLinks) {
    if (!isRecord(link) || (link.kind !== "live" && link.kind !== "preview")) continue;
    const href = resolvePublicUrl(link.url);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    links.push({ kind: link.kind, href });
  }
  return links;
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
  if (!isRecord(output)) {
    return output;
  }

  return Object.fromEntries(
    Object.entries(output).filter(
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

    const rawPublicUrl = current.public_url ?? current.publicUrl;
    if (typeof rawPublicUrl === "string") {
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
      if (typeof child === "string" && ((key === "text" && current.type === "text") || key === "output")) {
        try {
          const parsed: unknown = JSON.parse(child);
          visit(parsed);
        } catch {
          // MCP also returns plain-text results.
        }
      } else {
        visit(child);
      }
    }
  }

  visit(value);
  return assets;
}

export function resolvePublicUrl(
  rawUrl: unknown,
  typo3BaseUrl = "",
): string | null {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return null;
  const trimmedUrl = rawUrl.trim();
  const baseUrl = parseConfiguredBaseUrl(typo3BaseUrl);

  try {
    const url = new URL(trimmedUrl, baseUrl ?? undefined);
    return isWebUrl(url) ? url.href : null;
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
    const url = new URL(trimmedBaseUrl);
    return isWebUrl(url) ? url : null;
  } catch {
    return null;
  }
}

function isWebUrl(url: URL): boolean {
  return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
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
