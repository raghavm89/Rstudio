'use strict';

/**
 * What an invoice cannot be issued without.
 *
 * ── Why this gate exists, and why it is not a form nicety ────────────────────
 *
 * `invoices.taxFor` decides CGST+SGST versus IGST by comparing the buyer's
 * state to the seller's. With `billing_state` null and the country India it
 * falls through to the IGST branch and stamps the invoice
 * `place_of_supply: 'Unspecified'` — so a buyer in the seller's OWN state is
 * charged inter-state tax, and the amount is filed under the wrong head.
 *
 * That is not a cosmetic error. It is a wrong tax invoice, which cannot be
 * quietly edited afterwards: it has to be cancelled and reissued, and until it
 * is, the buyer cannot claim credit for tax they did pay. The cheapest place to
 * prevent it is before the money moves, which is here.
 *
 * A GST tax invoice must also carry the recipient's name and address (Rule 46),
 * and the place of supply. None of those can be recovered from a payment id
 * after the fact.
 *
 * ── One list, read by both sides ────────────────────────────────────────────
 * The profile endpoint reports what is missing so the page can say so before
 * anyone clicks; the payment endpoints refuse on the same list. Duplicating it
 * in the browser would mean two lists, and the browser's copy is the one nobody
 * updates.
 */

/**
 * Field → what to call it to a person.
 *
 * `indiaOnly: false` means the field is required everywhere. State and PIN are
 * asked for only in India: elsewhere the supply is an export, zero-rated, and
 * a province we cannot validate adds nothing to the invoice.
 */
const REQUIRED = [
  { field: 'billing_name',    label: 'Billed to',  indiaOnly: false },
  { field: 'billing_line1',   label: 'Address',    indiaOnly: false },
  { field: 'billing_city',    label: 'City',       indiaOnly: false },
  { field: 'billing_country', label: 'Country',    indiaOnly: false },
  { field: 'billing_state',   label: 'State',      indiaOnly: true  },
  { field: 'billing_pin',     label: 'PIN code',   indiaOnly: true  },
];

const isIndia = (row) => String(row?.billing_country || 'IN').toUpperCase() === 'IN';

/** Present means a non-empty string once trimmed — '   ' is not an address. */
const filled = (v) => typeof v === 'string' ? v.trim() !== '' : v !== null && v !== undefined && v !== '';

/**
 * What is still missing, in the order the form asks for it.
 * Returns `[{ field, label }]` — empty when the profile is complete.
 */
function missingFrom(row) {
  const india = isIndia(row);
  return REQUIRED
    .filter((r) => (india || !r.indiaOnly) && !filled(row?.[r.field]))
    .map(({ field, label }) => ({ field, label }));
}

const isComplete = (row) => missingFrom(row).length === 0;

/** "State and PIN code", "Address, City and State" — for one readable sentence. */
function describe(missing) {
  const labels = missing.map((m) => m.label);
  if (labels.length <= 1) return labels[0] || '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * The refusal, shaped the way the billing page expects to read it.
 *
 * 409 rather than 400: the request is perfectly well formed. What is wrong is
 * the state of the account it was made against, and the fix is on another part
 * of the same page.
 */
function refusal(missing) {
  return {
    status: 409,
    body: {
      error: 'Add your billing address first',
      message: `A GST invoice needs your ${describe(missing)}. `
        + 'Fill in Billing address below and save it, then this will go through.',
      code: 'BILLING_ADDRESS_REQUIRED',
      missing: missing.map((m) => m.field),
    },
  };
}

module.exports = { REQUIRED, missingFrom, isComplete, describe, refusal };
