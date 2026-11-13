import mongoose from 'mongoose';

// One row per TITLE in the library catalogue. The physical copies (each with its own barcode) are in BookCopy.
// The copy counters below are a cache that services/libraryService.js recomputes from the copies after every change
// (recountBook), so they can be filtered and sorted in one query. The copies are the truth.
const bookSchema = new mongoose.Schema(
  {
    // The library's own ID for the title, e.g. "LB-000012" (made automatically, or typed by the librarian). Copies are "LB-000012-01", "-02" ...
    bookId: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 30, match: [/^[A-Z0-9][A-Z0-9-]{1,28}$/, 'Book ID: letters, numbers and "-" only'] },
    title: { type: String, required: true, trim: true, maxlength: 250 },
    authors: { type: [{ type: String, trim: true, maxlength: 120 }], default: [], validate: [(v) => v.length <= 10, 'At most 10 authors'] },
    isbn: { type: String, trim: true, uppercase: true, maxlength: 20, default: '', index: true },
    category: { type: String, required: true, trim: true, maxlength: 80, index: true },
    publisher: { type: String, trim: true, maxlength: 120, default: '' },
    edition: { type: String, trim: true, maxlength: 40, default: '' },
    year: { type: Number, min: 1000, max: 2200, default: null },
    language: { type: String, trim: true, maxlength: 40, default: 'English' },
    pages: { type: Number, min: 1, max: 20000, default: null },
    shelf: { type: String, trim: true, maxlength: 60, default: '' }, // where the book stands, e.g. "Rack B-3"
    description: { type: String, trim: true, maxlength: 1500, default: '' },
    // What the book costs. Used for the penalty when a copy is lost.
    price: { type: Number, min: 0, default: 0 },
    // Optional: a book that belongs to one department's subject area.
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null, index: true },
    // Optional: the semester (1 to 12) this book is recommended for. The library keeps up to 30 books per semester.
    semesterNumber: { type: Number, min: 1, max: 12, default: null, index: true },

    // ----- cached counters (see the note at the top) -----
    copiesTotal: { type: Number, default: 0 }, // every copy that is still part of the collection (not withdrawn)
    copiesAvailable: { type: Number, default: 0, index: true },
    copiesIssued: { type: Number, default: 0 },
    copiesReserved: { type: Number, default: 0 },
    copiesLost: { type: Number, default: 0 },
    copiesDamaged: { type: Number, default: 0 },

    // A removed title disappears from the catalogue but its history stays (loans always point to a book).
    status: { type: String, enum: ['active', 'removed'], default: 'active', index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Searching uses a case-insensitive pattern on title / author / ISBN / ID / category (so "alg" finds "Algorithms"), see buildBookFilter in libraryService.js.

export default mongoose.model('Book', bookSchema);
