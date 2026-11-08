import mongoose from 'mongoose';
import app from '../src/app.js';
import connectDB, { dbStatus, explainDbError } from '../src/config/db.js';
import { checkEnv } from '../src/config/validateEnv.js';

// ===========================================================================================================
// Vercel entry point. On Vercel there is no always-running server: every request wakes a short-lived function.
// So this file does what src/server.js does on your own computer, but per request:
//   1. checks the settings and says WHICH one is missing (instead of the opaque "FUNCTION_INVOCATION_FAILED"),
//   2. connects to MongoDB once per warm instance and reuses the connection,
//   3. hands the request to the normal Express app.
// src/server.js (app.listen, timers) is NOT used on Vercel. Use `npm run dev` / `npm start` locally as before.
// ===========================================================================================================

let connecting = null;
const ensureDb = async () => {
  if (mongoose.connection.readyState === 1) return;
  if (!connecting) connecting = connectDB().finally(() => { connecting = null; });
  await connecting;
};

export default async function handler(req, res) {
  const { errors } = checkEnv();
  if (errors.length) {
    // Allow the browser to read this message (otherwise the login page only shows "Network Error").
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Vary', 'Origin');
    res.status(500).json({
      success: false,
      message: `The server settings are incomplete: ${errors.join('; ')}. Add them in Vercel > your project > Settings > Environment Variables, then redeploy.`,
    });
    return;
  }

  try {
    await ensureDb();
  } catch (err) {
    // Not fatal: the app answers every API call with a readable "database not connected" message and the reason.
    dbStatus.lastError = explainDbError(err);
    console.error(`MongoDB connection failed: ${dbStatus.lastError}`);
  }
  return app(req, res);
}
