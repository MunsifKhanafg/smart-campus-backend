import mongoose from 'mongoose';

// "Other activity": a duty or task given to a Class IV staff member for a day (clean the labs, guard the gate, carry files...).
const classFourDutySchema = new mongoose.Schema(
  {
    staff: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassFourStaff', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },
    title: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
    details: { type: String, trim: true, maxlength: 500, default: '' },
    status: { type: String, enum: ['assigned', 'done', 'not_done'], default: 'assigned' },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export default mongoose.model('ClassFourDuty', classFourDutySchema);
