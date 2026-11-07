import { ApiError } from './apiHelpers.js';

// Used by every "delete a record I created by mistake" action.
// A record may only be deleted while nothing real depends on it. Each check is [label, countPromise].

// Returns the checks that found something: [[count, label], ...]. Empty means nothing is in the way.
export const findBlockers = async (checks) => {
  const counts = await Promise.all(checks.map(([, p]) => p));
  return checks.map(([label], i) => [counts[i], label]).filter(([n]) => n > 0);
};

// Same, but refuses the request with a plain message that says exactly what is in the way.
export const assertNoBlockers = async (what, checks, hint) => {
  const found = await findBlockers(checks);
  if (!found.length) return;
  const list = found.map(([n, label]) => `${n} ${label}`).join(', ');
  throw ApiError.badRequest(`${what} cannot be deleted because of existing records: ${list}. ${hint}`);
};
