-- The lead a sign-up came from (outreach flow "record their sign-up"), as a foreign key.
ALTER TABLE signups ADD COLUMN lead_id INT NULL;
ALTER TABLE signups ADD INDEX signups_lead (lead_id);
