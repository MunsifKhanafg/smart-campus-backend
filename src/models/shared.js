import mongoose from 'mongoose';

// Describes a file stored on disk (uploads/private/<category>/<storedName>). Only this small record lives in MongoDB.
export const fileSchema = new mongoose.Schema(
  {
    originalName: { type: String, required: true },
    storedName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    indexed: { type: Boolean, default: false }, // course materials only: text was extracted for the AI assistant
  },
  { _id: false }
);
