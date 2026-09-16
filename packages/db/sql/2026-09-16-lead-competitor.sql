-- The competitor a signed lead promotes, as a foreign key (attribution is never a matched string).
-- Its commission rate against ours picks the outreach offer (core/outreach-path.ts).
ALTER TABLE leads ADD COLUMN competitor_id INT NULL;
ALTER TABLE leads ADD INDEX leads_competitor (competitor_id);
