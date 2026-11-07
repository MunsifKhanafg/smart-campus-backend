import { round2 } from '../utils/oid.js';

// ===== Official marks logic. Plain code only: AI is NEVER involved in marks, grades or pass/fail. =====

// Picks the grade rule for a percentage: the highest rule whose minimum is reached.
export const gradeFor = (percentage, rules) => {
  const sorted = [...rules].sort((a, b) => b.minPercentage - a.minPercentage);
  return sorted.find((r) => percentage >= r.minPercentage) || sorted[sorted.length - 1];
};

// subjects: [{ maxMarks, passingMarks, obtained, absent }]
// settings: { gradingRules, passingPercentage }
// A student passes only if the overall percentage reaches the university minimum AND every paper reaches its passing marks.
export const computeResult = (subjects, settings) => {
  const rows = subjects.map((s) => {
    const obtained = s.absent ? 0 : s.obtained ?? 0;
    return { ...s, obtained, passed: !s.absent && obtained >= s.passingMarks };
  });
  const totalMax = rows.reduce((sum, s) => sum + s.maxMarks, 0);
  const totalObtained = rows.reduce((sum, s) => sum + s.obtained, 0);
  const percentage = totalMax ? round2((totalObtained / totalMax) * 100) : 0;

  const outcome = percentage >= settings.passingPercentage && rows.every((s) => s.passed) ? 'pass' : 'fail';
  const lowest = [...settings.gradingRules].sort((a, b) => a.minPercentage - b.minPercentage)[0];
  const rule = outcome === 'pass' ? gradeFor(percentage, settings.gradingRules) : lowest; // a failed student gets the lowest grade
  return { subjects: rows, totalMax, totalObtained, percentage, grade: rule.grade, gpaPoints: outcome === 'pass' ? rule.gpaPoints : 0, outcome };
};
