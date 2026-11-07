// Counts FAILED attempts per key (for example a roll number) inside a time window and blocks the key once it
// reaches the limit. It complements the per-IP rate limiter: an attacker who rotates IP addresses is still
// stopped from guessing the date of birth of one specific roll number.
// The data lives in memory, which is fine for a single server instance. (Pure logic: unit tested.)
export const createAttemptGuard = ({ max = 5, windowMs = 30 * 60 * 1000, maxKeys = 10000 } = {}) => {
  const hits = new Map(); // key -> timestamps of recent failures

  const recent = (key, now) => {
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length) hits.set(key, list);
    else hits.delete(key);
    return list;
  };

  return {
    isBlocked: (key, now = Date.now()) => recent(key, now).length >= max,
    fail: (key, now = Date.now()) => {
      const list = recent(key, now);
      list.push(now);
      hits.set(key, list);
      // Memory safety: if someone floods us with random keys, forget the oldest ones.
      if (hits.size > maxKeys) hits.delete(hits.keys().next().value);
    },
    reset: (key) => hits.delete(key),
    size: () => hits.size,
  };
};
