import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateSettingsKey, isEncrypted } from "../src/crypto.js";

const env = { SETTINGS_KEY: generateSettingsKey() };

describe("secret encryption (AES-256-GCM)", () => {
  it("round-trips a secret", () => {
    const blob = encryptSecret("sk-ant-super-secret-key", env);
    expect(isEncrypted(blob)).toBe(true);
    expect(blob).not.toContain("super-secret");
    expect(decryptSecret(blob, env)).toBe("sk-ant-super-secret-key");
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encryptSecret("x", env)).not.toBe(encryptSecret("x", env));
  });

  it("fails to decrypt with the wrong key", () => {
    const blob = encryptSecret("secret", env);
    expect(() => decryptSecret(blob, { SETTINGS_KEY: generateSettingsKey() })).toThrow();
  });

  it("rejects a tampered blob", () => {
    const blob = encryptSecret("secret", env);
    const tampered = blob.slice(0, -4) + "AAAA";
    expect(() => decryptSecret(tampered, env)).toThrow();
  });

  it("derives a key from APP_SECRET when SETTINGS_KEY is absent", () => {
    const e = { APP_SECRET: "a-long-enough-app-secret-value-1234567890" };
    expect(decryptSecret(encryptSecret("v", e), e)).toBe("v");
  });
});
