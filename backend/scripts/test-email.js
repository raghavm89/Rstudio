'use strict';

require('dotenv').config();
const { sendVerificationOtp } = require('../src/services/brevo');

async function main() {
  const to   = process.argv[2] || 'test-5r7the5mh@srv1.mail-tester.com';
  const otp  = '123456';

  console.log(`Sending test OTP email to: ${to}`);
  console.log(`Using BREVO_API_KEY: ${(process.env.BREVO_API_KEY || '').slice(0, 16)}...`);
  console.log(`From: ${process.env.BREVO_FROM_EMAIL}`);

  const ok = await sendVerificationOtp({ toEmail: to, toName: 'Mail Tester', otp });
  console.log(ok ? '✅ Email sent successfully' : '❌ Send returned false');
}

main().catch((err) => { console.error('Error:', err.message); process.exit(1); });
