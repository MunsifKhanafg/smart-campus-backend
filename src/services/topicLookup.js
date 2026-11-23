import CourseTopic from '../models/CourseTopic.js';
import Course from '../models/Course.js';
import MaterialChunk from '../models/MaterialChunk.js';

// "Tell me about <topic title>": the assistant first finds the topics of the course whose title the question mentions, and states the FACTS
// (date, day, class number, teacher, taught or not yet, description, files) from the database. These facts are never written by the AI.
// Then the AI explains the topic from the notes (see aiService.js). A student never gets the description or the files of a topic that
// has not reached its teaching date, the same rule as on the Topics page.

const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'when', 'who', 'about', 'tell', 'explain', 'topic', 'class', 'taught', 'teach', 'teacher', 'does', 'will', 'was', 'were', 'give', 'show', 'info', 'information', 'details', 'detail', 'please', 'this', 'that', 'from', 'are', 'how', 'why', 'which', 'date', 'day', 'on']);

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => norm(s).split(' ').filter((w) => w.length >= 3 && !STOP.has(w));

const dmy = (d) => { const x = new Date(d); return `${x.getUTCDate()}/${x.getUTCMonth() + 1}/${x.getUTCFullYear()}`; };
const weekday = (d) => new Date(d).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });

// Share of the title's words that the question contains (a word counts when either starts with the other, so "transmission" matches "transmissions").
const coverage = (title, question) => {
  const t = words(title);
  if (!t.length) return 0;
  const q = words(question);
  const hit = t.filter((w) => q.some((x) => x === w || (w.length >= 5 && x.length >= 5 && (x.startsWith(w) || w.startsWith(x))))).length;
  return hit / t.length;
};

// The course contents text (one long outline) as a list of items, split the same way as the contents list on the course page.
const outlineItems = (text) => {
  const items = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:\d+[.)]|[-\u2022*])\s*/, '').trim();
    if (!line) continue;
    if ((line.match(/,/g) || []).length >= 3) items.push(...line.split(/\s*[,;]\s*/).map((s) => s.trim()).filter(Boolean));
    else items.push(line);
  }
  return items;
};

// A title that is in the course contents but has no planned topic (no date yet): say what it is and who teaches the course.
const outlineInfo = (course, question) => {
  const items = outlineItems(course?.outline);
  const nq = norm(question);
  const hits = items
    .map((title, i) => ({ title, no: i + 1, score: nq.includes(norm(title)) ? 1 : coverage(title, question) }))
    .filter((x) => x.score >= 0.75 && words(x.title).length >= 1)
    .sort((a, b) => b.score - a.score || norm(b.title).length - norm(a.title).length)
    .slice(0, 3);
  if (!hits.length) return { text: '', topicIds: [] };
  return {
    text: hits
      .map((h) => [`Course content ${h.no} of ${items.length}: ${h.title}`, `Course: ${course.code} - ${course.title}`, `Teacher: ${course.teacher?.name || 'not assigned yet'}`, 'This item is in the course contents, but your teacher has not planned it on a teaching date yet. Ask your teacher when it will be taught.'].join('\n'))
      .join('\n\n'),
    topicIds: [],
  };
};

export const findTopicInfo = async ({ courseIds, question, includeUnreleased = false, now = new Date() }) => {
  const empty = { text: '', topicIds: [] };
  if (courseIds.length !== 1) return empty; // topic facts are given for one course at a time
  const topics = await CourseTopic.find({ course: courseIds[0] }).select('title description scheduledDate availableUntil materials sequence').sort({ scheduledDate: 1, sequence: 1 }).lean();

  const nq = norm(question);
  const scored = topics
    .map((t) => ({ t, score: nq.includes(norm(t.title)) ? 1 : coverage(t.title, question) }))
    .filter((x) => x.score >= 0.75 && words(x.t.title).length >= 1)
    .sort((a, b) => b.score - a.score || norm(b.t.title).length - norm(a.t.title).length)
    .slice(0, 3);
  const course = await Course.findById(courseIds[0]).select('code title teacher outline').populate('teacher', 'name').lean();
  if (!scored.length) return outlineInfo(course, question); // no planned topic with that title: try the course contents list
  const classNo = new Map([...new Set(topics.map((t) => dmy(t.scheduledDate)))].map((d, i) => [d, i + 1]));
  const sameDay = (t) => topics.filter((x) => dmy(x.scheduledDate) === dmy(t.scheduledDate));

  const blocks = scored.map(({ t }) => {
    const released = new Date(t.scheduledDate) <= now;
    const visible = released || includeUnreleased;
    const mates = sameDay(t);
    const lines = [
      `Topic ${t.sequence || ''}: ${t.title}`.replace('Topic : ', 'Topic: '),
      `${released ? 'Taught on' : 'Will be taught on'}: ${weekday(t.scheduledDate)}, ${dmy(t.scheduledDate)} (Class ${classNo.get(dmy(t.scheduledDate))})`,
      `Teacher: ${course?.teacher?.name || 'not assigned yet'}`,
      `Course: ${course?.code} - ${course?.title}`,
    ];
    if (mates.length > 1) lines.push(`Taught in the same class: ${mates.filter((x) => String(x._id) !== String(t._id)).map((x) => x.title).join('; ')}`);
    if (visible) {
      if (t.description) lines.push(`Description: ${t.description}`);
      if (t.materials?.length) lines.push(`Files: ${t.materials.map((m) => m.originalName).join(', ')}`);
    } else {
      lines.push('Its description, notes and files unlock on the teaching date.');
    }
    return lines.join('\n');
  });
  return { text: blocks.join('\n\n'), topicIds: scored.filter(({ t }) => includeUnreleased || new Date(t.scheduledDate) <= now).map(({ t }) => t._id) };
};

// The first passages of the matched topics' own files, so the explanation is about THAT topic even when the question is just its title.
export const retrieveTopicChunks = ({ topicIds, includeUnreleased = false, now = new Date(), limit = 4 }) => {
  if (!topicIds.length) return [];
  const filter = { topic: { $in: topicIds } };
  if (!includeUnreleased) {
    filter.releaseDate = { $lte: now };
    filter.$or = [{ availableUntil: null }, { availableUntil: { $gte: now } }];
  }
  return MaterialChunk.find(filter).sort({ chunkIndex: 1 }).limit(limit).populate('course', 'code title').populate('topic', 'title').lean();
};
