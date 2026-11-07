import User from '../models/User.js';

// Optional text messages (SMS). Nothing is sent unless the server is configured with a provider, and a failed
// message can never break the real request (errors are only logged).
//
//   SMS_PROVIDER=twilio
//   TWILIO_ACCOUNT_SID=AC...
//   TWILIO_AUTH_TOKEN=...
//   TWILIO_FROM=+1555...            (a Twilio number or sender id)
//   SMS_DEFAULT_COUNTRY_CODE=+92    (used when a stored phone number starts with 0, for example 0300 1234567)
//
// The student's number is the "phone" saved on their account.
export const smsEnabled = () =>
  (process.env.SMS_PROVIDER || '').toLowerCase() === 'twilio' &&
  !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);

// "0300 1234567" -> "+923001234567", "+92 300 1234567" -> "+923001234567", "0092300..." -> "+92300..." (pure, unit tested)
export const normalizePhone = (raw, defaultCode = process.env.SMS_DEFAULT_COUNTRY_CODE || '+92') => {
  const digits = String(raw || '').replace(/[^\d+]/g, '');
  if (!digits) return null;
  let out = null;
  if (digits.startsWith('+')) out = `+${digits.slice(1).replace(/\D/g, '')}`;
  else if (digits.startsWith('00')) out = `+${digits.slice(2)}`;
  else if (digits.startsWith('0')) out = `${defaultCode}${digits.slice(1)}`;
  return out && /^\+\d{8,15}$/.test(out) ? out : null;
};

// Sends one SMS to a user's saved phone number. Returns true only if the provider accepted it.
export const smsToUser = async (userId, text) => {
  if (!smsEnabled()) return false;
  try {
    const user = await User.findById(userId).select('phone').lean();
    const to = normalizePhone(user?.phone);
    if (!to) return false;
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: String(text).slice(0, 320) }).toString(),
    });
    if (!res.ok) console.error('SMS was not accepted by the provider:', res.status);
    return res.ok;
  } catch (err) {
    console.error('SMS failed:', err.message);
    return false;
  }
};
