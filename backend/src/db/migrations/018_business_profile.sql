-- Migration 018: business profile fields on users
-- Adds account type, business details, and billing address for tenant admins.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS account_type       VARCHAR(20)  NOT NULL DEFAULT 'individual'
                                              CHECK (account_type IN ('individual', 'business')),
  ADD COLUMN IF NOT EXISTS business_name      TEXT,
  ADD COLUMN IF NOT EXISTS business_website   TEXT,
  ADD COLUMN IF NOT EXISTS business_industry  TEXT,
  ADD COLUMN IF NOT EXISTS gstin              TEXT,
  ADD COLUMN IF NOT EXISTS billing_address    JSONB;

-- billing_address shape:
-- {
--   "line1":   "...",
--   "line2":   "...",   -- optional
--   "city":    "...",
--   "state":   "...",
--   "pincode": "...",
--   "country": "India"
-- }

COMMENT ON COLUMN users.account_type      IS 'individual or business';
COMMENT ON COLUMN users.business_name     IS 'Legal business / company name';
COMMENT ON COLUMN users.business_website  IS 'Company website URL';
COMMENT ON COLUMN users.business_industry IS 'Industry vertical (e.g. Technology & Software)';
COMMENT ON COLUMN users.gstin            IS 'GST Identification Number (15-char, India)';
COMMENT ON COLUMN users.billing_address  IS 'JSON billing address used to prefill checkout';
