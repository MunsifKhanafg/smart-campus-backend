import MaterialChunk from '../models/MaterialChunk.js';
import { extractText, chunkText } from './textExtractService.js';
import { storedPath } from '../middleware/upload.js';

// Reads an uploaded material, cuts it into passages and stores them for the AI assistant.
// Never throws: a file we cannot read simply is not searchable by the assistant (it is still downloadable).
export const indexMaterialFile = async ({ topic, file }) => {
  try {
    const text = await extractText(storedPath('materials', file.storedName), file.mimeType);
    const chunks = chunkText(text);
    if (!chunks.length) return false;
    await MaterialChunk.insertMany(
      chunks.map((t, i) => ({
        course: topic.course,
        department: topic.department,
        topic: topic._id,
        fileName: file.originalName,
        storedName: file.storedName,
        chunkIndex: i,
        text: t,
        releaseDate: topic.scheduledDate,
        availableUntil: topic.availableUntil || null,
      }))
    );
    return true;
  } catch (err) {
    console.error('Material indexing failed:', err.message);
    return false;
  }
};

export const removeChunksForFile = (storedName) => MaterialChunk.deleteMany({ storedName });
export const removeChunksForTopic = (topicId) => MaterialChunk.deleteMany({ topic: topicId });

// When the teacher reschedules a topic, its passages follow the new release date.
export const syncTopicRelease = (topic) =>
  MaterialChunk.updateMany({ topic: topic._id }, { releaseDate: topic.scheduledDate, availableUntil: topic.availableUntil || null });

// Keyword retrieval with MongoDB's text index. Only passages that are already released to students are returned.
export const retrieveChunks = async ({ courseIds, question, limit = 6, now = new Date(), includeUnreleased = false }) => {
  const filter = { $text: { $search: question }, course: { $in: courseIds } };
  if (!includeUnreleased) {
    filter.releaseDate = { $lte: now };
    filter.$or = [{ availableUntil: null }, { availableUntil: { $gte: now } }];
  }
  return MaterialChunk.find(filter, { score: { $meta: 'textScore' } })
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
    .populate('course', 'code title')
    .populate('topic', 'title')
    .lean();
};
