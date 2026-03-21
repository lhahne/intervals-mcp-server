import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateToken, sha256Base64Url } from "../src/security.js";

describe("security", () => {
  it("round-trips encrypted secrets", async () => {
    const ciphertext = await encryptSecret("secret", "hello-world");
    await expect(decryptSecret("secret", ciphertext)).resolves.toBe("hello-world");
  });

  it("rejects invalid ciphertext payloads", async () => {
    await expect(decryptSecret("secret", "bad")).rejects.toThrow("Invalid encrypted secret payload.");
  });

  it("generates url-safe tokens", () => {
    const token = generateToken(24);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThan(20);
  });

  it("hashes pkce verifiers deterministically", async () => {
    await expect(sha256Base64Url("abc")).resolves.toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  });
});

