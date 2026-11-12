import mongoose from 'mongoose';

// A duty or task given to a Class IV (support) staff member for one day: clean the labs, guard the gate, carry files ...
// One document = one duty on one day. A duty that repeats every day is saved as one document per day, so each day can be
// ticked off (done / not done) on its own and the history stays correct.
// Dates are plain calendar days ("YYYY-MM-DD") so a duty never shifts because of a time zone.
// The place (department or office) is copied from the staff member, so a duty is found by place without a lookup.
export const DUTY_STATUS = ['assigned', 'in_progress', 'done', 'not_done'];

const supportDutySchema = new mongoose.Schema(
  {
    staff: { type: mongoose.Schema.Types.ObjectId, ref: 'SupportStaff', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null, index: true },
    office: { type: String, trim: true, maxlength: 80, default: '', index: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    title: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
    details: { type: String, trim: true, maxlength: 500, default: '' },
    status: { type: String, enum: DUTY_STATUS, default: 'assigned', index: true },
    note: { type: String, trim: true, maxlength: 300, default: '' }, // why it was not done, or a remark when it was done
    completedAt: { type: Date, default: null },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

supportDutySchema.index({ department: 1, date: 1 });
supportDutySchema.index({ office: 1, date: 1 });
supportDutySchema.index({ staff: 1, date: 1 });

export default mongoose.model('SupportDuty', supportDutySchema);
