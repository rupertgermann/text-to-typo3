import { afterEach, describe, expect, it, vi } from "vitest";
import { decrypt, encrypt } from "./crypto";

describe("secret encryption", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips plaintext without storing it verbatim", () => {
    vi.stubEnv(
      "ENCRYPTION_KEY",
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    );

    const ciphertext = encrypt("typo3-access-token");

    expect(ciphertext).not.toBe("typo3-access-token");
    expect(decrypt(ciphertext)).toBe("typo3-access-token");
  });
});
