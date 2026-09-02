// Settings service: encrypted secret storage + env hydration. The engine reads
// every key via process.env, so hydrating from the DB at boot means the whole
// app works whether a value came from .env or the admin Settings page.
// Precedence: a value set in the DB overrides the .env fallback.

import { SECRET_KEYS, decryptSecret, encryptSecret, isEncrypted } from "@biolinx/core";
import { appSettings } from "./schema.js";
import type { Db } from "./index.js";

export interface SettingWrite {
  key: string;
  value: string | null; // null / "" leaves a secret unchanged; clears a non-secret
}

/** Load all DB settings into process.env (decrypting secrets). DB wins over
 *  any existing env value so the UI is authoritative in production. */
export async function hydrateEnvFromSettings(db: Db): Promise<void> {
  let rows;
  try {
    rows = await db.select().from(appSettings);
  } catch {
    return; // table may not exist yet (pre-migration) — silent, env still works
  }
  for (const row of rows) {
    if (row.value == null || row.value === "") continue;
    try {
      process.env[row.key] = row.encrypted ? decryptSecret(row.value) : row.value;
    } catch {
      // undecryptable (wrong SETTINGS_KEY) — leave the env fallback in place
    }
  }
}

/** Write a batch of settings. Secrets are encrypted; a blank secret is skipped
 *  (keep the existing value). Updates process.env live for this process. */
export async function saveSettings(db: Db, writes: SettingWrite[], userId: number | null): Promise<void> {
  for (const w of writes) {
    const isSecret = SECRET_KEYS.has(w.key);
    if (isSecret && (w.value == null || w.value === "")) continue; // don't wipe a secret on blank
    const stored = isSecret ? encryptSecret(w.value ?? "") : (w.value ?? "");
    await db
      .insert(appSettings)
      .values({ key: w.key, value: stored, encrypted: isSecret, updatedByUserId: userId })
      .onDuplicateKeyUpdate({ set: { value: stored, encrypted: isSecret, updatedByUserId: userId } });
    // Apply live so the running API picks it up without a restart.
    process.env[w.key] = isSecret ? (w.value ?? "") : (w.value ?? "");
  }
}

/** For the UI: which keys are configured. Secrets return only a boolean, never
 *  the plaintext. Non-secret values are returned as-is for display/editing. */
export async function readSettingsForUi(db: Db): Promise<Record<string, { configured: boolean; value?: string }>> {
  const rows = await db.select().from(appSettings);
  const out: Record<string, { configured: boolean; value?: string }> = {};
  for (const row of rows) {
    const secret = SECRET_KEYS.has(row.key) || isEncrypted(row.value);
    if (secret) {
      out[row.key] = { configured: !!row.value };
    } else {
      out[row.key] = { configured: !!row.value, value: row.value ?? "" };
    }
  }
  return out;
}
