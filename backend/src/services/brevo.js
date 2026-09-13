'use strict';

/**
 * Brevo Transactional Email service
 * Uses Brevo's v3 REST API (no extra package required — uses global fetch / node 18+).
 *
 * Required env vars:
 *   BREVO_API_KEY       — Brevo API key (Settings → API Keys)
 *   BREVO_FROM_EMAIL    — verified sender address in Brevo (e.g. noreply@rach.dev)
 *   BREVO_FROM_NAME     — sender display name (e.g. Rach Dev LLP)
 *   APP_URL             — public frontend URL (e.g. https://app.rach.dev)
 */

const API_URL    = 'https://api.brevo.com/v3/smtp/email';
const API_KEY    = process.env.BREVO_API_KEY;
const FROM_EMAIL = process.env.BREVO_FROM_EMAIL || 'noreply@rach.dev';
const FROM_NAME  = process.env.BREVO_FROM_NAME  || 'Rach Dev LLP';
const { siteUrl } = require('../utils/siteUrl');
// Absolute or the link is dead: most mail clients will not linkify a
// scheme-less URL, and the ones that do treat it as relative to nothing.
const APP_URL    = siteUrl(process.env.APP_URL, 'http://localhost:3001');

// ── Core send ─────────────────────────────────────────────────────────────────

/**
 * Low-level send.
 * @param {{ to: {email:string,name?:string}[], subject: string, htmlContent: string, textContent?: string }} opts
 */
async function sendEmail({ to, subject, htmlContent, textContent }) {
  if (!API_KEY) {
    console.warn('[brevo] BREVO_API_KEY not set — email skipped (logged below)');
    console.warn(`  To: ${to.map(r => r.email).join(', ')}  |  Subject: ${subject}`);
    return false;
  }

  const body = {
    sender      : { name: FROM_NAME, email: FROM_EMAIL },
    to,
    subject,
    htmlContent,
    textContent,
    // Disable tracking pixels — they trigger spam filters and have no alt attribute
    trackOpens  : false,
    trackClicks : false,
  };

  try {
    const res = await fetch(API_URL, {
      method : 'POST',
      headers: { 'api-key': API_KEY, 'Content-Type': 'application/json' },
      body   : JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[brevo] send failed:', res.status, err);
      return false;
    }

    console.log(`[brevo] sent "${subject}" → ${to}`);
    return true;
  } catch (err) {
    console.error('[brevo] network error:', err.message);
    return false;
  }
}

// ── Email templates ───────────────────────────────────────────────────────────

/**
 * Sends a 6-digit OTP to a newly registered user for email verification.
 * @param {{ toEmail: string, toName: string, otp: string }} opts
 */
async function sendVerificationOtp({ toEmail, toName, otp }) {
  const digits = otp.split('');

  const digitCells = digits.map(d => `
    <td style="padding:0 4px;">
      <div style="width:44px;height:56px;border-radius:10px;
                  background:linear-gradient(135deg,#eff6ff,#f5f3ff);
                  border:2px solid #e0e7ff;
                  font-size:28px;font-weight:800;color:#1e40af;
                  text-align:center;line-height:56px;
                  font-family:ui-monospace,SFMono-Regular,monospace;">
        ${d}
      </div>
    </td>`).join('');

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:40px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0"
             style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06);">

        <!-- Header gradient -->
        <tr>
          <td style="background:linear-gradient(135deg,#2563eb,#7c3aed);padding:32px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:-.5px;">
              Rach Dev LLP
            </h1>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:40px 40px 32px;">
            <h2 style="margin:0 0 12px;color:#111827;font-size:20px;font-weight:700;">
              Verify your email address
            </h2>
            <p style="margin:0 0 8px;color:#4b5563;font-size:15px;line-height:1.6;">
              Hi ${toName},
            </p>
            <p style="margin:0 0 28px;color:#4b5563;font-size:15px;line-height:1.6;">
              Thanks for signing up! Enter the code below to activate your account.
            </p>

            <!-- OTP digit boxes -->
            <table cellpadding="0" cellspacing="0" width="100%">
              <tr><td align="center" style="padding-bottom:24px;">
                <table cellpadding="0" cellspacing="0"><tr>${digitCells}</tr></table>
              </td></tr>
            </table>

            <p style="margin:0 0 4px;color:#9ca3af;font-size:13px;line-height:1.5;text-align:center;">
              This code expires in <strong>10 minutes</strong>.
            </p>
            <p style="margin:0;color:#9ca3af;font-size:13px;line-height:1.5;text-align:center;">
              If you didn't create an account, you can safely ignore this email.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 40px;text-align:center;">
            <p style="margin:0;color:#9ca3af;font-size:12px;">
              © ${new Date().getFullYear()} Rach Dev LLP · All rights reserved
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const textContent =
    `Hi ${toName},\n\n` +
    `Thanks for signing up with Rach Dev LLP!\n\n` +
    `Your email verification code is:\n\n  ${otp}\n\n` +
    `This code expires in 10 minutes.\n\n` +
    `If you didn't create an account, ignore this email.\n\n` +
    `— Rach Dev LLP Team`;

  return sendEmail({
    to: [{ email: toEmail, name: toName }],
    subject: `${otp} is your Rach Dev LLP verification code`,
    htmlContent,
    textContent,
  });
}

