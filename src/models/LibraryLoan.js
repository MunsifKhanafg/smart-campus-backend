import mongoose from 'mongoose';
import { LOAN_STATUS } from '../config/constants.js';

const dayKey = { type: String, match: /^\d{4}-\d{2}-\d{2}$/ };

// One book copy given to one student. Days are the college's LOCAL calendar days ("YYYY-MM-DD", like the staff attendance), so a due date never
// shifts because of the server's time zone. The fine is calculated from the days, never from clock times.
const libraryLoanSchema = new mongoose.Schema(
  {
    book: { type: mongoose.Schema.Types.ObjectId, ref: 'Book', required: true, index: true },
    copy: { type: mongoose.Schema.Types.ObjectId, ref: 'BookCopy', required: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Copied from the student's profile when the book is issued, so lists and reports do not need a join and history stays readable.
    rollNumber: { type: String, trim: true, uppercase: true, default: '', index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null, index: true },

    status: { type: String, enum: Object.values(LOAN_STATUS), default: LOAN_STATUS.ISSUED, index: true },
    issuedAt: { type: Date, default: Date.now },
    issuedDay: { ...dayKey, required: true },
    dueDay: { ...dayKey, required: true, index: true }, // the last day the student may return it without a fine
    originalDueDay: dayKey,
    renewals: { type: Number, default: 0 },
    returnedAt: Date,
    returnedDay: dayKey,
    returnCondition: { type: String, enum: ['good', 'damaged', 'lost', null], default: null },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    note: { type: String, trim: true, maxlength: 300, default: '' },

    // ----- money -----
    // perDay / cap / grace are copied from the library rules when the book is issued, so a later change of the rules never changes
    // the fine of a book that is already out. accrued is written when the book comes back (or is marked lost); while it is out the fine is computed live.
    fine: {
      perDay: { type: Number, default: 0, min: 0 },
      cap: { type: Number, default: null, min: 0 },
      grace: { type: Number, default: 0, min: 0 },
      accrued: { type: Number, default: 0, min: 0 },
    },
    // Lost / damaged book charges on top of the late fine.
    penalties: [
      {
        type: { type: String, enum: ['lost', 'damaged'], required: true },
        amount: { type: Number, required: true, min: 0 },
        note: { type: String, trim: true, maxlength: 300, default: '' },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        at: { type: Date, default: Date.now },
        _id: false,
      },
    ],
    // Money received at the library desk, and amounts the librarian forgave. Nothing is ever deleted: it is a ledger.
    payments: [
      {
        kind: { type: String, enum: ['payment', 'waiver'], required: true },
        amount: { type: Number, required: true, min: 0.01 },
        note: { type: String, trim: true, maxlength: 300, default: '' },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        at: { type: Date, default: Date.now },
        _id: false,
      },
    ],

    // ----- automatic follow-up (see runLibraryJobs) -----
    overdueNotified: { type: Boolean, default: false }, // the controller was told once that this loan became overdue
    complaintClaimed: { type: Boolean, default: false }, // set first (atomically) so two job runs can never file two complaints
    complaint: { type: mongoose.Schema.Types.ObjectId, ref: 'Complaint', default: null }, // sent to the student's department (HOD)
    principalClaimed: { type: Boolean, default: false },
    principalComplaint: { type: mongoose.Schema.Types.ObjectId, ref: 'Complaint', default: null }, // sent to the principal
  },
  { timestamps: true }
);

// A copy can be out on only ONE loan at a time. The database refuses a second open loan of the same copy, even when two librarians
// press "Issue" at the same moment.
libraryLoanSchema.index({ copy: 1 }, { unique: true, partialFilterExpression: { status: LOAN_STATUS.ISSUED }, name: 'one_open_loan_per_copy' });
libraryLoanSchema.index({ student: 1, status: 1 });
libraryLoanSchema.index({ status: 1, dueDay: 1 });

export default mongoose.model('LibraryLoan', libraryLoanSchema);
