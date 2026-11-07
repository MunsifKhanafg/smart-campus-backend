import mongoose from 'mongoose';

// A small passage of text extracted from an uploaded course material. The AI assistant searches these chunks (RAG).
// releaseDate is copied from the topic, so the assistant can never "leak" a topic that is not yet released to students.
const materialChunkSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
    topic: { type: mongoose.Schema.Types.ObjectId, ref: 'CourseTopic', required: true, index: true },
    fileName: { type: String, required: true },
    storedName: { type: String, required: true, index: true },
    chunkIndex: { type: Number, required: true },
    text: { type: String, required: true },
    releaseDate: { type: Date, required: true },
    availableUntil: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

materialChunkSchema.index({ text: 'text' });

export default mongoose.model('MaterialChunk', materialChunkSchema);