// ── Alert email ───────────────────────────────────────────────────────────────

/**
 * Sends a VM resource alert email to one or more recipients.
 * @param {{ recipients: string[], subject: string, htmlContent: string }} opts
 * recipients — plain email address strings (names are omitted for alert emails)
 */
async function sendAlertEmail({ recipients, subject, htmlContent }) {
  if (!recipients.length) return false;
  return sendEmail({
    to: recipients.map(email => ({ email })),
    subject,
    htmlContent,
  });
}

/**
 * Sends a password reset link to the user.
 * @param {{ toEmail: string, toName: string, resetUrl: string }} opts
 */
async function sendPasswordResetEmail({ toEmail, toName, resetUrl }) {
  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:40px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0"
             style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06);">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#2563eb,#7c3aed);padding:32px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;letter-spacing:-.5px;">
              Rach Dev LLP
            </h1>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:40px 40px 32px;">
            <h2 style="margin:0 0 12px;color:#111827;font-size:20px;font-weight:700;">
              Reset your password
            </h2>
            <p style="margin:0 0 8px;color:#4b5563;font-size:15px;line-height:1.6;">Hi ${toName},</p>
            <p style="margin:0 0 28px;color:#4b5563;font-size:15px;line-height:1.6;">
              We received a request to reset your password. Click the button below to choose a new one.
              This link expires in <strong>30 minutes</strong>.
            </p>

            <!-- CTA button -->
            <table cellpadding="0" cellspacing="0" width="100%">
              <tr><td align="center" style="padding-bottom:28px;">
                <a href="${resetUrl}"
                   style="display:inline-block;padding:14px 32px;border-radius:10px;
                          background:linear-gradient(135deg,#2563eb,#7c3aed);
                          color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;
                          letter-spacing:-.2px;">
                  Reset Password
                </a>
              </td></tr>
            </table>

            <p style="margin:0 0 4px;color:#9ca3af;font-size:13px;line-height:1.5;text-align:center;">
              Or copy this link into your browser:
            </p>
            <p style="margin:0;color:#6b7280;font-size:12px;line-height:1.5;text-align:center;word-break:break-all;">
              ${resetUrl}
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 40px;text-align:center;">
            <p style="margin:0 0 4px;color:#9ca3af;font-size:12px;">
              If you didn't request a password reset, you can safely ignore this email.
            </p>
            <p style="margin:0;color:#9ca3af;font-size:12px;">
              © ${new Date().getFullYear()} Rach Dev LLP · All rights reserved
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const textContent =
    `Hi ${toName},\n\n` +
    `We received a request to reset your Rach Dev LLP password.\n\n` +
    `Reset your password here:\n${resetUrl}\n\n` +
    `This link expires in 30 minutes.\n\n` +
    `If you didn't request this, you can safely ignore this email.\n\n` +
    `— Rach Dev LLP Team`;

  return sendEmail({
    to: [{ email: toEmail, name: toName }],
    subject: 'Reset your Rach Dev LLP password',
    htmlContent,
    textContent,
  });
}


