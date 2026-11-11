import mongoose from 'mongoose';

// Class IV (grade 4) staff of a department: peons, sweepers, guards, gardeners, drivers... They do not log in.
// The principal adds them; the HOD of the department marks their attendance and gives them duties.
export const CLASS_FOUR_ROLES = ['peon', 'sweeper', 'guard', 'gardener', 'driver', 'lab_attendant', 'other'];

const classFourStaffSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    phone: { type: String, trim: true, maxlength: 30, default: '' },
    designation: { type: String, enum: CLASS_FOUR_ROLES, default: 'peon' },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    joiningDate: { type: Date, default: null },
    shift: { type: String, trim: true, maxlength: 60, default: '' }, // free text, for example "08:00 - 14:00"
    notes: { type: String, trim: true, maxlength: 300, default: '' },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export default mongoose.model('ClassFourStaff', classFourStaffSchema);
