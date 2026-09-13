-- 039_billing_profile.sql
--
-- Billing details, structured for a GST invoice.
--
-- `users.address` already exists as one free-text line. That is enough to post a
-- letter and not enough to raise an invoice: an Indian GST invoice needs the
-- registered name, the GSTIN, and — separately — the STATE, because the state
-- decides whether the tax is CGST+SGST (same state as the supplier) or IGST
-- (different state). A state parsed out of a free-text blob at invoice time is a
-- tax error waiting for the first customer in Karnataka.
--
-- ── Why now, before checkout exists ─────────────────────────────────────────
-- Adding GSTIN after invoices have been issued means reissuing them. A business
-- customer cannot claim input credit on an invoice without their GSTIN on it,
-- and they will ask — so the cheapest moment to have the field is before the
-- first invoice, not after the first complaint.
--
-- `address` is left alone. It is the postal address on the account and some
-- rows have it; billing gets its own fields rather than overloading that one.

BEGIN;

ALTER TABLE users
  -- The name the invoice is made out to, which is frequently NOT the person's
  -- name: a creator invoicing through their company needs the company on it.
  ADD COLUMN IF NOT EXISTS billing_name    TEXT,
  -- 15 characters, and stored upper-cased — GSTINs are case-insensitive in
  -- practice and mixed case is how two spellings of one number end up in a
  -- table someone later tries to group by.
  ADD COLUMN IF NOT EXISTS gstin           VARCHAR(15),
  ADD COLUMN IF NOT EXISTS billing_line1   TEXT,
  ADD COLUMN IF NOT EXISTS billing_line2   TEXT,
  ADD COLUMN IF NOT EXISTS billing_city    TEXT,
  ADD COLUMN IF NOT EXISTS billing_state   TEXT,
  ADD COLUMN IF NOT EXISTS billing_pin     VARCHAR(12),
  -- ISO-3166 alpha-2, defaulted rather than nullable: every customer has a
  -- country, and a NULL here would have to be guessed at invoice time.
  ADD COLUMN IF NOT EXISTS billing_country CHAR(2) NOT NULL DEFAULT 'IN';

-- Shape only. Whether a GSTIN is REAL is a question for the GST portal, not a
-- regex — but the shape is fixed and worth refusing early: 2 digits of state
-- code, a 10-character PAN, an entity digit, a literal 'Z', and a checksum
-- character. Nullable, because most individual creators will not have one.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_gstin_shape') THEN
    ALTER TABLE users ADD CONSTRAINT users_gstin_shape
      CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$');
  END IF;
END $$;

COMMENT ON COLUMN users.gstin IS
  'GST identification number, upper-cased. Shape-checked only — validity is the '
  'GST portal''s answer, not a regex''s.';
COMMENT ON COLUMN users.billing_state IS
  'Its own column because it decides CGST+SGST versus IGST. Parsing it out of a '
  'free-text address at invoice time is a tax error waiting to happen.';

COMMIT;