/**
 * Sends a contact form submission to sales@rstudio.app.
 * @param {{ firstName: string, lastName: string, email: string, company?: string, subject: string, message: string }} opts
 */
async function sendContactEmail({ firstName, lastName, email, company, subject, message }) {
  const subjectLabels = {
    general: 'General Inquiry',
    pricing: 'Pricing Question',
    migration: 'Migration Help',
    'custom-development': 'Custom Development',
    partnership: 'Partnership',
  };
  const subjectLabel = subjectLabels[subject] || subject;

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:40px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0"
             style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06);">

        <tr>
          <td style="background:linear-gradient(135deg,#2563eb,#7c3aed);padding:28px 32px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">New Contact Form Submission</h1>
          </td>
        </tr>

        <tr>
          <td style="padding:32px 40px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              ${[
                ['Name',    `${firstName} ${lastName}`],
                ['Email',   `<a href="mailto:${email}" style="color:#2563eb;">${email}</a>`],
                ['Company', company || '—'],
                ['Subject', subjectLabel],
              ].map(([label, value]) => `
              <tr>
                <td style="padding:8px 0;border-bottom:1px solid #f3f4f6;width:100px;">
                  <span style="font-size:13px;font-weight:600;color:#6b7280;">${label}</span>
                </td>
                <td style="padding:8px 0 8px 16px;border-bottom:1px solid #f3f4f6;">
                  <span style="font-size:14px;color:#111827;">${value}</span>
                </td>
              </tr>`).join('')}
            </table>

            <div style="margin-top:24px;">
              <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#6b7280;">MESSAGE</p>
              <div style="background:#f9fafb;border-radius:10px;padding:16px;font-size:14px;color:#374151;line-height:1.7;white-space:pre-wrap;">${message}</div>
            </div>

            <div style="margin-top:24px;">
              <a href="mailto:${email}?subject=Re: ${subjectLabel}"
                 style="display:inline-block;padding:12px 28px;border-radius:10px;
                        background:linear-gradient(135deg,#2563eb,#7c3aed);
                        color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">
                Reply to ${firstName}
              </a>
            </div>
          </td>
        </tr>

        <tr>
          <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 40px;text-align:center;">
            <p style="margin:0;color:#9ca3af;font-size:12px;">
              © ${new Date().getFullYear()} Rach Dev LLP · Sent from rstudio.app contact form
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const textContent =
    `New contact form submission\n\n` +
    `Name: ${firstName} ${lastName}\n` +
    `Email: ${email}\n` +
    `Company: ${company || '—'}\n` +
    `Subject: ${subjectLabel}\n\n` +
    `Message:\n${message}`;

  return sendEmail({
    to: [{ email: 'sales@rstudio.app', name: 'Rach Dev Sales' }],
    subject: `[Contact] ${subjectLabel} — ${firstName} ${lastName}`,
    htmlContent,
    textContent,
  });
}

/**
 * Sends a subscription invoice email to the customer and to raghav@rstudio.app.
 * @param {{ orderId, customerName, customerEmail, description, items, amountPaid, currency, subscriptionId, requestedAt }} opts
 */
