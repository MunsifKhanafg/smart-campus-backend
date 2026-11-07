import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { ApiError, asyncHandler } from '../utils/apiHelpers.js';
import { ROLES } from '../config/constants.js';
import { shouldRenewToken } from '../utils/session.js';

export const signToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '30d' });

// 1) Is this a real, logged-in, still-active user?
export const protect = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw ApiError.unauthorized('Please log in to continue');

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    throw ApiError.unauthorized('Session expired or invalid. Please log in again');
  }

  const user = await User.findById(decoded.id);
  if (!user || !user.isActive) throw ApiError.unauthorized('This account is no longer active');
  if (user.changedPasswordAfter(decoded.iat)) {
    throw ApiError.unauthorized('Password was changed. Please log in again');
  }
  req.user = user;
  // Sliding session: an active user gets a fresh token (the browser stores it), so they stay logged in until Logout.
  if (shouldRenewToken(decoded.iat)) res.setHeader('X-Renewed-Token', signToken(user._id));
  next();
});

// 2) Does this role have permission for this route?
export const authorize = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.user.role)) return next(ApiError.forbidden());
  next();
};

// 3) Department isolation. The head sees everything; everyone else only their own department.
export const canAccessDepartment = (user, departmentId) => {
  if (user.role === ROLES.UNIVERSITY_HEAD) return true;
  return !!user.department && user.department.toString() === String(departmentId);
};

export const assertDepartmentAccess = (user, departmentId) => {
  if (!canAccessDepartment(user, departmentId)) {
    throw ApiError.forbidden('You can only access your own department');
  }
};
