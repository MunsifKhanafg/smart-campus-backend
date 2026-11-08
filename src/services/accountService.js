import { ApiError } from '../utils/apiHelpers.js';

export const ACCOUNT_TYPES = { bank: 'Bank account', jazzcash: 'JazzCash', easypaisa: 'EasyPaisa' };
export const WALLET_NAMES = { jazzcash: 'JazzCash', easypaisa: 'EasyPaisa' };

// A Pakistani mobile number: 0300 1234567, 03001234567, +92 300 1234567 or 0092 300 1234567.
const MOBILE_RX = /^(\+92|0092|0)?3\d{9}$/;
export const isMobileNumber = (raw) => MOBILE_RX.test(String(raw || '').replace(/[\s-]/g, ''));

// The finance officer's account form: a bank account needs a bank name, a wallet needs a real mobile number.
// Returns a message, or null when everything is fine. (Pure: unit tested.)
export const checkAccountFields = ({ type, number, bankName }) => {
  if (type === 'bank') {
    if (!String(bankName || '').trim()) return 'Enter the name of the bank';
    return null;
  }
  if (!isMobileNumber(number)) return `Enter the mobile number of the ${WALLET_NAMES[type] || 'wallet'} account, for example 0300 1234567`;
  return null;
};

// One line that tells the officer where a payment went: "JazzCash 0300 1234567 (Smart Campus Fee Account)".
export const accountLabel = (a) => {
  const kind = a.type === 'bank' ? `${a.bankName || 'Bank'} account` : ACCOUNT_TYPES[a.type];
  return `${kind} ${a.number}${a.title ? ` (${a.title})` : ''}`;
};

// What the student must tell us about their own payment, depending on the account they paid into:
//   bank account -> the name of THEIR bank
//   wallet       -> the mobile number of THEIR JazzCash / EasyPaisa account (the officer finds the payment by it)
// Returns what is stored on the payment, or throws a clear message. (Pure apart from the error: unit tested.)
export const transferDetails = (account, body) => {
  if (account.type === 'bank') {
    const bankName = String(body.bankName || '').trim();
    if (bankName.length < 2) throw ApiError.badRequest('Enter the name of the bank you sent the money from');
    return { bankName, senderNumber: '' };
  }
  const senderNumber = String(body.senderNumber || '').replace(/[\s-]/g, '');
  if (!isMobileNumber(senderNumber)) {
    throw ApiError.badRequest(`Enter the mobile number of your ${WALLET_NAMES[account.type]} account, for example 0300 1234567`);
  }
  return { bankName: WALLET_NAMES[account.type], senderNumber };
};

// How an office payment was made. "cash" needs nothing more; the others need the transaction number.
export const OFFICE_METHODS = ['cash', 'bank', 'jazzcash', 'easypaisa'];
