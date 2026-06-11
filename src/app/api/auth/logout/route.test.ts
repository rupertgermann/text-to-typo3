import { describe, expect, it, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { stubTokenAuthEnv } from "@/test/auth";

describe("auth logout route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("redirects token-mode logout back to the current app origin", async () => {
    stubTokenAuthEnv();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3002");

    const response = await GET(
      new NextRequest("http://localhost:3001/api/auth/logout"),
    );

    expect(response.headers.get("location")).toBe("http://localhost:3001/");
  });
});
