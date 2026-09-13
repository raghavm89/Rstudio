-- 046_invoice_payment_ref.sql
--
-- The gateway's payment id, on the invoice itself.
--
-- `studio_invoices.payment_id` is our own row id and it is a foreign key with
-- ON DELETE SET NULL — so an invoice can end up pointing at nothing, and even
-- while it points somewhere it is a number that means something only inside this
-- database. Neither is any use to the person actually reconciling: they are
-- holding a Razorpay dashboard, or a bank statement, and both speak `pay_...`.
--
-- Snapshotted for the same reason the buyer's address is. An invoice states what
-- was true when it was issued and has to stand on its own — an invoice whose
-- payment reference is a join is an invoice that can lose it.

BEGIN;

ALTER TABLE studio_invoices
  -- The gateway's own id: pay_XXXXXXXXXXXX for a payment, or the order id when
  -- a payment id is not yet known. Text, because it is somebody else's format
  -- and will outlive whatever shape we assume for it.
  ADD COLUMN IF NOT EXISTS payment_ref TEXT,
  -- How it was paid, when the gateway tells us — card, upi, netbanking. Printed
  -- on the invoice because "which card was this" is the second question after
  -- "what was this for".
  ADD COLUMN IF NOT EXISTS payment_method TEXT;

CREATE INDEX IF NOT EXISTS idx_studio_invoices_payment_ref
  ON studio_invoices(payment_ref) WHERE payment_ref IS NOT NULL;

COMMENT ON COLUMN studio_invoices.payment_ref IS
  'The gateway payment id, copied in at issue. Not a join: payment_id is ON '
  'DELETE SET NULL, and an invoice must still name its payment afterwards.';

COMMIT;
