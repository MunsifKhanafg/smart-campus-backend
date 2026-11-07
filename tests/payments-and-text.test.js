import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { verifyStripeSignature } from '../src/services/paymentGateway.js';
import { chunkText } from '../src/services/textExtractService.js';

const SECRET = 'whsec_test_secret';
const BODY = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_1' } } });
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const sign = (body, secret, t) => crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
const header = (t, sig) => `t=${t},v1=${sig}`;
const t0 = Math.floor(NOW / 1000);

test('a correctly signed webhook is accepted', () => {
  assert.equal(verifyStripeSignature(BODY, header(t0, sign(BODY, SECRET, t0)), SECRET, 300, NOW), true);
});

test('a webhook with a tampered body is rejected (nobody can fake a "paid" event)', () => {
  const sig = sign(BODY, SECRET, t0);
  const tampered = BODY.replace('cs_test_1', 'cs_test_2');
  assert.equal(verifyStripeSignature(tampered, header(t0, sig), SECRET, 300, NOW), false);
});

test('a webhook signed with the wrong secret is rejected', () => {
  assert.equal(verifyStripeSignature(BODY, header(t0, sign(BODY, 'another_secret', t0)), SECRET, 300, NOW), false);
});

test('an old signed webhook is rejected (replay protection)', () => {
  const old = t0 - 10 * 60;
  assert.equal(verifyStripeSignature(BODY, header(old, sign(BODY, SECRET, old)), SECRET, 300, NOW), false);
});

test('missing or malformed signature headers are rejected', () => {
  assert.equal(verifyStripeSignature(BODY, undefined, SECRET, 300, NOW), false);
  assert.equal(verifyStripeSignature(BODY, 'v1=abc', SECRET, 300, NOW), false);
  assert.equal(verifyStripeSignature(BODY, header(t0, 'short'), SECRET, 300, NOW), false);
  assert.equal(verifyStripeSignature(BODY, header(t0, sign(BODY, SECRET, t0)), '', 300, NOW), false);
});

test('chunkText returns nothing for empty text', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n  '), []);
  assert.deepEqual(chunkText(null), []);
});

test('chunkText keeps short text in a single passage', () => {
  assert.deepEqual(chunkText('Binary search halves the range each step.'), ['Binary search halves the range each step.']);
});

test('chunkText cuts long text into overlapping passages at word boundaries', () => {
  const words = Array.from({ length: 1000 }, (_, i) => `w${i}`);
  const chunks = chunkText(words.join(' '));
  assert.ok(chunks.length > 4);
  assert.ok(chunks.every((c) => c.length > 0 && c.length <= 900));
  // No word is cut in half: every chunk starts and ends on a whole word.
  const valid = new Set(words);
  for (const c of chunks) {
    const parts = c.split(' ');
    assert.ok(valid.has(parts[0]) && valid.has(parts[parts.length - 1]));
  }
  // Passages overlap, so a sentence at a boundary is still found in one of them.
  const last = chunks[0].split(' ').pop();
  assert.ok(chunks[1].includes(last));
  // Nothing is lost: the first and the last word of the document are both covered.
  assert.ok(chunks[0].startsWith('w0 '));
  assert.ok(chunks[chunks.length - 1].endsWith('w999'));
});
