import mongoose from 'mongoose';

// The college's rules for the teachers' own attendance. One document for the whole university, set by the principal.
const staffAttendanceRulesSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true, immutable: true },
    timezone: { type: String, default: 'Asia/Karachi' },
    // Check-in opens when the college starts. Before this time nobody can check in.
    opensAt: { type: String, default: '08:00', match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    // Checking in up to this many minutes after the start is still "present". After that the day is flagged "late".
    graceMinutes: { type: Number, default: 15, min: 0, max: 240 },
    // Nobody checked in by this time -> the system marks the person absent (and moves that day's course contents to the next day).
    absentAfter: { type: String, default: '10:00', match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    closesAt: { type: String, default: '16:00', match: /^([01]\d|2[0-3]):[0-5]\d$/ }, // check-out is possible until this time
    // Proof of presence: the phone's location must be inside this circle around the campus.
    campus: {
      lat: { type: Number, default: null, min: -90, max: 90 },
      lng: { type: Number, default: null, min: -180, max: 180 },
      radiusMeters: { type: Number, default: 300, min: 20, max: 5000 },
    },
    // true = checking in from outside the circle (or without a location) is refused. Needs the campus point above.
    requireOnCampus: { type: Boolean, default: true },
    maxAccuracyMeters: { type: Number, default: 200, min: 10, max: 2000 }, // a location less exact than this is not accepted as proof
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

staffAttendanceRulesSchema.statics.getRules = async function () {
  let doc = await this.findOne({ key: 'global' });
  if (!doc) doc = await this.create({ key: 'global' });
  return doc;
};

export default mongoose.model('StaffAttendanceRules', staffAttendanceRulesSchema);
