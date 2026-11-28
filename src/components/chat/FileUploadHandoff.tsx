"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  EXPIRED_UPLOAD_MESSAGE,
  getStoredTypo3UploadReceipt,
  parseStoredTypo3UploadReceipt,
  type Typo3Upload,
  type Typo3UploadControls,
} from "./typo3-file-upload";

function subscribeToStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

export function FileUploadHandoff({
  upload,
  controls,
}: {
  upload: Typo3Upload;
  controls: Typo3UploadControls;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [expired, setExpired] = useState(false);
  const status = controls.statuses.get(upload.id);
  const storedReceipt = useSyncExternalStore(
    subscribeToStorage,
    () => getStoredTypo3UploadReceipt(controls.conversationId, upload.id),
    () => null,
  );
  const receipt = status?.kind === "complete" ? status.receipt : parseStoredTypo3UploadReceipt(storedReceipt);

  useEffect(() => {
    if (receipt) return;
    const timer = window.setTimeout(
      () => setExpired(true),
      Math.max(0, upload.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [receipt, upload.expiresAt]);

  if (receipt) {
    return (
      <div className="space-y-2 border-t border-current/10 bg-background/45 px-3 py-2 text-xs">
        <p role="status" className="break-words">
          Stored <strong>{receipt.fileName}</strong> in TYPO3 file storage. File UID <strong>{receipt.uid}</strong>.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {controls.onUseFile ? (
            <Button type="button" size="sm" variant="outline" onClick={() => controls.onUseFile?.(receipt.uid)}>
              Use file in chat
            </Button>
          ) : null}
          {receipt.publicUrl ? (
            <a
              href={receipt.publicUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline underline-offset-2 hover:no-underline"
            >
              Open uploaded file
              <ExternalLink aria-hidden="true" className="h-3 w-3" />
            </a>
          ) : null}
        </div>
      </div>
    );
  }

  const uploading = status?.kind === "uploading";
  const unavailable = status?.kind === "unavailable" || (expired && !uploading);
  return (
    <div className="space-y-2 border-t border-current/10 bg-background/45 px-3 py-2 text-xs">
      <p className="font-medium">Upload a local file to TYPO3 file storage</p>
      <p className="break-words">
        Folder <code>{upload.targetFolder}</code>
        {upload.fileName ? <> · Requested name <strong>{upload.fileName}</strong></> : null}
      </p>
      {!unavailable ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 space-y-1">
            <span>Choose a file</span>
            <Input
              type="file"
              disabled={uploading}
              onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
            />
          </label>
          <Button
            type="button"
            size="sm"
            disabled={!file || uploading}
            onClick={() => {
              if (file) controls.onUpload(upload, file);
            }}
          >
            {uploading ? "Uploading…" : "Upload to TYPO3"}
          </Button>
          {uploading ? <span className="sr-only" role="status">Uploading file to TYPO3</span> : null}
        </div>
      ) : null}
      {status?.kind === "unavailable" || status?.kind === "failed" ? (
        <p role="alert">{status.message}</p>
      ) : null}
      {expired && !uploading && status?.kind !== "unavailable" ? (
        <p role="status">{EXPIRED_UPLOAD_MESSAGE}</p>
      ) : null}
    </div>
  );
}
