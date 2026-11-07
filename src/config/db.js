import dns from 'dns';
import mongoose from 'mongoose';

// The last connection problem, in plain words. The API shows it to the browser while the database is down,
// so a login attempt says WHY it fails instead of just "Network Error".
export const dbStatus = { lastError: '' };

export const dbConnected = () => mongoose.connection.readyState === 1;

// Turns the driver's raw error into advice a student can act on (single line, safe to show on the login page).
export const explainDbError = (err) => {
  const raw = String(err?.message || err);
  let hint = '';
  if (/bad auth|authentication failed/i.test(raw)) {
    hint = 'Wrong database username or password. Check Atlas > Database Access, and URL-encode special characters in the password.';
  } else if (/querySrv|queryTxt|_mongodb\._tcp|ENOTFOUND/i.test(raw)) {
    hint = 'This computer could not resolve the Atlas address (DNS). Try another network (a phone hotspot), or use the "standard" mongodb:// connection string from Atlas.';
  } else if (/whitelist|not allowed|server selection|ReplicaSetNoPrimary|ETIMEDOUT|ETIMEOUT|ECONNREFUSED/i.test(raw)) {
    hint = 'Atlas is not accepting connections from this computer. In Atlas open Network Access and add your current IP address (or 0.0.0.0/0 for development).';
  }
  return `${raw.split('\n')[0]}${hint ? ` — ${hint}` : ''}`;
};

const isSrv = (uri) => /^mongodb\+srv:\/\//.test(uri || '');

// Rejects with an error carrying `code` when a DNS lookup takes too long (a blocked lookup can hang for a minute).
const withLimit = (promise, ms) => {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'ETIMEOUT' })), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
};

// A mongodb+srv:// address makes the driver do two DNS lookups (SRV, then TXT). On some networks the TXT lookup is
// dropped ("queryTxt ETIMEOUT") and the driver waits a long time before giving up. So we do the lookups ourselves,
// with short time limits, and connect with an ordinary mongodb://host1,host2,host3 address built from the SRV answer.
// The TXT record only carries authSource/replicaSet; we ask for it briefly and fall back to authSource=admin (Atlas default).
export const srvToDirectUri = async (uri, { srvLimitMs = 8000, txtLimitMs = 4000 } = {}) => {
  const u = new URL(uri);
  const name = `_mongodb._tcp.${u.hostname}`;
  let records;
  try {
    records = await withLimit(dns.promises.resolveSrv(name), srvLimitMs);
  } catch (e) {
    throw new Error(`querySrv ${e.code || e.message} ${name}`);
  }
  if (!records?.length) throw new Error(`querySrv ENODATA ${name}`);

  const params = new URLSearchParams(u.search);
  try {
    const txt = await withLimit(dns.promises.resolveTxt(u.hostname), txtLimitMs);
    new URLSearchParams(txt.flat().join('')).forEach((v, k) => { if (!params.has(k)) params.set(k, v); });
  } catch {
    if (!params.has('authSource')) params.set('authSource', 'admin');
  }
  if (!params.has('tls') && !params.has('ssl')) params.set('tls', 'true');

  const auth = u.username ? `${u.username}${u.password ? `:${u.password}` : ''}@` : ''; // credentials stay percent-encoded as written
  const hosts = records.map((r) => `${r.name}:${r.port}`).join(',');
  return `mongodb://${auth}${hosts}${u.pathname || '/'}?${params.toString()}`;
};

const connectDB = async () => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is missing in .env');
  // Some home networks cannot resolve mongodb+srv:// addresses. DNS_SERVERS=8.8.8.8,1.1.1.1 can work around that.
  if (process.env.DNS_SERVERS) {
    dns.setServers(process.env.DNS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean));
  }
  mongoose.set('strictQuery', true);
  const original = process.env.MONGO_URI;
  const uri = isSrv(original) ? await srvToDirectUri(original) : original;
  // Fail after 10 seconds (not 30) so a wrong setting is reported quickly.
  const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  dbStatus.lastError = '';
  console.log(`MongoDB connected: ${conn.connection.host}`);
};

export default connectDB;
