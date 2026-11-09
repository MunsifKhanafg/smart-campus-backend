import mongoose from 'mongoose';

// The principal asks to ADD (save) or DELETE a curriculum programme. Nothing changes until the HOD of that
// department approves. The HOD can also reject, with a message. One request per programme.
const requestSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['add', 'delete'], required: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    programName: { type: String, required: true, trim: true, maxlength: 150 },

    // add: the full programme to be saved (same shape as a Program), taken from the reviewed draft
    snapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    import: { type: mongoose.Schema.Types.ObjectId, ref: 'CurriculumImport', default: null },
    // delete: the programme to be removed, and what to do with classes made from it
    program: { type: mongoose.Schema.Types.ObjectId, ref: 'Program', default: null },
    deleteMode: { type: String, enum: ['remove', 'keep'], default: 'remove' },

    // numbers shown to the HOD so the decision is informed (subjects, classes that would disappear ...)
    summary: { type: mongoose.Schema.Types.Mixed, default: {} },

    status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending', index: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    requestMessage: { type: String, required: true, trim: true, maxlength: 1000 },

    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decisionMessage: { type: String, trim: true, maxlength: 1000, default: '' },
    decidedAt: Date,
    result: { type: mongoose.Schema.Types.Mixed, default: null }, // what happened when it was applied
  },
  { timestamps: true }
);

requestSchema.index({ department: 1, status: 1, createdAt: -1 });

export default mongoose.model('CurriculumRequest', requestSchema);
