import mongoose from 'mongoose';

// One row per teacher / HOD per working day: the staff member's OWN attendance (not the attendance of students).
// `date` is the college's local calendar day ("YYYY-MM-DD"), so a day never shifts because of the server's time zone.
const staffAttendanceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null, index: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    status: { type: String, enum: ['present', 'late', 'absent', 'leave'], required: true },
    checkInAt: Date,
    checkOutAt: Date,
    minutesLate: { type: Number, default: 0 },
    // true = the system marked it (nobody checked in before the absent time, or an approved leave covers the day)
    auto: { type: Boolean, default: false },
    leave: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffLeave', default: null },
    // Proof that the person was on campus when checking in.
    proof: {
      method: { type: String, enum: ['gps', 'none'], default: 'none' },
      lat: Number,
      lng: Number,
      accuracy: Number, // metres, as reported by the phone / browser
      distanceMeters: Number, // distance from the campus point
      onCampus: { type: Boolean, default: null }, // null = no campus point is configured, so it could not be checked
      ip: { type: String, default: '' },
    },
    note: { type: String, trim: true, maxlength: 300, default: '' },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // set when an HOD / the principal corrected it
    topicsMoved: { type: Number, default: 0 }, // contents moved to the next teaching day because of this absence / leave

    // The SECOND attendance, at the break (about 1 pm). It is made from inside the college, with the same location proof as the morning check-in,
    // so a teacher cannot check in at 8:30 and then go home.
    midday: {
      at: Date,
      proof: {
        lat: Number,
        lng: Number,
        accuracy: Number,
        distanceMeters: Number,
        onCampus: { type: Boolean, default: null },
        ip: { type: String, default: '' },
      },
    },
    // present = marked at the break | leave = the HOD / principal approved leave for the REST OF THE DAY | missed = checked in in the morning but
    // did not mark at the break and had no approved leave. '' = not decided yet (the break has not come) or not applicable (absent / leave all day).
    afternoon: { type: String, enum: ['', 'present', 'leave', 'missed'], default: '' },
    shortLeave: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffLeave', default: null }, // the approved rest-of-day leave
  },
  { timestamps: true }
);

staffAttendanceSchema.index({ user: 1, date: 1 }, { unique: true });

export default mongoose.model('StaffAttendance', staffAttendanceSchema);
