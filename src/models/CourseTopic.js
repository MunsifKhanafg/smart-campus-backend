import mongoose from 'mongoose';
import { fileSchema } from './shared.js';

// One teaching topic of a course. Students see its title and date early, but the description and
// materials stay hidden until scheduledDate arrives (see topicController.shapeForStudent).
const courseTopicSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true, index: true },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 5000, default: '' },
    scheduledDate: { type: Date, required: true, index: true },
    // Position of the topic in the course (1, 2, 3 ...). Set by the scheduler; see services/teachingCalendarService.js.
    sequence: { type: Number, default: 0 },
    // true = the date was chosen by the smart scheduler from the academic calendar, so it moves automatically when a holiday,
    // an examination, a vacation or the semester dates change. A date typed by the teacher (false) is "pinned" and never moved.
    autoScheduled: { type: Boolean, default: false },
    // Optional access policy: after this date students lose access (default null = stays available for revision).
    availableUntil: { type: Date, default: null },
    materials: [fileSchema],
    // Optional link to an assignment / activity that belongs to this topic.
    relatedAssignment: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

courseTopicSchema.index({ course: 1, scheduledDate: 1 });

export default mongoose.model('CourseTopic', courseTopicSchema);
