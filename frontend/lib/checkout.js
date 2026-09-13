'use client';

import { post } from './api';

/**
 * Razorpay Checkout, loaded when it is needed and not before.
 *
 * The script is ~100KB and every visitor to the billing page would otherwise
 * pay for it whether or not they intend to buy anything. Loaded on the click,
 * cached by the browser after the first.
 */
const SRC = 'https://checkout.razorpay.com/v1/checkout.js';

let loading = null;

function loadCheckout() {
  if (typeof window === 'undefined') return Promise.reject(new Error('not in a browser'));
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (loading) return loading;

  loading = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = SRC;
    el.async = true;
    el.onload = () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error('Checkout loaded but did not register')));
    el.onerror = () => {
      loading = null;   // let a later click try again — this is often just a flaky network
      reject(new Error('Could not reach the payment provider. Check your connection and try again.'));
    };
    document.head.appendChild(el);
  });
  return loading;
}

/**
 * Buy a pack of credits.
 *
 * Three steps, and the middle one is the browser's: the server creates an order,
 * Razorpay collects the money, and the SERVER verifies the signature before a
 * single credit is issued. The handler below does not credit anything — it
 * reports what happened and asks the server to check.
 *
 * `resolve` fires only after that verification returns. A caller that refreshed
 * its balance on the handler alone would be trusting the browser, which is the
 * one participant with a motive.
 */
export async function buyCredits({ slug = 'topup-500', user, onDismiss } = {}) {
  const Razorpay = await loadCheckout();
  const order = await post('/billing/topup', { slug });

  return new Promise((resolve, reject) => {
    const rz = new Razorpay({
      key: order.razorpay_key_id,
      order_id: order.order_id,
      amount: order.amount,
      currency: order.currency,
      name: 'Rstudio',
      description: `${order.pack.credits} credits`,
      prefill: { email: user?.email || '', contact: user?.phone_number || '' },
      theme: { color: '#5B3DF5' },
      handler: async (rsp) => {
        try {
          resolve(await post('/billing/verify', {
            razorpay_order_id:   rsp.razorpay_order_id,
            razorpay_payment_id: rsp.razorpay_payment_id,
            razorpay_signature:  rsp.razorpay_signature,
          }));
        } catch (err) {
          // The money may well have been taken — the webhook is the backstop
          // and will credit it. Say that rather than implying it was lost.
          reject(new Error(
            'Payment went through but we could not confirm it here. '
            + 'Your credits will appear shortly; refresh in a minute.'
          ));
        }
      },
      modal: {
        ondismiss: () => {
          onDismiss?.();
          reject(Object.assign(new Error('Payment cancelled'), { cancelled: true }));
        },
      },
    });

    rz.on('payment.failed', (e) => {
      reject(new Error(e?.error?.description || 'The payment did not go through.'));
    });
    rz.open();
  });
}

/**
 * Subscribe to a plan.
 *
 * Ends at Razorpay's own confirmation rather than ours: a subscription is
 * activated by the webhook when the first charge is captured, which can be after
 * the browser has closed. Claiming the plan is live the moment the modal shuts
 * would show someone a plan they do not yet have.
 */
export async function subscribeToPlan({ slug, user } = {}) {
  const Razorpay = await loadCheckout();
  const out = await post('/billing/subscribe', { slug });

  return new Promise((resolve, reject) => {
    const rz = new Razorpay({
      key: out.razorpay_key_id,
      subscription_id: out.subscription_id,
      name: 'Rstudio',
      description: `${out.plan.name} — monthly`,
      prefill: { email: user?.email || '', contact: user?.phone_number || '' },
      theme: { color: '#5B3DF5' },
      handler: (rsp) => resolve({ pending: true, payment_id: rsp.razorpay_payment_id }),
      modal: {
        ondismiss: () => reject(Object.assign(new Error('Checkout cancelled'), { cancelled: true })),
      },
    });
    rz.on('payment.failed', (e) => {
      reject(new Error(e?.error?.description || 'The payment did not go through.'));
    });
    rz.open();
  });
}
