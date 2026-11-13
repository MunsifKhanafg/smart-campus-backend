import mongoose from 'mongoose';

// The history of the text messages (SMS) the library sent to students, and whether each one went out. It has two jobs:
//  1. The librarian can see who was texted, when, and why a message did not go (no phone number, SMS not configured ...).
//  2. It is the "already sent" memory of the reminder job. A reminder is claimed by inserting a row with the unique key (loan + kind + key),
//     so the same reminder can never be sent twice, even if the job runs often or on two servers. When the book comes back the job
//     simply stops finding the loan, so the reminders stop by themselves.
const libraryMessageSchema = new mongoose.Schema(
  {
    loan: { type: mongoose.Schema.Types.ObjectId, ref: 'LibraryLoan', default: null, index: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // issued | before_due | due_today | overdue | returned | lost | reservation_ready | reservation_expired | fine
    kind: { type: String, required: true, maxlength: 30 },
    key: { type: String, default: '', maxlength: 40 }, // makes the reminder unique inside a loan, e.g. "b3" (3 days before), "o2" (second overdue slot)
    // pending (claimed, being sent) | sent | no_phone | not_configured | disabled (turned off in Library > Rules) | failed
    status: { type: String, default: 'pending', maxlength: 20, index: true },
    text: { type: String, maxlength: 400, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

libraryMessageSchema.index({ loan: 1, kind: 1, key: 1 }, { unique: true, partialFilterExpression: { loan: { $type: 'objectId' } }, name: 'one_message_per_loan_kind_key' });
libraryMessageSchema.index({ createdAt: -1 });

export default mongoose.model('LibraryMessage', libraryMessageSchema);
