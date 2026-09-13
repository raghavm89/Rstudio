// Validates required environment variables once, at startup, so the process
// fails fast instead of crashing on the first relevant request.

// When DATABASE_URL is set (Railway, etc.) individual DB vars are not needed.
const DB_VARS = process.env.DATABASE_URL
  ? []
  : ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];

/**
 * Twilio used to be optional, and this file used to say phone OTP would be
 * "skipped gracefully" without it. That stopped being true when phone became
 * mandatory at sign-up and SMS-verified before the account exists: with no SMS
 * there is no way to finish a registration, so the only route into the product
 * is closed while the server reports itself healthy.
 *
 * Promoted to required, which is this file's whole stated purpose — fail at
 * startup rather than on the first relevant request. To run without SMS you have
 * to make sign-up not need it, not merely leave the keys out.
 */
const TWILIO_VARS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'];

const REQUIRED = [
  ...DB_VARS,
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  ...TWILIO_VARS,
];


function validateEnv() {
  const missing = REQUIRED.filter((k) => !process.env[k] || process.env[k].trim() === '');
  if (missing.length) {
    console.error('Missing required environment variables:');
    for (const key of missing) console.error(`  - ${key}`);
    console.error('\nSee .env.example for the full list.');
    process.exit(1);
  }

  // Reject the obviously-insecure default secrets from .env.example
  const placeholders = ['your_access_token_secret', 'your_refresh_token_secret', 'your_razorpay_key_secret', 'your_razorpay_webhook_secret', 'your_twilio_auth_token', 'your_password'];
  for (const key of REQUIRED) {
    if (placeholders.includes(process.env[key])) {
      console.error(`Refusing to start: ${key} still set to a placeholder value.`);
      process.exit(1);
    }
  }

  // A bare number typed with no country code is read as this country. It has a
  // default, so it is not required — but an unrecognisable value would be
  // discovered as "that is not a valid phone number" on a real sign-up, which
  // points at the user's input rather than at this line.
  const country = (process.env.DEFAULT_PHONE_COUNTRY || 'IN').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) {
    console.error(`Refusing to start: DEFAULT_PHONE_COUNTRY must be a 2-letter ISO country code (e.g. IN), got "${process.env.DEFAULT_PHONE_COUNTRY}".`);
    process.exit(1);
  }
}

module.exports = validateEnv;
