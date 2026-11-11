// Pure rules for the teachers' own attendance (no database), so they can be tested on their own.

export const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

// The day ("YYYY-MM-DD") and the minute of the day in the college's time zone.
export const localNow = (date = new Date(), timeZone = 'Asia/Karachi') => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
};

const DAY_MS = 86400000;
export const addDays = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const weekdayOf = (key) => ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date(`${key}T00:00:00Z`).getUTCDay()];
export const eachDay = (from, to, max = 366) => {
  const out = [];
  for (let k = from; k <= to && out.length < max; k = addDays(k, 1)) out.push(k);
  return out;
};

// Distance between two points on the earth, in metres (haversine).
export const distanceMeters = (lat1, lng1, lat2, lng2) => {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
};

// What may happen when the person tries to check in at minute `nowMin` of the day?
//   not_open : the college has not started yet
//   on_time  : up to the grace time after the start -> "present"
//   late     : after the grace time but before the absent time -> "late" (with the minutes late)
//   closed   : the absent time has passed -> the person is absent and the principal / HOD must correct it
export const checkInDecision = ({ nowMin, opensAt, graceMinutes, absentAfter }) => {
  const open = toMinutes(opensAt);
  if (nowMin < open) return { state: 'not_open', opensInMinutes: open - nowMin };
  if (nowMin >= toMinutes(absentAfter)) return { state: 'closed' };
  const late = nowMin - open - graceMinutes;
  return late > 0 ? { state: 'late', status: 'late', minutesLate: late } : { state: 'on_time', status: 'present', minutesLate: 0 };
};

// Is the phone inside the campus circle? A location that is not exact enough cannot prove anything.
export const checkProof = ({ campus, lat, lng, accuracy, maxAccuracyMeters }) => {
  const hasCampus = campus?.lat != null && campus?.lng != null;
  if (!hasCampus) return { configured: false, ok: true, onCampus: null, reason: null };
  if (lat == null || lng == null) return { configured: true, ok: false, onCampus: false, reason: 'Allow location access so the college can see that you are on campus' };
  if (accuracy != null && accuracy > maxAccuracyMeters) {
    return { configured: true, ok: false, onCampus: false, reason: `Your location is not exact enough (${Math.round(accuracy)} m). Move to an open place, switch on GPS and try again` };
  }
  const distance = distanceMeters(campus.lat, campus.lng, lat, lng);
  const ok = distance <= campus.radiusMeters;
  return { configured: true, ok, onCampus: ok, distance, reason: ok ? null : `You are about ${distance} m from the campus. Check-in works within ${campus.radiusMeters} m` };
};
