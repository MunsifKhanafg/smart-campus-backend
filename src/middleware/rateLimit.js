import rateLimit from 'express-rate-limit';

const make = (windowMinutes, max, message) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message },
  });

// Stops password guessing. Only FAILED logins count (a successful login does not use up the allowance), and the limit is
// generous while developing, so testing with different accounts never locks you out. The count lives in memory:
// restarting the server clears it.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 20 : 1000,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many failed login attempts. Please try again in 15 minutes.' },
});

// General limiter for the whole API.
export const apiLimiter = make(15, 600, 'Too many requests. Please slow down.');

// Public result checking: strict, because it is reachable without a login.
export const publicResultLimiter = make(15, 8, 'Too many result checks. Please try again later.');

// Payments: creating checkouts and verifying them.
export const paymentLimiter = make(15, 30, 'Too many payment requests. Please try again later.');

// Public admission portal: a few applications per hour from one address (stops form spam), and limited status checks.
export const applyLimiter = make(60, 6, 'Too many applications were sent from this address. Please try again in an hour.');
export const applyTrackLimiter = make(15, 20, 'Too many status checks. Please try again in a few minutes.');

// AI calls cost money, so they get their own small budget.
export const aiLimiter = make(15, 40, 'You are asking too quickly. Please wait a few minutes.');
