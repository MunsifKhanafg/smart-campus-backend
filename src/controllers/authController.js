import User from '../models/User.js';
import bcrypt from 'bcryptjs';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { signToken } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';

// Used only to spend the same time as a real password check when the email does not exist (see login).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email }).select('+password').populate('department', 'name code status');
  // Same message AND same response time for "no user" and "wrong password", so attackers can't discover valid emails.
  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    throw ApiError.unauthorized('Invalid email or password');
  }
  if (!(await user.comparePassword(password))) throw ApiError.unauthorized('Invalid email or password');
  if (!user.isActive) throw ApiError.forbidden('This account has been deactivated');

  user.lastLogin = new Date();
  await user.save({ validateBeforeSave: false });

  sendSuccess(res, { token: signToken(user._id), user }, 'Login successful');
});

export const me = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).populate('department', 'name code status');
  sendSuccess(res, { user });
});

export const changePassword = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('+password');
  if (!(await user.comparePassword(req.body.currentPassword))) throw ApiError.badRequest('Current password is incorrect');
  user.password = req.body.newPassword;
  user.mustChangePassword = false;
  await user.save();
  sendSuccess(res, { token: signToken(user._id) }, 'Password changed');
});

// Own account details. Anyone logged in may update their own name, phone and qualification.
// Changing the email is a sensitive change, so it needs the current password (a stolen open session is not enough).
export const updateAccount = asyncHandler(async (req, res) => {
  const { currentPassword, ...fields } = req.body;
  const user = await User.findById(req.user._id).select('+password');

  if (fields.email !== undefined && fields.email !== user.email) {
    if (!(await user.comparePassword(currentPassword))) throw ApiError.badRequest('Current password is incorrect');
    if (await User.exists({ email: fields.email, _id: { $ne: user._id } })) throw ApiError.conflict('This email is already used by another account');
    user.email = fields.email;
  }
  for (const k of ['name', 'phone', 'qualification']) if (fields[k] !== undefined) user[k] = fields[k];
  await user.save({ validateBeforeSave: true });

  logAudit(req, 'account.update', 'User', user._id, { fields: Object.keys(fields) });
  sendSuccess(res, { user: await User.findById(user._id).populate('department', 'name code status') }, 'Account updated');
});
