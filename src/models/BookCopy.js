import mongoose from 'mongoose';
import { BOOK_COPY_STATUS } from '../config/constants.js';

// One physical copy of a book, with its own barcode. The barcode is the `code` ("LB-000012-01"), printed as Code 128 and
// scanned (camera, USB scanner) or typed at the desk to issue and return the book.
const bookCopySchema = new mongoose.Schema(
  {
    book: { type: mongoose.Schema.Types.ObjectId, ref: 'Book', required: true, index: true },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 40 },
    status: { type: String, enum: Object.values(BOOK_COPY_STATUS), default: BOOK_COPY_STATUS.AVAILABLE, index: true },
    // The loan that has the copy right now (status "issued"), or the reservation it is held for (status "reserved").
    currentLoan: { type: mongoose.Schema.Types.ObjectId, ref: 'LibraryLoan', default: null },
    heldFor: { type: mongoose.Schema.Types.ObjectId, ref: 'LibraryReservation', default: null },
    note: { type: String, trim: true, maxlength: 300, default: '' }, // for example "cover torn", "found behind rack C"
    statusChangedAt: { type: Date, default: Date.now },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

bookCopySchema.index({ book: 1, status: 1 });

export default mongoose.model('BookCopy', bookCopySchema);
