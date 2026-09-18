-- The affiliate's coupon code and promo link, for the asset generator (bio line, story text,
-- captions, YouTube ad break) and later for spotting their posts. iDev's roster API returns only
-- id, email, username, name and signup date, so the code comes from our own sign-ups where we
-- assigned it, and is pasted in by hand for the affiliates that pre-date this engine.
ALTER TABLE affiliates ADD COLUMN coupon_code VARCHAR(40) NULL;
ALTER TABLE affiliates ADD COLUMN referral_link VARCHAR(500) NULL;

-- Backfill from sign-ups we provisioned: same person, same email.
UPDATE affiliates a
  JOIN signups s ON s.email_normalized = LOWER(TRIM(a.email))
SET a.coupon_code = s.coupon_code
WHERE a.coupon_code IS NULL AND s.coupon_code IS NOT NULL AND s.coupon_code <> '';
