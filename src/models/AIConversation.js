import mongoose from 'mongoose';

const aiConversationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Only chats about one course's materials have a course. General academic chats do not.
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', index: true },
    // How the chat started: general, explain, solve, quiz, ... or "course" (answers from the course materials).
    mode: { type: String, default: 'general', maxlength: 20 },
    title: { type: String, maxlength: 120 },
    messages: [
      {
        role: { type: String, enum: ['user', 'assistant'], required: true },
        content: { type: String, required: true, maxlength: 8000 },
        sources: [{ topic: String, fileName: String, _id: false }],
        grounded: Boolean, // false = no course material matched the question
        at: { type: Date, default: Date.now },
        _id: false,
      },
    ],
  },
  { timestamps: true }
);

export default mongoose.model('AIConversation', aiConversationSchema);
