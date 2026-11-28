import { createServer, type Server, type ServerResponse } from "node:http";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversations, users } from "@/lib/db/schema";
import { registerTypo3Upload } from "@/lib/typo3-upload";
import { LOCAL_TOKEN_USER_ID, seedLocalTokenUser, stubTokenAuthEnv } from "@/test/auth";
import { db, setupTestDatabase, type TestDatabase } from "@/test/database";
import { PUT } from "./route";

const APP_ORIGIN = "http://localhost:3060";
const UPLOAD_TOKEN = "test-typo3-file-upload-bearer";
const BYTES = Uint8Array.from([0, 255, 10]);

describe("TYPO3 file upload handoff", () => {
  let database: TestDatabase | undefined;
  let server: Server | undefined;
  let typo3Origin: string;
  let reply: (response: ServerResponse) => void;
  let uploads: { path: string | undefined; auth: string | undefined; method: string | undefined; bytes: Buffer }[];

  beforeEach(async () => {
    database = setupTestDatabase();
    stubTokenAuthEnv();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_ORIGIN);
    await seedLocalTokenUser();
    await db.insert(users).values({
      id: "foreign-user", typo3_uid: "foreign-user", display_name: "Foreign User",
    });
    await db.insert(conversations).values([
      { id: "owned", user_id: LOCAL_TOKEN_USER_ID, title: "Owned" },
      { id: "also-owned", user_id: LOCAL_TOKEN_USER_ID, title: "Also Owned" },
      { id: "foreign", user_id: "foreign-user", title: "Foreign" },
    ]);

    uploads = [];
    const upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      uploads.push({ path: request.url, auth: request.headers.authorization, method: request.method, bytes: Buffer.concat(chunks) });
      reply(response);
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    server = upstream;
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Expected a test TCP address");
    typo3Origin = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("TYPO3_BASE_URL", typo3Origin);
    vi.stubEnv("TYPO3_MCP_URL", `${typo3Origin}/site/mcp?token=other-token`);
    reply = (response) => response.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({
      uid: 804,
      fileName: "seasonal image_01.png",
      publicUrl: `${typo3Origin}/fileadmin/seasonal%20image_01.png`,
      internalToken: UPLOAD_TOKEN,
    }));
  });

  afterEach(async () => {
    const upstream = server;
    if (upstream) {
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    database?.cleanup();
    database = undefined;
  });

  function register(overrides?: Partial<Parameters<typeof registerTypo3Upload>[0]>) {
    return registerTypo3Upload({
      userId: LOCAL_TOKEN_USER_ID,
      conversationId: "owned",
      uploadUrl: `${typo3Origin}/site/mcp_upload`,
      uploadToken: UPLOAD_TOKEN,
      targetFolder: "1:/user_upload/",
      fileName: null,
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      ...overrides,
    });
  }

  function submit(uploadId: string, {
    conversationId = "owned",
    fileName = "seasonal image.png",
    origin = APP_ORIGIN,
    contentLength,
  }: {
    conversationId?: string;
    fileName?: string | null;
    origin?: string;
    contentLength?: string;
  } = {}) {
    const url = new URL(`http://127.0.0.1:3060/api/conversations/${conversationId}/uploads/${uploadId}`);
    if (fileName !== null) url.searchParams.set("fileName", fileName);

    return PUT(new NextRequest(url, {
      method: "PUT",
      headers: {
        Origin: origin,
        ...(contentLength === undefined ? {} : { "Content-Length": contentLength }),
      },
      body: new File([BYTES], "local.png"),
    }), { params: Promise.resolve({ id: conversationId, uploadId }) });
  }

  it("forwards the raw file and the server-only bearer once and returns a minimal receipt", async () => {
    const grant = register();
    expect(grant).toEqual({ id: expect.any(String), fileName: null, targetFolder: "1:/user_upload/", validUntil: expect.any(String) });
    if (!grant) throw new Error("Expected an upload grant");

    const requests = await Promise.all([submit(grant.id), submit(grant.id)]);
    const success = requests.find(({ status }) => status === 200);

    expect(requests.map(({ status }) => status).sort()).toEqual([200, 404]);
    expect(await success?.json()).toEqual({
      uid: 804, fileName: "seasonal image_01.png", publicUrl: `${typo3Origin}/fileadmin/seasonal%20image_01.png`,
    });
    expect(uploads).toEqual([{
      path: "/site/mcp_upload?fileName=seasonal+image.png",
      auth: `Bearer ${UPLOAD_TOKEN}`,
      method: "PUT",
      bytes: Buffer.from(BYTES),
    }]);
    expect((await submit(grant.id)).status).toBe(404);
  });

  it("pins grants to the configured origin and an exact upload endpoint", () => {
    for (const uploadUrl of [
      "https://elsewhere.example/site/mcp_upload",
      typo3Origin.replace("http", "https") + "/site/mcp_upload",
      typo3Origin + "/unconfigured/mcp_upload",
      typo3Origin + "/site/../mcp_upload",
      typo3Origin + "/site/mcp_upload?",
      typo3Origin + "/site/mcp_upload#fragment",
      typo3Origin.replace("://", "://user:pass@") + "/site/mcp_upload",
    ]) {
      expect(register({ uploadUrl })).toBeNull();
    }
    expect(register({ uploadUrl: typo3Origin + "/mcp_upload" })).toBeTruthy();
    expect(register({ validUntil: new Date(Date.now() - 1000).toISOString() })).toBeNull();
    const later = register({ validUntil: "2099-01-01T00:00:00Z" });
    expect(Date.parse(later?.validUntil ?? "")).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);
  });

  it("requires same-origin, conversation ownership, and a matching unexpired grant", async () => {
    const grant = register();
    const foreign = register({ conversationId: "foreign", userId: "foreign-user" });
    const forOtherUser = register({ userId: "foreign-user" });
    if (!grant || !foreign || !forOtherUser) throw new Error("Expected upload grants");

    expect((await submit(grant.id, { origin: "https://untrusted.example" })).status).toBe(403);
    expect((await submit(grant.id, { conversationId: "also-owned" })).status).toBe(404);
    expect((await submit(foreign.id, { conversationId: "foreign" })).status).toBe(404);
    expect((await submit(forOtherUser.id)).status).toBe(404);

    vi.spyOn(Date, "now").mockReturnValue(Date.parse(grant.validUntil) + 1);
    expect((await submit(grant.id)).status).toBe(404);
    expect(uploads).toHaveLength(0);
  });

  it("blocks fixed-name overrides, oversized bodies, and incomplete bodies before dispatch", async () => {
    const grant = register({ fileName: "fixed.png" });
    if (!grant) throw new Error("Expected an upload grant");

    expect((await submit(grant.id)).status).toBe(400);
    expect((await submit(grant.id, { fileName: null, contentLength: String(501 * 1024 * 1024) })).status).toBe(413);
    expect((await submit(grant.id, { fileName: null, contentLength: "12" })).status).toBe(400);
    expect(uploads).toHaveLength(0);

    expect((await submit(grant.id, { fileName: null })).status).toBe(200);
    expect(uploads[0]?.path).toBe("/site/mcp_upload");
  });

  it("reports a TYPO3 refusal without returning its response body or reusing the grant", async () => {
    const grant = register();
    if (!grant) throw new Error("Expected an upload grant");

    reply = (response) => response.writeHead(400).end(UPLOAD_TOKEN);
    const result = await submit(grant.id);
    expect(result.status).toBe(422);
    expect(await result.text()).not.toContain(UPLOAD_TOKEN);
    expect((await submit(grant.id)).status).toBe(404);
    expect(uploads).toHaveLength(1);
  });

  it("omits unsafe public URLs and refuses to follow an upstream redirect", async () => {
    const grant = register();
    const redirected = register();
    if (!grant || !redirected) throw new Error("Expected upload grants");

    reply = (response) => response.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({
      uid: 2, fileName: "photo.png", publicUrl: "javascript:alert(1)",
    }));
    expect(await (await submit(grant.id)).json()).toEqual({ uid: 2, fileName: "photo.png" });

    reply = (response) => response.writeHead(307, { Location: `${typo3Origin}/secret` }).end(UPLOAD_TOKEN);
    const result = await submit(redirected.id);
    expect(result.status).toBe(502);
    expect(await result.text()).not.toContain(UPLOAD_TOKEN);
    expect((await submit(redirected.id)).status).toBe(404);
    expect(uploads).toHaveLength(2);
  });
});
