import test from 'node:test';
import assert from 'node:assert/strict';
import { isMobileNumber, checkAccountFields, accountLabel, transferDetails, OFFICE_METHODS } from '../src/services/accountService.js';

const badRequest = (pattern) => (err) => err.statusCode === 400 && pattern.test(err.message);

// ---------- wallet numbers ----------
test('a Pakistani mobile number is accepted in the usual written forms', () => {
  for (const ok of ['0300 1234567', '03001234567', '0300-1234567', '+92 300 1234567', '0092-300-1234567', '3001234567']) {
    assert.equal(isMobileNumber(ok), true, ok);
  }
});

test('numbers that are too short, too long, not mobile or not numbers are refused', () => {
  for (const bad of ['', '0300 123456', '0300 12345678', '0400 1234567', '051 1234567', 'abc', '+1 300 1234567']) {
    assert.equal(isMobileNumber(bad), false, bad);
  }
});

// ---------- the finance officer's "Add account" form ----------
test('a bank account needs a bank name', () => {
  assert.equal(checkAccountFields({ type: 'bank', number: '0123456789', bankName: '' }), 'Enter the name of the bank');
  assert.equal(checkAccountFields({ type: 'bank', number: '0123456789', bankName: 'HBL' }), null);
});

test('a JazzCash or EasyPaisa account needs a real mobile number, and the message names the wallet', () => {
  assert.match(checkAccountFields({ type: 'jazzcash', number: '12345' }), /JazzCash/);
  assert.match(checkAccountFields({ type: 'easypaisa', number: '12345' }), /EasyPaisa/);
  assert.equal(checkAccountFields({ type: 'jazzcash', number: '0300 1234567' }), null);
  assert.equal(checkAccountFields({ type: 'easypaisa', number: '0345-1234567' }), null);
});

// ---------- the label stored on every payment ----------
test('the account label says where the money went', () => {
  assert.equal(accountLabel({ type: 'bank', bankName: 'HBL', number: '0123456789', title: 'Smart Campus' }), 'HBL account 0123456789 (Smart Campus)');
  assert.equal(accountLabel({ type: 'jazzcash', number: '0300 1234567', title: 'Fee Office' }), 'JazzCash 0300 1234567 (Fee Office)');
  assert.equal(accountLabel({ type: 'easypaisa', number: '0345 1234567', title: '' }), 'EasyPaisa 0345 1234567');
  assert.equal(accountLabel({ type: 'bank', number: '123' }), 'Bank account 123');
});

// ---------- what the student has to tell us ----------
test('paying into a bank account: the student gives the name of their own bank', () => {
  const bank = { type: 'bank' };
  assert.deepEqual(transferDetails(bank, { bankName: ' Meezan Bank ' }), { bankName: 'Meezan Bank', senderNumber: '' });
  assert.throws(() => transferDetails(bank, {}), badRequest(/name of the bank/));
  assert.throws(() => transferDetails(bank, { bankName: 'A' }), badRequest(/name of the bank/));
});

test('paying into JazzCash or EasyPaisa: the student gives their own mobile number, stored without spaces', () => {
  assert.deepEqual(transferDetails({ type: 'jazzcash' }, { senderNumber: '0300 123-4567' }), { bankName: 'JazzCash', senderNumber: '03001234567' });
  assert.deepEqual(transferDetails({ type: 'easypaisa' }, { senderNumber: '+92 345 1234567' }), { bankName: 'EasyPaisa', senderNumber: '+923451234567' });
  assert.throws(() => transferDetails({ type: 'jazzcash' }, {}), badRequest(/JazzCash/));
  assert.throws(() => transferDetails({ type: 'easypaisa' }, { senderNumber: '12345' }), badRequest(/EasyPaisa/));
});

test('a bank name typed for a wallet payment is ignored (the wallet name is used)', () => {
  assert.equal(transferDetails({ type: 'jazzcash' }, { bankName: 'HBL', senderNumber: '03001234567' }).bankName, 'JazzCash');
});

// ---------- office payments ----------
test('an office payment can be cash or come through a bank or wallet', () => {
  assert.deepEqual(OFFICE_METHODS, ['cash', 'bank', 'jazzcash', 'easypaisa']);
});
