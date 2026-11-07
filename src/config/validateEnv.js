// Looks at the environment variables and reports what is wrong BEFORE the server starts taking requests.
// Pure function (takes the env as an argument) so it can be unit tested with fake settings.
//   errors   -> the server must not start
//   warnings -> printed, but the server still starts
export const checkEnv = (env = process.env) => {
  const errors = [];
  const warnings = [];
  const production = env.NODE_ENV === 'production';
  const provider = (env.PAYMENT_PROVIDER || 'mock').toLowerCase();

  if (!env.MONGO_URI) errors.push('MONGO_URI is not set');

  if (!env.JWT_SECRET || env.JWT_SECRET.length < 24) {
    errors.push('JWT_SECRET is missing or shorter than 24 characters');
  } else if (/change_this|changeme/i.test(env.JWT_SECRET)) {
    (production ? errors : warnings).push('JWT_SECRET still looks like the placeholder from .env.example. Generate a random one');
  }

  if (provider === 'stripe') {
    const missing = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'].filter((k) => !env[k]);
    if (missing.length) (production ? errors : warnings).push(`PAYMENT_PROVIDER is "stripe" but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set`);
  } else if (production) {
    warnings.push('PAYMENT_PROVIDER is "mock" in production. Online payments will be refused until it is set to "stripe"');
  } else {
    warnings.push('Mock payments are ON (development only). Always set NODE_ENV=production on a server that other people can reach');
  }

  if (production) {
    const clients = (env.CLIENT_URL || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!clients.length || clients.some((c) => /localhost|127\.0\.0\.1/.test(c))) {
      warnings.push('CLIENT_URL points to localhost. Set it to your real website address (used for CORS and payment redirects)');
    } else if (clients.some((c) => !c.startsWith('https://'))) {
      warnings.push('CLIENT_URL is not https. Use HTTPS in production');
    }
  }

  return { errors, warnings };
};
