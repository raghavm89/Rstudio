'use strict';

/**
 * GST invoices.
 *
 * ── The seller's own details are configuration, not code ────────────────────
 * An invoice with the wrong GSTIN on it is worse than no invoice — the buyer
 * cannot claim credit against it and it has to be cancelled and reissued. So
 * these come from the environment and there are no defaults: if they are unset
 * the invoice is issued as a bill of supply with no tax, which is the correct
 * document for a supplier who is not registered.
 */
const SELLER = {
  name:    process.env.SELLER_LEGAL_NAME || 'Rstudio LLP',
  gstin:   process.env.SELLER_GSTIN || null,
  state:   process.env.SELLER_STATE || null,
  address: process.env.SELLER_ADDRESS || null,
};

/** 18% on SaaS. Configurable because rates change and invoices must not. */
const TAX_RATE = Number(process.env.GST_RATE || 18);

const isRegistered = () => Boolean(SELLER.gstin && SELLER.state);

/**
 * Split a taxable amount into CGST+SGST or IGST.
 *
 * The rule is the one thing about GST that is easy to get wrong and expensive to
 * get wrong: supply within the seller's own state is CGST plus SGST at half the
 * rate each; supply to another state is IGST at the full rate. Getting it
 * backwards means filing under the wrong head and refunding a customer who was
 * charged the wrong tax.
 *
 * Prices are GST-EXCLUSIVE, so tax is added to the amount rather than extracted
 * from it. Everything is paise; splitting rupees with floats is how a ledger
 * ends up three paise out with no way to find the culprit.
 */
function taxFor(subtotalPaise, buyerState, buyerCountry = 'IN') {
  const zero = { cgst: 0, sgst: 0, igst: 0, rate: 0, place_of_supply: buyerState || null };

  // Not registered: a bill of supply carries no tax.
  if (!isRegistered()) return zero;
  // Export of services is zero-rated, and getting that wrong charges a foreign
  // customer Indian tax they can never reclaim.
  if ((buyerCountry || 'IN').toUpperCase() !== 'IN') {
    return { ...zero, place_of_supply: 'Export' };
  }

  const total = Math.round(Number(subtotalPaise) * (TAX_RATE / 100));
  const sameState = buyerState
    && buyerState.trim().toLowerCase() === String(SELLER.state).trim().toLowerCase();

  if (sameState) {
    // Halve, then give the remainder to CGST so the two always sum to `total`.
    // Rounding each half independently loses a paisa on odd amounts, and an
    // invoice whose parts do not add up is one a buyer's accountant queries.
    const half = Math.floor(total / 2);
    return {
      cgst: total - half,
      sgst: half,
      igst: 0,
      rate: TAX_RATE,
      place_of_supply: buyerState,
    };
  }

  return { cgst: 0, sgst: 0, igst: total, rate: TAX_RATE, place_of_supply: buyerState || 'Unspecified' };
}

/**
 * Take the next invoice number.
 *
 * A locked counter row rather than a sequence. GST expects a consecutive series,
 * and a sequence hands out numbers that are gone forever if the transaction
 * rolls back — leaving a hole nobody can explain to an auditor. `FOR UPDATE`
 * serialises allocation, so a rollback puts the number back.
 *
 * Must be called inside the same transaction that inserts the invoice.
 */
async function nextNumber(client, prefix = 'RD') {
  const { rows } = await client.query(
    'SELECT next_value FROM studio_invoice_series WHERE prefix = $1 FOR UPDATE',
    [prefix]
  );
  if (!rows[0]) throw new Error(`No invoice series "${prefix}"`);

  const n = Number(rows[0].next_value);
  await client.query(
    'UPDATE studio_invoice_series SET next_value = next_value + 1 WHERE prefix = $1',
    [prefix]
  );

  const fy = financialYear(new Date());
  return `${prefix}/${fy}/${String(n).padStart(5, '0')}`;
}

/**
 * Indian financial year, as invoice numbers are conventionally stamped.
 * April to March — so January 2027 belongs to 2026-27, not 2027-28.
 */
function financialYear(date) {
  const y = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/**
 * Issue an invoice for a payment.
 *
 * Buyer details are copied in, not referenced. An invoice states what was true
 * when it was issued; joining to `users` would silently rewrite every past
 * invoice the moment someone corrects their address.
 *
 * Returns the existing invoice if this payment already has one — the webhook
 * and the client-side verification both report success, and two invoices for one
 * payment is a worse problem than none.
 */
async function issueForPayment(client, { payment, user, description }) {
  const existing = await client.query('SELECT * FROM studio_invoices WHERE payment_id = $1', [payment.id]);
  if (existing.rows[0]) return existing.rows[0];

  const subtotal = Number(payment.amount);
  const tax = taxFor(subtotal, user.billing_state, user.billing_country);
  const total = subtotal + tax.cgst + tax.sgst + tax.igst;

  const number = await nextNumber(client);

  const address = [user.billing_line1, user.billing_line2, user.billing_city,
                   user.billing_state, user.billing_pin]
    .filter(Boolean).join(', ') || null;

  const { rows } = await client.query(
    `INSERT INTO studio_invoices
       (number, tenant_id, user_id, payment_id, payment_ref, payment_method, description,
        subtotal, cgst, sgst, igst, total, currency, tax_rate,
        buyer_name, buyer_gstin, buyer_address, buyer_state, buyer_country, place_of_supply)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     RETURNING *`,
    [number, user.tenant_id, user.id, payment.id,
     // The gateway's id, copied in rather than joined. `payment_id` is ON DELETE
     // SET NULL, and an invoice that has lost the only reference to its payment
     // cannot be reconciled against a bank statement by anybody.
     payment.razorpay_payment_id || payment.razorpay_order_id || null,
     payment.method || null,
     description,
     subtotal, tax.cgst, tax.sgst, tax.igst, total, payment.currency || 'INR', tax.rate,
     user.billing_name || user.name, user.gstin || null, address,
     user.billing_state || null, (user.billing_country || 'IN'), tax.place_of_supply]
  );
  return rows[0];
}

/** Rupees for display. Storage stays in paise. */
const rupees = (paise) => Number(paise) / 100;

function present(row) {
  return {
    id:       row.id,
    number:   row.number,
    // What the customer quotes back when they ask about a charge, and what
    // reconciles this row against Razorpay and the bank.
    payment_ref:    row.payment_ref || null,
    payment_method: row.payment_method || null,
    issued_at: row.issued_at,
    description: row.description,
    subtotal: rupees(row.subtotal),
    cgst:     rupees(row.cgst),
    sgst:     rupees(row.sgst),
    igst:     rupees(row.igst),
    total:    rupees(row.total),
    currency: row.currency,
    tax_rate: Number(row.tax_rate),
    buyer: {
      name:    row.buyer_name,
      gstin:   row.buyer_gstin,
      address: row.buyer_address,
      state:   row.buyer_state,
      country: row.buyer_country,
    },
    place_of_supply: row.place_of_supply,
    seller: SELLER,
    // So the page can say "bill of supply" rather than showing empty tax rows.
    taxed: Number(row.cgst) + Number(row.sgst) + Number(row.igst) > 0,
  };
}

module.exports = { SELLER, TAX_RATE, isRegistered, taxFor, nextNumber, financialYear, issueForPayment, present };
