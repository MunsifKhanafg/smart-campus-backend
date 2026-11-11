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
  },
  { timestamps: true }
);

staffAttendanceSchema.index({ user: 1, date: 1 }, { unique: true });

export default mongoose.model('StaffAttendance', staffAttendanceSchema);
