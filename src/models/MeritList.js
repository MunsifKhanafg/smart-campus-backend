import mongoose from 'mongoose';

// A ranked list of applicants for one department (and optionally one programme) in one intake.
// The server builds it from the marks percentage of the applications. Nobody types a rank by hand.
// Only a PUBLISHED list is visible on the public website.
const entrySchema = new mongoose.Schema(
  {
    application: { type: mongoose.Schema.Types.ObjectId, ref: 'AdmissionApplication', required: true },
    applicationNumber: { type: String, required: true },
    name: { type: String, required: true },
    fatherName: { type: String, default: '' },
    obtainedMarks: Number,
    totalMarks: Number,
    percentage: { type: Number, required: true },
    rank: { type: Number, required: true },
    result: { type: String, enum: ['selected', 'waiting'], required: true }, // selected = inside the number of seats
  },
  { _id: false }
);

const meritListSchema = new mongoose.Schema(
  {
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    program: { type: mongoose.Schema.Types.ObjectId, ref: 'Program', default: null },
    programName: { type: String, trim: true, default: '' },
    intake: { type: String, trim: true, default: '' },
    seats: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ['draft', 'published'], default: 'draft', index: true },
    entries: [entrySchema],
    generatedAt: Date,
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    publishedAt: Date,
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// One list per department + programme + intake. Generating again replaces the entries of the same list.
meritListSchema.index({ department: 1, program: 1, intake: 1 }, { unique: true });
meritListSchema.index({ 'entries.application': 1 });

export default mongoose.model('MeritList', meritListSchema);
