import mongoose from 'mongoose';

const aiConversationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
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