async function sendInvoiceEmail({ orderId, customerName, customerEmail, description, items, amountPaid, currency, subscriptionId, requestedAt }) {
  const fmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', minimumFractionDigits: 2 });
  const amountDisplay = fmt.format((amountPaid || 0) / 100);
  const dateDisplay   = new Date(requestedAt || Date.now()).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  const itemRows = Array.isArray(items) && items.length
    ? items.map(item => `
        <tr>
          <td style="padding:10px 16px;border-bottom:1px solid #f3f4f6;font-size:14px;color:#374151;">
            ${item.name || item.id}${item.qty > 1 ? ` × ${item.qty}` : ''}
          </td>
          <td style="padding:10px 16px;border-bottom:1px solid #f3f4f6;font-size:14px;color:#374151;text-align:right;font-family:monospace;">
            ${amountDisplay}
          </td>
        </tr>`).join('')
    : `<tr><td colspan="2" style="padding:10px 16px;font-size:14px;color:#374151;">${description}</td></tr>`;

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:40px 16px;">
    <tr><td align="center">
      <table width="580" cellpadding="0" cellspacing="0"
             style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06);">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#2563eb,#7c3aed);padding:32px 40px;">
            <table width="100%"><tr>
              <td>
                <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-.5px;">Rach Dev LLP</h1>
                <p style="margin:4px 0 0;color:rgba(255,255,255,.75);font-size:13px;">Tax Invoice / Receipt</p>
              </td>
              <td style="text-align:right;">
                <p style="margin:0;color:rgba(255,255,255,.85);font-size:13px;">Invoice #${orderId}</p>
                <p style="margin:4px 0 0;color:rgba(255,255,255,.75);font-size:12px;">${dateDisplay}</p>
              </td>
            </tr></table>
          </td>
        </tr>

        <!-- Bill to -->
        <tr>
          <td style="padding:28px 40px 0;">
            <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.6px;">Billed To</p>
            <p style="margin:0;font-size:15px;font-weight:600;color:#111827;">${customerName}</p>
            <p style="margin:2px 0 0;font-size:13px;color:#6b7280;">${customerEmail}</p>
          </td>
        </tr>

        <!-- Items table -->
        <tr>
          <td style="padding:24px 40px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
              <thead>
                <tr style="background:#f9fafb;">
                  <th style="padding:10px 16px;font-size:11px;font-weight:700;color:#6b7280;text-align:left;text-transform:uppercase;letter-spacing:.5px;">Description</th>
                  <th style="padding:10px 16px;font-size:11px;font-weight:700;color:#6b7280;text-align:right;text-transform:uppercase;letter-spacing:.5px;">Amount</th>
                </tr>
              </thead>
              <tbody>${itemRows}</tbody>
              <tfoot>
                <tr style="background:#f9fafb;border-top:2px solid #e5e7eb;">
                  <td style="padding:12px 16px;font-size:14px;font-weight:700;color:#111827;">Total (Monthly)</td>
                  <td style="padding:12px 16px;font-size:16px;font-weight:800;color:#2563eb;text-align:right;font-family:monospace;">${amountDisplay}/mo</td>
                </tr>
              </tfoot>
            </table>
          </td>
        </tr>

        <!-- Subscription info -->
        <tr>
          <td style="padding:20px 40px 0;">
            <div style="background:#eff6ff;border-radius:10px;padding:14px 16px;border:1px solid #dbeafe;">
              <p style="margin:0;font-size:13px;color:#1e40af;">
                <strong>Subscription active</strong> — auto-renews monthly. Cancel anytime from your Orders page.
              </p>
              ${subscriptionId ? `<p style="margin:6px 0 0;font-size:11px;color:#6b7280;font-family:monospace;">Subscription ID: ${subscriptionId}</p>` : ''}
            </div>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 40px;margin-top:28px;text-align:center;">
            <p style="margin:0 0 4px;color:#9ca3af;font-size:12px;">
              Questions? Reply to this email or contact <a href="mailto:support@rstudio.app" style="color:#2563eb;">support@rstudio.app</a>
            </p>
            <p style="margin:0;color:#9ca3af;font-size:12px;">
              © ${new Date().getFullYear()} Rach Dev LLP · All rights reserved
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const textContent =
    `Invoice #${orderId} — Rach Dev LLP\n` +
    `Date: ${dateDisplay}\n\n` +
    `Billed to: ${customerName} (${customerEmail})\n\n` +
    `${description}\n` +
    `Total: ${amountDisplay}/mo\n\n` +
    (subscriptionId ? `Subscription ID: ${subscriptionId}\n\n` : '') +
    `Your subscription is active and will auto-renew monthly.\n` +
    `Questions? Contact support@rstudio.app\n\n` +
    `— Rach Dev LLP Team`;

  return sendEmail({
    to: [
      { email: customerEmail, name: customerName },
      { email: 'raghav@rstudio.app', name: 'Raghav — Rach Dev' },
    ],
    subject: `Invoice #${orderId} — ${description} · ${amountDisplay}/mo`,
    htmlContent,
    textContent,
  });
}

module.exports = { sendVerificationOtp, sendAlertEmail, sendPasswordResetEmail, sendContactEmail, sendInvoiceEmail };
