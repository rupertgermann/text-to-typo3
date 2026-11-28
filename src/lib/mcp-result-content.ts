import type { JSONValue } from "ai";

type RecordLink = { kind: "live" | "preview"; url: string };

const PREVIEW_REDACTION = "[workspace preview available in tool details]";
const UPLOAD_UNAVAILABLE = "The local file chooser could not be prepared. No file was uploaded.";
const UPLOAD_PENDING = "The app is waiting for the user to choose a local file. No file has been uploaded yet. Ask the user to use the file chooser in the tool result, then wait for the upload receipt before referencing the file.";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

export function getMcpResultData(result: Record<string, unknown>): Record<string, unknown> {
  const first: unknown = Array.isArray(result.content) ? result.content[0] : undefined;
  return isRecord(first) && first.type === "text" && typeof first.text === "string"
    ? parseJsonObject(first.text) ?? result
    : result;
}

function isPreviewUrl(url: URL): boolean {
  return [...url.searchParams.keys()].some((key) => key.toLowerCase() === "admcmd_prev");
}

function parseWebUrl(value: string): URL | undefined {
  try {
    const url = new URL(value.replaceAll("&amp;", "&"));
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password) return url;
  } catch {
    return undefined;
  }
}

export function redactTypo3PreviewUrls(text: string): string {
  return text
    .replace(/https?:\/\/[^\s<>"'\\()[\]{}]+/gi, (value) => {
      const url = parseWebUrl(value);
      return url && isPreviewUrl(url) ? PREVIEW_REDACTION : value;
    })
    .replace(/(\bADMCMD_prev\s*(?:=|%3D|:)\s*)[\w%-]+/gi, "$1[redacted]");
}

export function getMcpRecordContent(output: unknown, toolName?: string) {
  const links = new Map<string, RecordLink>();

  function addLink(value: string, kind: RecordLink["kind"]) {
    const url = parseWebUrl(value);
    if (url) links.set(url.href, { url: url.href, kind: isPreviewUrl(url) ? "preview" : kind });
  }

  function visit(value: unknown): JSONValue {
    if (typeof value === "string") {
      let text = value;
      if (toolName === "GetPage") {
        for (const match of text.matchAll(/^URL: (https?:\/\/\S+)\s*$/gm)) addLink(match[1], "live");
        text = text.replace(/^(Preview URL: )(https?:\/\/\S+)[ \t]*$/gm, (_, prefix, url) => {
          addLink(url, "preview");
          return prefix + PREVIEW_REDACTION;
        });
      }
      if (toolName === "GetPageTree") {
        for (const match of text.matchAll(/^.*? - (https?:\/\/[^\s]+)(?=\s|$)/gm)) addLink(match[1], "live");
        text = text.replace(/(preview with unpublished changes: )(https?:\/\/[^\s)]+)/g, (_, prefix, url) => {
          addLink(url, "preview");
          return prefix + PREVIEW_REDACTION;
        });
      }
      return redactTypo3PreviewUrls(text);
    }
    if (Array.isArray(value)) return value.map(visit);
    if (isRecord(value)) {
      return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
        if (key === "_meta") return [];
        if (key === "preview_url") {
          if (typeof child === "string") addLink(child, "preview");
          return [];
        }
        if (key === "frontend_url" && typeof child === "string") addLink(child, "live");
        if (typeof child === "string" && (key === "output" || (key === "text" && value.type === "text"))) {
          const parsed = parseJsonObject(child);
          if (parsed) return [[key, JSON.stringify(visit(parsed))]];
        }
        return [[key, visit(child)]];
      }));
    }
    return typeof value === "number" || typeof value === "boolean" ? value : null;
  }

  return { output: visit(output), recordLinks: Array.from(links.values()) };
}

export function containsUploadTicket(output: unknown): boolean {
  return /(?:uploadToken|uploadUrl)\\*"\s*:|Authorization:\s*Bearer|\/mcp_upload(?=[?#'"\s)\\]|$)/i.test(JSON.stringify(output) ?? "");
}

export function localUploadResult(state: "pending" | "unavailable") {
  return {
    ...(state === "unavailable" ? { isError: true } : {}),
    content: [{ type: "text", text: state === "pending" ? UPLOAD_PENDING : UPLOAD_UNAVAILABLE }],
  };
}

export function mcpResultForDisclosure(output: unknown, toolName?: string): JSONValue {
  const name = toolName?.replace(/^mcp\./, "");
  if (name === "UploadFile" && containsUploadTicket(output)) return localUploadResult("unavailable");
  return getMcpRecordContent(output, name).output;
}
