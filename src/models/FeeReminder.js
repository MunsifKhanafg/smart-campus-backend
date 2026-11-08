import mongoose from 'mongoose';

// "Students who have not paid" list. The server creates one automatically for each exam / promotion fee notice when the
// payment deadline or the late deadline is close and on the day itself (see services/feeReminderService.js), and the finance
// office can also create one by hand. The HOD of the department and the finance officers are notified and open the list.
// The student list is a snapshot of the moment it was created, so the HOD always sees what was true when the reminder was sent.
const feeReminderSchema = new mongoose.Schema(
  {
    notice: { type: mongoose.Schema.Types.ObjectId, ref: 'FeeNotice', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
    feeType: { type: String, enum: ['examination', 'promotion', 'other', 'practical'], default: 'examination' },
    title: String,
    // due_near / due_day: before or on the normal deadline.  late_near / late_day: before or on the late deadline.
    trigger: { type: String, enum: ['due_near', 'due_day', 'late_near', 'late_day', 'manual'], required: true },
    deadline: Date, // the deadline this reminder is about
    totalStudents: { type: Number, default: 0 },
    unpaidCount: { type: Number, default: 0 },
    students: [
      {
        student: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        name: String,
        rollNumber: String,
        email: String,
        bankPending: { type: Boolean, default: false }, // sent a bank / wallet transfer that the finance office has not checked yet
        _id: false,
      },
    ],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // empty when created automatically
  },
  { timestamps: true }
);

feeReminderSchema.index({ department: 1, createdAt: -1 });

export default mongoose.model('FeeReminder', feeReminderSchema);
