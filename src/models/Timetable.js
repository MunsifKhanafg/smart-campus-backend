import mongoose from 'mongoose';
import { TIMETABLE_STATUS } from '../config/constants.js';

// One timetable per semester. It holds the draft/published state; the individual classes are TimetableSlot rows.
const timetableSchema = new mongoose.Schema(
  {
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true, unique: true },
    status: { type: String, enum: Object.values(TIMETABLE_STATUS), default: TIMETABLE_STATUS.DRAFT, index: true },
    publishedAt: Date,
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    version: { type: Number, default: 0 }, // bumps on every change, useful for "timetable updated" notices
  },
  { timestamps: true }
);

// The days a subject meets decide the teaching days of its course contents, so publishing or changing a timetable re-dates them
// (services/teachingCalendarService.js). A failure there must never make the timetable save fail.
timetableSchema.post('save', async (doc) => {
  try {
    const { recalcForExam } = await import('../services/teachingCalendarService.js');
    await recalcForExam({ semester: doc.semester });
  } catch (err) {
    console.error('Schedule recalculation after a timetable change failed:', err.message);
  }
});

export default mongoose.model('Timetable', timetableSchema);
