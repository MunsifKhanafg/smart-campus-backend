import mongoose from 'mongoose';

// Class IV (support) staff: naib qasid / peon, sweeper, chowkidar, mali, driver, lab attendant ...
// They are a DIRECTORY, not user accounts: they do not sign in, so there is no password and no role to manage.
// Each one works in ONE place: a department (the HOD keeps that list) or an office that belongs to no department
// (main college, principal's office, controller office, finance office ... only the principal keeps those).

export const STAFF_SHIFTS = ['morning', 'evening', 'full_day'];
export const STAFF_STATUS = ['active', 'on_leave', 'inactive'];

// Suggestions for the "designation" box. The field itself is free text, so any other post can be typed.
export const CLASS_IV_DESIGNATIONS = [
  'Naib Qasid', 'Peon', 'Sweeper', 'Chowkidar (Guard)', 'Mali (Gardener)', 'Driver',
  'Lab Attendant', 'Electrician', 'Plumber', 'Mess / Cook', 'Other',
];

const supportStaffSchema = new mongoose.Schema(
  {
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null, index: true },
    office: { type: String, trim: true, maxlength: 80, default: '', index: true }, // used when there is no department
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

// One place only: a department OR an office.
supportStaffSchema.pre('validate', function (next) {
  if (!this.department && !this.office) return next(new Error('Choose a department or an office for this staff member'));
  if (this.department && this.office) return next(new Error('A staff member works in a department or in an office, not both'));
  next();
});

supportStaffSchema.index({ department: 1, name: 1 });
supportStaffSchema.index({ office: 1, name: 1 });

export default mongoose.model('SupportStaff', supportStaffSchema);
