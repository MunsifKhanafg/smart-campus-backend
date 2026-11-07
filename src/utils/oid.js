import mongoose from 'mongoose';

// Aggregation pipelines do not cast strings to ObjectIds automatically, so we do it ourselves.
export const oid = (v) => new mongoose.Types.ObjectId(String(v));
export const oids = (arr) => arr.map(oid);

// "2026-11-03" -> Date at 00:00 UTC (a "calendar day" with no time zone confusion).
export const dayStart = (input) => {
  const d = new Date(input);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

export const round2 = (n) => Math.round(n * 100) / 100;
