import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRenewToken, RENEW_AFTER_SECONDS } from '../src/utils/session.js';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const secs = Math.floor(NOW / 1000);

test('a token issued a moment ago is not renewed (no new token on every request)', () => {
  assert.equal(shouldRenewToken(secs - 5, NOW), false);
  assert.equal(shouldRenewToken(secs - 3 * 3600, NOW), false);
});

test('a token older than a day is renewed, so an active user never has to log in again', () => {
  assert.equal(shouldRenewToken(secs - RENEW_AFTER_SECONDS - 1, NOW), true);
  assert.equal(shouldRenewToken(secs - 20 * 24 * 3600, NOW), true);
});

test('exactly one day old is the boundary: not yet renewed', () => {
  assert.equal(shouldRenewToken(secs - RENEW_AFTER_SECONDS, NOW), false);
});

test('a token without a usable issue time is never renewed', () => {
  assert.equal(shouldRenewToken(undefined, NOW), false);
  assert.equal(shouldRenewToken(NaN, NOW), false);
  assert.equal(shouldRenewToken('abc', NOW), false);
});
