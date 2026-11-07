// Sliding sessions: while someone keeps using the app, their login token is quietly swapped for a fresh one,
// so they stay signed in until they press Logout. A token that is not used for the whole JWT_EXPIRES_IN period
// (30 days by default) still expires, and changing the password still logs out every other device.
export const RENEW_AFTER_SECONDS = 24 * 60 * 60;

// iat = the "issued at" time inside the token, in seconds. Renew once the token is more than a day old.
export const shouldRenewToken = (iat, nowMs = Date.now()) => Number.isFinite(iat) && nowMs / 1000 - iat > RENEW_AFTER_SECONDS;
