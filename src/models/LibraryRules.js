import mongoose from 'mongoose';

// The library's rules. One document for the whole university, edited by the library controller or the principal (Library > Rules).
// Everything the automatic SMS reminders, fines and complaints do is controlled from here.
const libraryRulesSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true, immutable: true },

    // ----- borrowing -----
    loanDays: { type: Number, default: 14, min: 1, max: 120 }, // how long a student may keep a book
    maxBooksPerStudent: { type: Number, default: 3, min: 1, max: 30 },
    maxRenewals: { type: Number, default: 1, min: 0, max: 10 }, // 0 = books cannot be renewed
    renewDays: { type: Number, default: 7, min: 1, max: 60 },
    blockIssueIfOverdue: { type: Boolean, default: true }, // no new book while one is overdue
    blockIssueIfFineUnpaid: { type: Boolean, default: false }, // no new book while a fine is unpaid

    // ----- fines -----
    finePerDay: { type: Number, default: 10, min: 0, max: 100000 }, // per book per day after the due day (currency: University Settings)
    graceDays: { type: Number, default: 0, min: 0, max: 30 }, // days after the due day before the fine starts
    maxFinePerBook: { type: Number, default: null, min: 0 }, // null = no limit
    lostPenaltyMultiplier: { type: Number, default: 1, min: 0, max: 10 }, // a lost book costs price x this
    lostProcessingFee: { type: Number, default: 0, min: 0 },

    // ----- automatic SMS and in-app reminders -----
    smsEnabled: { type: Boolean, default: false }, // no longer used: the library only sends in-app notifications (kept so old saved rules still load)
    reminderBeforeDays: { type: [Number], default: [3, 1] }, // days before the due day on which a reminder is sent
    remindOnDueDay: { type: Boolean, default: true },
    overdueReminderEveryDays: { type: Number, default: 2, min: 1, max: 30 }, // repeat interval after the due day
    maxOverdueReminders: { type: Number, default: 10, min: 0, max: 100 }, // 0 = keep reminding until the book is returned

    // ----- complaints (to the student's department) -----
    complaintAfterOverdueDays: { type: Number, default: 2, min: 1, max: 365 }, // the student's department (HOD) is told (in-app) this many days after the due day
    principalAfterOverdueDays: { type: Number, default: 30, min: 1, max: 730 }, // no longer used: the principal gets no library notifications (kept so old saved rules still load)

    // ----- reservations -----
    reservationHoldDays: { type: Number, default: 2, min: 1, max: 30 }, // how long a returned copy waits for the student who reserved it
    maxReservationsPerStudent: { type: Number, default: 3, min: 1, max: 20 },

    // Categories the librarian created (books may also use any category already in the catalogue).
    categories: { type: [{ type: String, trim: true, maxlength: 80 }], default: [] },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

libraryRulesSchema.statics.getRules = async function () {
  let doc = await this.findOne({ key: 'global' });
  if (!doc) {
    try {
      doc = await this.create({ key: 'global' });
    } catch (err) {
      if (err.code !== 11000) throw err; // two requests created it at the same time: read the winner
      doc = await this.findOne({ key: 'global' });
    }
  }
  // One-time move from the older defaults (7 or 3 days) to the 2-day department notification. Rules that somebody saved on purpose (updatedBy is set) are never touched.
  if (doc && [3, 7].includes(doc.complaintAfterOverdueDays) && !doc.updatedBy) {
    await this.updateOne({ _id: doc._id, complaintAfterOverdueDays: doc.complaintAfterOverdueDays, updatedBy: { $exists: false } }, { complaintAfterOverdueDays: 2 });
    doc.complaintAfterOverdueDays = 2;
  }
  return doc;
};

export default mongoose.model('LibraryRules', libraryRulesSchema);
