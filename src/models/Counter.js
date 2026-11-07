import mongoose from 'mongoose';

// Atomic sequence numbers (receipt numbers, etc.). $inc on one document is safe even with many requests at once.
const counterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  seq: { type: Number, default: 0 },
});

counterSchema.statics.next = async function (key) {
  const doc = await this.findOneAndUpdate({ key }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return doc.seq;
};

export default mongoose.model('Counter', counterSchema);
