import mongoose from 'mongoose';
import { RESERVATION_STATUS } from '../config/constants.js';

// A student's place in the queue for a title whose copies are all out. When a copy comes back, the first student in the queue gets it:
// the copy is held at the desk (status "reserved") until `holdUntilDay`, then the next student gets the chance.
const reservationSchema = new mongoose.Schema(
  {
    book: { type: mongoose.Schema.Types.ObjectId, ref: 'Book', required: true, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    rollNumber: { type: String, trim: true, uppercase: true, default: '' },
    status: { type: String, enum: Object.values(RESERVATION_STATUS), default: RESERVATION_STATUS.WAITING, index: true },
    copy: { type: mongoose.Schema.Types.ObjectId, ref: 'BookCopy', default: null }, // the copy held for the student (status "ready")
    readyAt: Date,
    holdUntilDay: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    fulfilledAt: Date,
    loan: { type: mongoose.Schema.Types.ObjectId, ref: 'LibraryLoan', default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, trim: true, maxlength: 200, default: '' },
  },
  { timestamps: true }
);

// A student can wait for the same title only once at a time.
reservationSchema.index(
  { book: 1, student: 1 },
  { unique: true, partialFilterExpression: { status: { $in: [RESERVATION_STATUS.WAITING, RESERVATION_STATUS.READY] } }, name: 'one_open_reservation_per_student_book' }
);

export default mongoose.model('LibraryReservation', reservationSchema);
