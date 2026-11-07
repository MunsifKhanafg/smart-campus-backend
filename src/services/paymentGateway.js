import crypto from 'crypto';
import { ApiError } from '../utils/apiHelpers.js';

// Gateway adapter. PAYMENT_PROVIDER=stripe uses Stripe Checkout (hosted page: card details never touch our server).
// PAYMENT_PROVIDER=mock (default, development only) simulates a gateway so the whole flow can be demonstrated offline.
export const providerName = () => (process.env.PAYMENT_PROVIDER || 'mock').toLowerCase();

const STRIPE = 'https://api.stripe.com/v1';

const stripeCall = async (method, path, form) => {
  if (!process.env.STRIPE_SECRET_KEY) throw ApiError.badRequest('Online payment is not configured on the server');
  const res = await fetch(`${STRIPE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new ApiError(502, `Payment gateway error: ${json.error?.message || res.status}`);
  return json;
};

const clientUrl = () => (process.env.CLIENT_URL || 'http://localhost:5173').split(',')[0].trim();

// Starts a checkout. Returns where to send the student and the gateway's id for this checkout.
export const createCheckout = async ({ payment, studentEmail }) => {
  if (providerName() === 'mock') {
    if (process.env.NODE_ENV === 'production') throw ApiError.badRequest('The mock payment provider is disabled in production');
    return { provider: 'mock', gatewayRef: `mock_${crypto.randomBytes(8).toString('hex')}`, checkoutUrl: `${clientUrl()}/pay/mock/${payment._id}` };
  }
  const session = await stripeCall('POST', '/checkout/sessions', {
    mode: 'payment',
    success_url: `${clientUrl()}/pay/return?payment=${payment._id}`,
    cancel_url: `${clientUrl()}/fees`,
    client_reference_id: String(payment._id),
    customer_email: studentEmail,
    'metadata[paymentId]': String(payment._id),
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': payment.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(Math.round(payment.totalAmount * 100)),
    'line_items[0][price_data][product_data][name]': 'University fee payment',
  });
  return { provider: 'stripe', gatewayRef: session.id, checkoutUrl: session.url };
};

// Server-to-server confirmation: asks the gateway itself whether this checkout was really paid.
export const retrieveCheckout = async (payment) => {
  if (payment.provider !== 'stripe') return null;
  const s = await stripeCall('GET', `/checkout/sessions/${payment.gatewayRef}`);
  return {
    paid: s.payment_status === 'paid',
    amount: s.amount_total / 100,
    currency: String(s.currency || '').toUpperCase(),
    paymentIntent: s.payment_intent,
    paymentId: s.metadata?.paymentId || s.client_reference_id,
  };
};

// Stripe signs every webhook: header "t=<time>,v1=<hmac>" where hmac = HMAC_SHA256(secret, "<t>.<raw body>").
// Anyone can POST to our webhook URL, so unsigned or wrongly signed calls are rejected. (pure, unit tested)
export const verifyStripeSignature = (rawBody, header, secret, toleranceSeconds = 300, nowMs = Date.now()) => {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i), kv.slice(i + 1)];
    })
  );
  const t = Number(parts.t);
  if (!t || !parts.v1) return false;
  if (Math.abs(nowMs / 1000 - t) > toleranceSeconds) return false; // replay protection
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export const refundPayment = async (payment) => {
  if (payment.provider === 'stripe' && payment.gatewayPaymentId) {
    const r = await stripeCall('POST', '/refunds', { payment_intent: payment.gatewayPaymentId });
    return r.id;
  }
  return payment.provider === 'mock' ? `mock_refund_${crypto.randomBytes(4).toString('hex')}` : null; // manual: refunded in cash by the office
};
