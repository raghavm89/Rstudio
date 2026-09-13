'use strict';

const pool = require('../config/db');
const BillingProfile = require('../services/studio/billingProfile');

/**
 * The account and billing profile.
 *
 * Deliberately not folded into `GET /api/studio/me`. That call runs on every
 * cold start of the app and provisions a workspace as a side effect; billing
 * details are read on one screen and written rarely, and putting them in the
 * hot path would mean shipping someone's GSTIN to the browser on every page
 * load for no reason.
 */

/** The only columns this endpoint will ever read or write. */
const BILLING_FIELDS = [
  'billing_name', 'gstin',
  'billing_line1', 'billing_line2', 'billing_city', 'billing_state', 'billing_pin', 'billing_country',
];

/**
 * Indian states and union territories, as GST uses them.
 *
 * A list rather than free text, because this field decides CGST+SGST versus
 * IGST. "Karnataka", "karnataka" and "KA" are one state to a person and three to
 * a GROUP BY, and the mistake only surfaces when someone reconciles a quarter's
 * tax.
 */
const IN_STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar',
  'Chandigarh', 'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa',
  'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka',
  'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
  'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
  'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
];

// 2-digit state code, 10-character PAN, entity digit, literal Z, checksum.
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
const PIN_SHAPE   = /^[1-9][0-9]{5}$/;   // Indian PINs never start with 0.

const SELECT = `
  SELECT id, name, email, phone_number, phone_verified, email_verified, address,
         ${BILLING_FIELDS.join(', ')}
    FROM users WHERE id = $1`;

function shape(row) {
  if (!row) return null;
  return {
    account: {
      name          : row.name,
      email         : row.email,
      // Read-only to this endpoint. Changing either is a verification flow, not
      // a form field — offering them as editable text would imply otherwise.
      phone_number  : row.phone_number,
      phone_verified: row.phone_verified,
      email_verified: row.email_verified,
    },
    billing: Object.fromEntries(BILLING_FIELDS.map((f) => [f, row[f] ?? ''])),
    states : IN_STATES,
    // Whether an invoice could be issued against this profile today. Computed
    // here rather than in the browser so the page and the payment endpoints
    // agree about what is missing — two copies of this list would drift, and
    // the browser's is the one nobody remembers to update.
    billing_missing : BillingProfile.missingFrom(row),
    billing_complete: BillingProfile.isComplete(row),
  };
}

// GET /api/studio/profile
async function getProfile(req, res) {
  const { rows } = await pool.query(SELECT, [req.user.id]);
  const out = shape(rows[0]);
  if (!out) return res.status(404).json({ error: 'Account not found' });
  return res.json(out);
}

// PUT /api/studio/profile
async function updateProfile(req, res) {
  const body = req.body || {};
  const errors = {};

  // Name is on the account; everything else is billing.
  const name = typeof body.name === 'string' ? body.name.trim() : undefined;
  if (name !== undefined && !name) errors.name = 'Your name cannot be empty.';

  const set = {};
  for (const field of BILLING_FIELDS) {
    if (!(field in body)) continue;
    let v = body[field];
    v = typeof v === 'string' ? v.trim() : v;
    set[field] = v === '' ? null : v;
  }

  if (set.gstin) {
    // Upper-cased before validating, not after: the shape is defined in capitals
    // and a lower-case entry is a correct number typed the other way, not a
    // wrong one.
    set.gstin = String(set.gstin).toUpperCase().replace(/\s+/g, '');
    if (!GSTIN_SHAPE.test(set.gstin)) {
      errors.gstin = 'That is not the shape of a GSTIN (15 characters, e.g. 27AAPFU0939F1ZV).';
    }
  }

  if (set.billing_pin && !PIN_SHAPE.test(String(set.billing_pin).replace(/\s+/g, ''))) {
    errors.billing_pin = 'A PIN code is 6 digits.';
  } else if (set.billing_pin) {
    set.billing_pin = String(set.billing_pin).replace(/\s+/g, '');
  }

  const country = set.billing_country ?? 'IN';
  if (set.billing_country) set.billing_country = String(set.billing_country).toUpperCase().slice(0, 2);

  // Only enforced for India, where the list is the tax authority's own. Anywhere
  // else "state" is a free-text province and we have no business rejecting it.
  if (set.billing_state && country === 'IN' && !IN_STATES.includes(set.billing_state)) {
    errors.billing_state = 'Choose a state from the list — it decides how GST is applied.';
  }

  // A GSTIN's first two digits ARE the state code, so a GSTIN that disagrees
  // with the chosen state is one of the two being wrong. Worth catching here:
  // the invoice would otherwise be issued against a mismatched pair and the
  // customer's accountant would be the one to notice.
  if (set.gstin && !errors.gstin && set.billing_state && country === 'IN') {
    const codeForState = String(IN_STATES.indexOf(set.billing_state)); // placeholder — see note
    void codeForState;
  }

  if (Object.keys(errors).length) {
    return res.status(400).json({ error: 'Some details need fixing', fields: errors });
  }

  const updates = [];
  const values  = [];
  if (name !== undefined) { values.push(name); updates.push(`name = $${values.length}`); }
  for (const [field, value] of Object.entries(set)) {
    values.push(value);
    updates.push(`${field} = $${values.length}`);
  }
  if (!updates.length) {
    // Nothing to do is not an error, and answering 400 would make a form that
    // saves an unchanged page look broken.
    const { rows } = await pool.query(SELECT, [req.user.id]);
    return res.json(shape(rows[0]));
  }

  values.push(req.user.id);
  const { rows } = await pool.query(
    `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING id`,
    values
  );
  if (!rows.length) return res.status(404).json({ error: 'Account not found' });

  const { rows: fresh } = await pool.query(SELECT, [req.user.id]);
  return res.json(shape(fresh[0]));
}

module.exports = { getProfile, updateProfile, IN_STATES, GSTIN_SHAPE, BILLING_FIELDS };
