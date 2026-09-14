ALTER TABLE leads
  ADD COLUMN enrichment_status VARCHAR(16) NULL,
  ADD COLUMN enriched_at DATETIME NULL,
  ADD COLUMN enrichment_source_url VARCHAR(500) NULL,
  ADD COLUMN enrichment_attempts INT NOT NULL DEFAULT 0;

ALTER TABLE leads DROP COLUMN needs_enrichment;

CREATE TABLE IF NOT EXISTS lead_enrichments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_id INT NOT NULL,
  platform VARCHAR(16) NOT NULL,
  source_url VARCHAR(500) NOT NULL,
  bundle JSON NULL,
  notes TEXT NULL,
  status VARCHAR(16) NOT NULL,
  error TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX enrich_lead (lead_id),
  INDEX enrich_created (created_at)
);
