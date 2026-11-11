import mongoose from 'mongoose';

// Class IV (support) staff of a department: naib qasid / peon, sweeper, chowkidar, mali, driver, lab attendant ...
// They are a DIRECTORY, not user accounts: they do not sign in, so there is no password and no role to manage.
// Each one belongs to one department. The HOD keeps the list of their department, the principal sees every department.

export const STAFF_SHIFTS = ['morning', 'evening', 'full_day'];
export const STAFF_STATUS = ['active', 'on_leave', 'inactive'];

// Suggestions for the "designation" box. The field itself is free text, so any other post can be typed.
export const CLASS_IV_DESIGNATIONS = [
  'Naib Qasid', 'Peon', 'Sweeper', 'Chowkidar (Guard)', 'Mali (Gardener)', 'Driver',
  'Lab Attendant', 'Electrician', 'Plumber', 'Mess / Cook', 'Other',
];

const supportStaffSchema = new mongoose.Schema(
  {
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    fatherName: { type: String, trim: true, maxlength: 100, default: '' },
    designation: { type: String, required: true, trim: true, maxlength: 60 },
    cnic: { type: String, trim: true, default: '', match: [/^(\d{5}-?\d{7}-?\d)?$/, 'CNIC has 13 digits, for example 12345-1234567-1'] },
    phone: { type: String, trim: true, maxlength: 30, default: '' },
    address: { type: String, trim: true, maxlength: 250, default: '' },
    joiningDate: { type: Date, default: null },
    shift: { type: String, enum: STAFF_SHIFTS, default: 'full_day' },
    duty: { type: String, trim: true, maxlength: 300, default: '' }, // what or where they look after, e.g. "Block A, ground floor"
    status: { type: String, enum: STAFF_STATUS, default: 'active', index: true },

    // Photo. It is kept inside the database (like the photos of teachers and students), in a field that is NOT loaded with the
    // list, so the list stays light. Only the two small fields below travel with the list; the picture is fetched one by one.
    hasPhoto: { type: Boolean, default: false },
    photoUpdatedAt: { type: Date, default: null },
    photo: {
      contentType: { type: String, enum: ['image/jpeg', 'image/png', 'image/webp'] },
      data: { type: Buffer, select: false },
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

supportStaffSchema.index({ department: 1, name: 1 });

export default mongoose.model('SupportStaff', supportStaffSchema);
