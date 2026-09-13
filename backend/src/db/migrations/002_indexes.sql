-- FK lookups that aren't backed by a UNIQUE constraint table-scan otherwise.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id      ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family_id    ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_verification_codes_user_id  ON verification_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id       ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_user_id            ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_subscription_id    ON payments(subscription_id);
CREATE INDEX IF NOT EXISTS idx_payments_razorpay_order_id  ON payments(razorpay_order_id);
