// Serving the affiliate asset templates: the stored wording, and one affiliate's assets rendered and
// checked against the compliance linter. Nothing is handed to an affiliate that the linter blocks,
// so a wording edit that breaks a rule shows up in the admin instead of in someone's bio.

import { eq } from "drizzle-orm";
import { affiliateAssetSettings, renderAssets, type AffiliateAssetSettings, type RenderedAsset } from "@biolinx/core";
import { isBlocked, lint, type LintViolation } from "@biolinx/compliance";
import { schema, type Db } from "@biolinx/db";

export const ASSET_SETTINGS_KEY = "affiliate_assets";

export async function loadAssetSettings(db: Db): Promise<AffiliateAssetSettings> {
  const row = await db.query.config.findFirst({ where: eq(schema.config.key, ASSET_SETTINGS_KEY) });
  return affiliateAssetSettings(row?.value);
}

export async function saveAssetSettings(db: Db, value: unknown, userId: number | null): Promise<AffiliateAssetSettings> {
  const clean = affiliateAssetSettings(value);
  await db
    .insert(schema.config)
    .values({ key: ASSET_SETTINGS_KEY, value: clean, updatedByUserId: userId })
    .onDuplicateKeyUpdate({ set: { value: clean, updatedByUserId: userId } });
  return clean;
}

export interface CheckedAsset extends RenderedAsset {
  violations: LintViolation[];
  /** True when compliance says this must not be posted as written. */
  blocked: boolean;
}

/** An affiliate's assets, filled in and linted as public affiliate-facing content. */
export function assetsFor(subject: { firstName: string | null; couponCode: string | null; referralLink: string | null }, settings: AffiliateAssetSettings): CheckedAsset[] {
  return renderAssets(subject, settings).map((a) => {
    const violations = lint(a.text, { channel: "dm", touchNumber: 1, isPublic: true, audience: "affiliate" });
    return { ...a, violations, blocked: isBlocked(violations) };
  });
}

/** The code an affiliate should promote, and where we got it. iDev's roster API doesn't return codes,
 *  so it is either one we assigned during provisioning, one a person typed in, or the one they asked
 *  for at sign-up (a suggestion, which has to be confirmed against iDev before it is used). */
export async function codeForAffiliate(db: Db, affiliate: { id: number; email: string | null; couponCode: string | null }): Promise<{ code: string | null; suggested: string | null }> {
  if (affiliate.couponCode) return { code: affiliate.couponCode, suggested: null };
  const email = (affiliate.email ?? "").trim().toLowerCase();
  if (!email) return { code: null, suggested: null };
  const signup = await db.query.signups.findFirst({ where: eq(schema.signups.emailNormalized, email) });
  return { code: signup?.couponCode ?? null, suggested: signup?.couponWordSuggestion ?? null };
}
