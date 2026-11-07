// Sends e-mail through the university's own SMTP server. It is OPTIONAL: when SMTP_HOST / SMTP_FROM are not set, or the
// "nodemailer" package is not installed, nothing is sent and the caller is told why. The in-portal message on the
// "Track my application" page always works, because applicants have no login and are reached through that page.
let transport; // undefined = not tried yet, null = not available

export const mailConfigured = () => !!process.env.SMTP_HOST && !!process.env.SMTP_FROM;

const getTransport = async () => {
  if (transport !== undefined) return transport;
  try {
    const { default: nodemailer } = await import('nodemailer');
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  } catch {
    transport = null;
  }
  return transport;
};

// -> { ok: true } or { ok: false, reason: 'not_configured' | 'nodemailer_missing' | 'failed' }
export const sendMail = async ({ to, subject, text }) => {
  if (!mailConfigured()) return { ok: false, reason: 'not_configured' };
  const t = await getTransport();
  if (!t) return { ok: false, reason: 'nodemailer_missing' };
  try {
    await t.sendMail({ from: process.env.SMTP_FROM, to, subject, text });
    return { ok: true };
  } catch (err) {
    console.error('E-mail failed:', err.message);
    return { ok: false, reason: 'failed' };
  }
};
