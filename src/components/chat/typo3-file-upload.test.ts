import { afterEach, expect, it, vi } from "vitest";
import { putTypo3File } from "./typo3-file-upload";

afterEach(() => vi.unstubAllGlobals());

it.each([null, "fixed.pdf"])("sends raw bytes to the same-origin route (fixed name %s)", async (fileName) => {
  const file = new File(["example file"], "photo & caption.pdf", { type: "application/pdf" });
  const request = vi.fn(async (path: string, init: RequestInit) => {
    const url = new URL(path, "https://chat.test");
    expect(url.pathname).toBe("/api/conversations/conversation/uploads/grant");
    expect(url.searchParams.get("fileName")).toBe(fileName === null ? file.name : null);
    expect(init.method).toBe("PUT");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/pdf");
    expect(init.body).toBe(file);
    return Response.json({ uid: 37, fileName: "photo_caption.pdf", publicUrl: "https://typo3.test/fileadmin/photo_caption.pdf" });
  });
  vi.stubGlobal("fetch", request);
  const result = await putTypo3File({
    conversationId: "conversation",
    upload: { id: "grant", fileName, targetFolder: "1:/media/", expiresAt: Date.now() + 10000 },
    file,
  });
  expect(request).toHaveBeenCalledOnce();
  expect(result).toEqual({
    kind: "complete",
    receipt: { uid: 37, fileName: "photo_caption.pdf", publicUrl: "https://typo3.test/fileadmin/photo_caption.pdf" },
  });
});

it("does not send a file after the grant expires", async () => {
  const request = vi.fn();
  vi.stubGlobal("fetch", request);
  const result = await putTypo3File({
    conversationId: "conversation",
    upload: { id: "grant", fileName: null, targetFolder: "1:/media/", expiresAt: Date.now() - 1 },
    file: new File(["example"], "file.txt"),
  });
  expect(request).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    kind: "unavailable",
    message: expect.stringContaining("If you already sent the file, check TYPO3 file storage first."),
  });
});
