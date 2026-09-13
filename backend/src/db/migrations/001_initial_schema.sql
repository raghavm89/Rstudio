-- users
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'customer', 'developer');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(100)  NOT NULL,
  email          VARCHAR(150)  UNIQUE NOT NULL,
  password       VARCHAR(255)  NOT NULL,
  phone_number   VARCHAR(20)   UNIQUE NOT NULL,
  phone_verified BOOLEAN       DEFAULT FALSE,
  address        TEXT,
  role           user_role     NOT NULL DEFAULT 'customer',
  created_at     TIMESTAMPTZ   DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   DEFAULT NOW()
);

-- verification_codes (OTP, hashed)
CREATE TABLE IF NOT EXISTS verification_codes (
  id         SERIAL PRIMARY KEY,
  user_id    INT          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  VARCHAR(64)  NOT NULL,
  expires_at TIMESTAMPTZ  NOT NULL,
  used       BOOLEAN      DEFAULT FALSE,
  created_at TIMESTAMPTZ  DEFAULT NOW()
);

-- refresh_tokens (hashed, with family_id for reuse detection)
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          SERIAL PRIMARY KEY,
  user_id     INT           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   UUID          NOT NULL,
  token_hash  VARCHAR(64)   UNIQUE NOT NULL,
  expires_at  TIMESTAMPTZ   NOT NULL,
  revoked     BOOLEAN       DEFAULT FALSE,
  created_at  TIMESTAMPTZ   DEFAULT NOW()
);

-- plans
CREATE TABLE IF NOT EXISTS plans (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(100)  NOT NULL,
  description       TEXT,
  amount            INT           NOT NULL,
  currency          VARCHAR(3)    DEFAULT 'USD',
  interval          VARCHAR(20)   NOT NULL,
  interval_count    INT           DEFAULT 1,
  razorpay_plan_id  VARCHAR(100)  UNIQUE NOT NULL,
  is_active         BOOLEAN       DEFAULT TRUE,
  created_at        TIMESTAMPTZ   DEFAULT NOW()
);

-- subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
  id                  SERIAL PRIMARY KEY,
  user_id             INT           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id             INT           NOT NULL REFERENCES plans(id),
  razorpay_sub_id     VARCHAR(100)  UNIQUE NOT NULL,
  status              VARCHAR(30)   NOT NULL DEFAULT 'created',
  current_start       TIMESTAMPTZ,
  current_end         TIMESTAMPTZ,
  total_count         INT,
  paid_count          INT           DEFAULT 0,
  created_at          TIMESTAMPTZ   DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   DEFAULT NOW()
);

-- payments
CREATE TABLE IF NOT EXISTS payments (
  id                    SERIAL PRIMARY KEY,
  user_id               INT           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id       INT           REFERENCES subscriptions(id),
  razorpay_order_id     VARCHAR(100),
  razorpay_payment_id   VARCHAR(100)  UNIQUE,
  amount                INT           NOT NULL,
  currency              VARCHAR(3)    DEFAULT 'USD',
  status                VARCHAR(30)   NOT NULL DEFAULT 'created',
  method                VARCHAR(30),
  description           TEXT,
  created_at            TIMESTAMPTZ   DEFAULT NOW()
);
