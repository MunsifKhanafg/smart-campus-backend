import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEnv } from '../src/config/validateEnv.js';
import { createAttemptGuard } from '../src/utils/attemptGuard.js';

const BASE = { MONGO_URI: 'mongodb://localhost/test', JWT_SECRET: 'x'.repeat(40) };
const PROD = { ...BASE, NODE_ENV: 'production', CLIENT_URL: 'https://campus.example.edu' };

// ---------- startup configuration check ----------
test('missing MONGO_URI or a short JWT_SECRET stops the server from starting', () => {
  const { errors } = checkEnv({});
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => e.includes('MONGO_URI')));
  assert.ok(errors.some((e) => e.includes('JWT_SECRET')));
  assert.equal(checkEnv({ ...BASE, JWT_SECRET: 'too-short' }).errors.length, 1);
});

test('a normal development setup starts, but warns that mock payments are on', () => {
  const { errors, warnings } = checkEnv(BASE);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Mock payments are ON/);
});

test('the placeholder JWT secret is only a warning in development but an error in production', () => {
  const placeholder = { JWT_SECRET: 'change_this_to_a_long_random_secret' };
  assert.deepEqual(checkEnv({ ...BASE, ...placeholder }).errors, []);
  assert.ok(checkEnv({ ...BASE, ...placeholder }).warnings.some((w) => w.includes('placeholder')));
  assert.equal(checkEnv({ ...PROD, ...placeholder, PAYMENT_PROVIDER: 'mock' }).errors.length, 1);
});

test('production with the stripe provider needs both Stripe keys', () => {
  const noKeys = checkEnv({ ...PROD, PAYMENT_PROVIDER: 'stripe' });
  assert.equal(noKeys.errors.length, 1);
  assert.match(noKeys.errors[0], /STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET/);

  const ok = checkEnv({ ...PROD, PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' });
  assert.deepEqual(ok, { errors: [], warnings: [] });
});

test('production with the mock provider starts (payments are refused) but warns', () => {
  const { errors, warnings } = checkEnv({ ...PROD, PAYMENT_PROVIDER: 'mock' });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /mock/);
});

test('production warns when CLIENT_URL is localhost or not https', () => {
  const stripe = { PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'k', STRIPE_WEBHOOK_SECRET: 'w' };
  assert.ok(checkEnv({ ...PROD, ...stripe, CLIENT_URL: 'http://localhost:5173' }).warnings.some((w) => w.includes('localhost')));
  assert.ok(checkEnv({ ...PROD, ...stripe, CLIENT_URL: 'http://campus.example.edu' }).warnings.some((w) => w.includes('https')));
});

// ---------- failed-attempt guard (public result page) ----------
const T = 1_000_000;

test('a key is blocked after the maximum number of failures', () => {
  const g = createAttemptGuard({ max: 3, windowMs: 1000 });
  g.fail('R-1', T);
  g.fail('R-1', T + 1);
  assert.equal(g.isBlocked('R-1', T + 2), false);
  g.fail('R-1', T + 2);
  assert.equal(g.isBlocked('R-1', T + 3), true);
});

test('blocking one roll number does not affect another', () => {
  const g = createAttemptGuard({ max: 1, windowMs: 1000 });
  g.fail('R-1', T);
  assert.equal(g.isBlocked('R-1', T), true);
  assert.equal(g.isBlocked('R-2', T), false);
});

test('old failures expire, so the block lifts after the window', () => {
  const g = createAttemptGuard({ max: 2, windowMs: 1000 });
  g.fail('R-1', T);
  g.fail('R-1', T);
  assert.equal(g.isBlocked('R-1', T + 500), true);
  assert.equal(g.isBlocked('R-1', T + 1500), false);
  assert.equal(g.size(), 0); // expired keys are cleaned up
});

test('a successful check resets the counter', () => {
  const g = createAttemptGuard({ max: 2, windowMs: 1000 });
  g.fail('R-1', T);
  g.reset('R-1');
  g.fail('R-1', T + 1);
  assert.equal(g.isBlocked('R-1', T + 2), false);
});

test('the guard never grows without limit (random keys are forgotten oldest first)', () => {
  const g = createAttemptGuard({ max: 1, windowMs: 1e9, maxKeys: 3 });
  for (const k of ['k1', 'k2', 'k3', 'k4']) g.fail(k, T);
  assert.equal(g.size(), 3);
  assert.equal(g.isBlocked('k1', T), false); // forgotten
  assert.equal(g.isBlocked('k4', T), true);
});
