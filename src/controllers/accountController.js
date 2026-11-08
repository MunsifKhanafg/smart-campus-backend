import PaymentAccount from '../models/PaymentAccount.js';
import Payment from '../models/Payment.js';
import UniversitySettings from '../models/UniversitySettings.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { logAudit } from '../utils/audit.js';
import { accountLabel, checkAccountFields } from '../services/accountService.js';
import { ROLES } from '../config/constants.js';

const withLabel = (a) => ({ ...a, label: accountLabel(a) });
const DUPLICATE = 'This account is already in the list (it may be switched off). Edit that one instead';

// The accounts students can pay into. A student (and the head) sees only the active ones; the finance officer sees all.
export const listAccounts = asyncHandler(async (req, res) => {
  const filter = req.user.role === ROLES.FINANCE_OFFICER ? {} : { active: true };
  const [accounts, settings] = await Promise.all([
    PaymentAccount.find(filter).sort({ active: -1, type: 1, createdAt: 1 }).lean(),
    UniversitySettings.getSettings(),
  ]);
  sendSuccess(res, { accounts: accounts.map(withLabel), currency: settings.feePolicy.currency });
});

export const createAccount = asyncHandler(async (req, res) => {
  const problem = checkAccountFields(req.body);
  if (problem) throw ApiError.badRequest(problem);
  let account;
  try {
    account = await PaymentAccount.create({ ...req.body, createdBy: req.user._id });
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict(DUPLICATE);
    throw err;
  }
  logAudit(req, 'payment_account.create', 'PaymentAccount', account._id, { type: account.type, number: account.number });
  sendSuccess(res, withLabel(account.toObject()), 'Account added. Students can pay into it now', 201);
});

// The kind of account (bank / JazzCash / EasyPaisa) never changes. Add a new account instead.
export const updateAccount = asyncHandler(async (req, res) => {
  const account = await PaymentAccount.findById(req.params.id);
  if (!account) throw ApiError.notFound('Account not found');
  const merged = { ...account.toObject(), ...req.body };
  const problem = checkAccountFields(merged);
  if (problem) throw ApiError.badRequest(problem);
  account.set(req.body);
  account.updatedBy = req.user._id;
  try {
    await account.save();
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict(DUPLICATE);
    throw err;
  }
  logAudit(req, 'payment_account.update', 'PaymentAccount', account._id, { fields: Object.keys(req.body) });
  sendSuccess(res, withLabel(account.toObject()), 'Account updated');
});

export const setAccountActive = asyncHandler(async (req, res) => {
  const account = await PaymentAccount.findById(req.params.id);
  if (!account) throw ApiError.notFound('Account not found');
  account.active = req.body.active;
  account.updatedBy = req.user._id;
  await account.save();
  logAudit(req, account.active ? 'payment_account.activate' : 'payment_account.deactivate', 'PaymentAccount', account._id);
  sendSuccess(res, withLabel(account.toObject()), account.active ? 'Account is visible to students again' : 'Account hidden from students');
});

// An account that received payments stays (switch it off instead), so old receipts and records stay explainable.
export const deleteAccount = asyncHandler(async (req, res) => {
  const account = await PaymentAccount.findById(req.params.id);
  if (!account) throw ApiError.notFound('Account not found');
  const used = await Payment.countDocuments({ 'bank.accountId': account._id });
  if (used) throw ApiError.conflict(`${used} payment(s) were made into this account, so it cannot be deleted. Switch it off instead`);
  await account.deleteOne();
  logAudit(req, 'payment_account.delete', 'PaymentAccount', account._id, { type: account.type, number: account.number });
  sendSuccess(res, null, 'Account deleted');
});
