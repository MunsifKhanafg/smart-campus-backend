import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, fillSmsTemplate, smsEnabled, smsToUser } from '../src/services/smsService.js';

const ENV_KEYS = ['SMS_PROVIDER', 'SMS_HTTP_URL', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'];
const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  ENV_KEYS.forEach((k) => delete process.env[k]);
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    ENV_KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
  }
};

test('normalizePhone turns the usual ways of writing a mobile number into one international form', () => {
  assert.equal(normalizePhone('0300 1234567'), '+923001234567');
  assert.equal(normalizePhone('+92 300 1234567'), '+923001234567');
  assert.equal(normalizePhone('0092-300-1234567'), '+923001234567');
  assert.equal(normalizePhone('0701234567', '+93'), '+93701234567'); // another country code can be configured
});

test('normalizePhone rejects numbers it cannot use instead of guessing', () => {
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone('abc'), null);
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('+1234'), null);
});

test('fillSmsTemplate fills {to}, {to_plain} and {message} and URL-encodes them', () => {
  const url = fillSmsTemplate('https://gw.example.com/send?to={to_plain}&n={to}&msg={message}', '+923001234567', 'Payment received: PKR 5,000 & thanks');
  assert.equal(url, 'https://gw.example.com/send?to=923001234567&n=%2B923001234567&msg=Payment%20received%3A%20PKR%205%2C000%20%26%20thanks');
});

test('fillSmsTemplate fills every occurrence, so a body can repeat a placeholder', () => {
  assert.equal(fillSmsTemplate('{to_plain}-{to_plain}', '+92300', 'x'), '92300-92300');
});

test('smsEnabled is true only when the chosen provider has what it needs', async () => {
  assert.equal(await withEnv({}, () => smsEnabled()), false);
  assert.equal(await withEnv({ SMS_PROVIDER: 'console' }, () => smsEnabled()), true);
  assert.equal(await withEnv({ SMS_PROVIDER: 'http' }, () => smsEnabled()), false); // no address yet
  assert.equal(await withEnv({ SMS_PROVIDER: 'http', SMS_HTTP_URL: 'https://gw.example.com/send?to={to}&m={message}' }, () => smsEnabled()), true);
  assert.equal(await withEnv({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1' }, () => smsEnabled()), false); // credentials incomplete
  assert.equal(await withEnv({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+1555' }, () => smsEnabled()), true);
});

test('smsToUser reports not_configured (and touches nothing) when no SMS provider is set up', async () => {
  assert.equal(await withEnv({}, () => smsToUser('64b000000000000000000001', 'hello')), 'not_configured');
});
