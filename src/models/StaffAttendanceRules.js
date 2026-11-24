import mongoose from 'mongoose';

// The college's rules for the teachers' own attendance. One document for the whole university, set by the principal.
const staffAttendanceRulesSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true, immutable: true },
    timezone: { type: String, default: 'Asia/Karachi' },
    // Check-in opens when the college starts. Before this time nobody can check in.
    opensAt: { type: String, default: '08:30', match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    // Checking in up to this many minutes after the start is still "present". After that the day is flagged "late".
    graceMinutes: { type: Number, default: 15, min: 0, max: 240 },
    // Nobody checked in by this time -> the system marks the person absent (and moves that day's course contents to the next day).
    absentAfter: { type: String, default: '10:00', match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    // The SECOND attendance, at the break (for example 1 pm): the teacher marks again, from the college. It proves that the teacher
    // stayed and taught instead of checking in and going home. It opens at middayOpensAt and closes at closesAt.
    // A teacher who checked in but did not mark it is flagged "missed", unless the HOD approved leave for the rest of the day.
    // false = the college does not use the break-time attendance (only the morning check-in counts).
    middayRequired: { type: Boolean, default: true },
    // The first day the break-time attendance applies. Set automatically the first time it is used, so days from before it existed are never
    // flagged as "missed".
    middayFrom: { type: String, default: '', match: /^(\d{4}-\d{2}-\d{2})?$/ },
    middayOpensAt: { type: String, default: '13:00', match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    closesAt: { type: String, default: '14:00', match: /^([01]\d|2[0-3]):[0-5]\d$/ }, // the break-time attendance is possible until this time
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
