-- 045_ledger_invoices.sql
--
-- Purchased credits, and the invoices that sell them.
--
-- ── Why a ledger and not a balance column ───────────────────────────────────
-- A single `credits_remaining` integer is one UPDATE away from being wrong with
-- no way to find out how. A ledger answers "why is the balance this" — which is
-- the only question anyone asks about a credit balance, and always at the worst
-- moment. Rows are append-only; the balance is their sum.
--
-- ── How this coexists with the meters ───────────────────────────────────────
-- Plan credits are DERIVED from the monthly counters and reset with them.
-- Purchased credits are STORED here and carry over. They are spent in that
-- order: the plan allowance first, this balance only once the allowance is gone.
-- `StudioUsage.reserve` does both in one transaction, so a job can never consume
-- a credit the ledger did not record.

BEGIN;

CREATE TABLE IF NOT EXISTS credit_ledger (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   INTEGER      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- purchase: credits bought. spend: consumed past the plan allowance.
  -- refund: a reservation that came back, or a reversed payment.
  kind        TEXT         NOT NULL CHECK (kind IN ('purchase', 'spend', 'refund')),
  -- Signed: purchases and refunds positive, spends negative. The balance is a
  -- SUM with no CASE in it, which is one fewer place to get a sign wrong.
  credits     NUMERIC(12,2) NOT NULL,
  -- Which meter caused a spend. Null for purchases.
  metric      TEXT,
  -- What this row is about: a payment id for a purchase, a job id for a spend.
  -- Deliberately loose — the ledger outlives whatever it points at.
  reference   TEXT,
  note        TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT credit_ledger_sign CHECK (
    (kind = 'spend' AND credits < 0) OR (kind IN ('purchase','refund') AND credits > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_tenant ON credit_ledger(tenant_id, id);
-- One purchase per payment, enforced rather than hoped for: a webhook that
-- arrives twice — which Razorpay explicitly allows — must not credit twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_ledger_purchase
  ON credit_ledger(reference) WHERE kind = 'purchase' AND reference IS NOT NULL;

COMMENT ON TABLE credit_ledger IS
  'Append-only. Balance is SUM(credits). Purchased credits are spent only after '
  'the plan allowance for the month is exhausted.';

-- ── Invoices ────────────────────────────────────────────────────────────────
--
-- Named `studio_invoices`, not `invoices`.
--
-- The first attempt used the bare name and failed: `CREATE TABLE IF NOT EXISTS`
-- found an existing `invoices` table, skipped silently, and the index on
-- payment_id then failed against a table with no such column. That table is not
-- in any migration in this repo — the schema has drifted from the ledger again,
-- exactly as `users.password` had.
--
-- Merging into it would be a guess about what it means. Every other table this
-- product added is namespaced — studio_entitlements, studio_usage_counters,
-- studio_shot_characters — so this one is too, and whatever the other invoices
-- table is remains someone else's to explain.
--
-- To see what it actually is:
--   \d invoices
--
-- Buyer details are SNAPSHOTTED, not joined. An invoice is a statement about a
-- moment: if someone changes their registered address in March, the January
-- invoice must still show where they were in January. Joining to `users` would
-- silently rewrite history every time somebody edits their profile.
--
-- The tax split is stored too, for the same reason — the rate can change, and a
-- reissued invoice has to match the one already filed.
CREATE TABLE IF NOT EXISTS studio_invoices (
  id            BIGSERIAL PRIMARY KEY,
  -- Human-facing, gapless, and unique. GST rules expect a consecutive series;
  -- allocation is serialised in the application so a rolled-back transaction
  -- cannot leave a hole.
  number        TEXT         NOT NULL UNIQUE,
  tenant_id     INTEGER      NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id       INTEGER      NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payment_id    INTEGER      REFERENCES payments(id) ON DELETE SET NULL,

  issued_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  description   TEXT         NOT NULL,

  -- All money in paise. Rupees are a display concern; a float here is how a
  -- ledger ends up 3 paise out and nobody can say which invoice did it.
  subtotal      INTEGER      NOT NULL,
  cgst          INTEGER      NOT NULL DEFAULT 0,
  sgst          INTEGER      NOT NULL DEFAULT 0,
  igst          INTEGER      NOT NULL DEFAULT 0,
  total         INTEGER      NOT NULL,
  currency      VARCHAR(3)   NOT NULL DEFAULT 'INR',
  tax_rate      NUMERIC(5,2) NOT NULL DEFAULT 18.00,

  -- Snapshot of who was billed.
  buyer_name    TEXT,
  buyer_gstin   VARCHAR(15),
  buyer_address TEXT,
  buyer_state   TEXT,
  buyer_country CHAR(2)      NOT NULL DEFAULT 'IN',
  place_of_supply TEXT,

  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Either one intra-state pair or one inter-state amount, never both. A row
  -- carrying CGST and IGST at once is a filing error, and it is cheaper to
  -- refuse it here than to find it in a return.
  CONSTRAINT studio_invoices_tax_shape CHECK (
    (igst = 0) OR (cgst = 0 AND sgst = 0)
  ),
  CONSTRAINT studio_invoices_total CHECK (total = subtotal + cgst + sgst + igst)
);

CREATE INDEX IF NOT EXISTS idx_studio_invoices_tenant ON studio_invoices(tenant_id, issued_at DESC);
-- One invoice per payment. The webhook and the client-side verify can both
-- report the same success, and two invoices for one payment is worse than none.
CREATE UNIQUE INDEX IF NOT EXISTS uq_studio_invoices_payment
  ON studio_invoices(payment_id) WHERE payment_id IS NOT NULL;

-- The counter behind the invoice number. A sequence would skip on rollback and
-- GST expects consecutive numbering, so this is a row taken with FOR UPDATE.
CREATE TABLE IF NOT EXISTS studio_invoice_series (
  prefix     TEXT PRIMARY KEY,
  next_value INTEGER NOT NULL DEFAULT 1
);
INSERT INTO studio_invoice_series (prefix, next_value) VALUES ('RD', 1)
ON CONFLICT (prefix) DO NOTHING;

COMMENT ON TABLE studio_invoices IS
  'Buyer details are snapshotted on purpose: an invoice states what was true when '
  'it was issued, and joining to users would rewrite history on every profile edit.';

COMMIT;
