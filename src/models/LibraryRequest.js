import mongoose from 'mongoose';
import { REQUEST_STATUS } from '../config/constants.js';

// A student's request for a book that is available now ("Request book" button).
//   pending   : waiting for the library controller
//   approved  : a copy is held at the desk for the student (through a LibraryReservation with status "ready", so the hold, the expiry
//               and the one-click issue all use the code that already exists). `code` is what the student shows at the desk.
//   collected : the controller issued the book (`loan`)
//   rejected / cancelled / expired : closed, kept for history
// Student details are NOT typed by the student: they are copied from the student's profile when the request is made.
const requestSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 20 }, // "RQ-000123", shown as a barcode
    book: { type: mongoose.Schema.Types.ObjectId, ref: 'Book', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    rollNumber: { type: String, trim: true, uppercase: true, default: '' },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
    status: { type: String, enum: Object.values(REQUEST_STATUS), default: REQUEST_STATUS.PENDING, index: true },
    reservation: { type: mongoose.Schema.Types.ObjectId, ref: 'LibraryReservation', default: null, index: true },
    copy: { type: mongoose.Schema.Types.ObjectId, ref: 'BookCopy', default: null },
    holdUntilDay: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    loan: { type: mongoose.Schema.Types.ObjectId, ref: 'LibraryLoan', default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: Date,
    reason: { type: String, trim: true, maxlength: 300, default: '' }, // why it was rejected
  },
  { timestamps: true }
);

// A student can have only one open request for the same title.
requestSchema.index(
  { book: 1, student: 1 },
  { unique: true, partialFilterExpression: { status: { $in: [REQUEST_STATUS.PENDING, REQUEST_STATUS.APPROVED] } }, name: 'one_open_request_per_student_book' }
);
requestSchema.index({ status: 1, createdAt: 1 });

export default mongoose.model('LibraryRequest', requestSchema);
