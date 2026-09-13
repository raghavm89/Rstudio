-- 012_subscriptions.sql
-- Add Razorpay subscription fields to expansion requests

ALTER TABLE vm_expansion_requests
  ADD COLUMN IF NOT EXISTS razorpay_plan_id         VARCHAR(100),
  ADD COLUMN IF NOT EXISTS razorpay_subscription_id  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS subscription_status       VARCHAR(30) DEFAULT 'created',
  ADD COLUMN IF NOT EXISTS next_charge_at            TIMESTAMPTZ;
