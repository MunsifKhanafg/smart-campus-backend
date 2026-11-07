import mongoose from 'mongoose';

// Detailed Marks Certificate record. The PDF itself is generated on demand from the Result (so it always shows the
// current university name and logo). This record carries the certificate number and a verification code.
const dmcSchema = new mongoose.Schema(
  {
    result: { type: mongoose.Schema.Types.ObjectId, ref: 'Result', required: true, unique: true },
    examination: { type: mongoose.Schema.Types.ObjectId, ref: 'Examination', required: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    dmcNumber: { type: String, required: true, unique: true },
    verificationCode: { type: String, required: true },
    issuedAt: { type: Date, default: Date.now },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export default mongoose.model('DMC', dmcSchema);
