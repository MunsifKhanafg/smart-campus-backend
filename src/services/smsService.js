import User from '../models/User.js';

// Text messages (SMS) after a payment is received or an admission is requested. A failed message can never break the real request:
// errors are only logged, and the payment record keeps the result (smsStatus) so the finance office can see whether the student was texted.
//
//   SMS_PROVIDER=console   Development / FYP demo: the message is printed in the server window instead of being sent.
//   SMS_PROVIDER=twilio    Real SMS through Twilio:
//     TWILIO_ACCOUNT_SID=AC...   TWILIO_AUTH_TOKEN=...   TWILIO_FROM=+1555...
//   SMS_PROVIDER=http      Any gateway that sends a text when a web address is called (most local bulk-SMS services do).
//     SMS_HTTP_URL=https://gateway.example.com/send?key=SECRET&to={to_plain}&message={message}
//     SMS_HTTP_METHOD=GET            (default) or POST
//     SMS_HTTP_BODY=to={to_plain}&message={message}     (POST only, sent as a form)
//     Placeholders: {to} = +923001234567, {to_plain} = 923001234567, {message} = the text (URL-encoded for you).
//     Any 2xx answer counts as "sent".
//   SMS_DEFAULT_COUNTRY_CODE=+92   (used when a stored phone number starts with 0, for example 0300 1234567)
//
// The student's number is the "phone" saved on their account. It is collected before they pay, or typed by the office at the counter.
const provider = () => (process.env.SMS_PROVIDER || '').toLowerCase();

export const smsEnabled = () =>
  provider() === 'console' ||
  (provider() === 'twilio' && !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM)) ||
  (provider() === 'http' && !!process.env.SMS_HTTP_URL);

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

// Fills the {to}, {to_plain} and {message} placeholders of a gateway address or body (pure, unit tested).
export const fillSmsTemplate = (template, to, text) =>
  String(template)
    .replaceAll('{to_plain}', encodeURIComponent(String(to).replace(/\D/g, '')))
    .replaceAll('{to}', encodeURIComponent(to))
    .replaceAll('{message}', encodeURIComponent(text));

// Sends one text message. Returns true when the provider accepted it.
const deliver = async (to, text, name = '') => {
  if (provider() === 'console') {
    console.log(`[SMS to ${name} ${to}] ${text}`);
    return true;
  }
  if (provider() === 'http') {
    const post = String(process.env.SMS_HTTP_METHOD || 'GET').toUpperCase() === 'POST';
    const res = await fetch(fillSmsTemplate(process.env.SMS_HTTP_URL, to, text), {
      method: post ? 'POST' : 'GET',
      ...(post && { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: fillSmsTemplate(process.env.SMS_HTTP_BODY || 'to={to_plain}&message={message}', to, text) }),
    });
    if (!res.ok) console.error('SMS was not accepted by the gateway:', res.status);
    return res.ok;
  }
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
};

// Sends one SMS to a user's saved phone number.
// Returns 'sent' | 'no_phone' | 'not_configured' | 'failed'.
export const smsToUser = async (userId, text) => {
  if (!smsEnabled()) return 'not_configured';
  try {
    const user = await User.findById(userId).select('phone name').lean();
    const to = normalizePhone(user?.phone);
    if (!to) return 'no_phone';
    return (await deliver(to, String(text).slice(0, 320), user.name)) ? 'sent' : 'failed';
  } catch (err) {
    console.error('SMS failed:', err.message);
    return 'failed';
  }
};
