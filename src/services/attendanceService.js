import Attendance from '../models/Attendance.js';
import { oid, oids, round2 } from '../utils/oid.js';

// Percentage = classes attended / classes held. Approved leave counts as attended when the university allows it.
// Returns null when no class has been held yet, so "no data" is never confused with "0%".
export const attendancePercent = ({ present = 0, absent = 0, leave = 0 }, allowLeaveAsPresent = true) => {
  const total = present + absent + leave;
  if (!total) return null;
  const attended = present + (allowLeaveAsPresent ? leave : 0);
  return round2((attended / total) * 100);
};

// Counts per (course, student). One aggregation instead of loading thousands of documents.
export const attendanceCounts = async ({ courseIds, studentIds }) => {
  const match = { course: { $in: oids(courseIds) } };
  const pipeline = [{ $match: match }, { $unwind: '$records' }];
  if (studentIds) pipeline.push({ $match: { 'records.student': { $in: oids(studentIds) } } });
  pipeline.push({
    $group: {
      _id: { course: '$course', student: '$records.student' },
      present: { $sum: { $cond: [{ $eq: ['$records.status', 'present'] }, 1, 0] } },
      absent: { $sum: { $cond: [{ $eq: ['$records.status', 'absent'] }, 1, 0] } },
      leave: { $sum: { $cond: [{ $eq: ['$records.status', 'leave'] }, 1, 0] } },
    },
  });
  const rows = await Attendance.aggregate(pipeline);
  const map = new Map();
  for (const r of rows) map.set(`${r._id.course}:${r._id.student}`, { present: r.present, absent: r.absent, leave: r.leave });
  return map;
};

export const emptyCounts = () => ({ present: 0, absent: 0, leave: 0 });

export const sessionsHeld = (courseId) => Attendance.countDocuments({ course: oid(courseId) });
