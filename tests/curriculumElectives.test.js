import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCurriculumRules, normalizeDraft } from '../src/services/curriculumService.js';

// A scheme of studies where semesters 7 and 8 have 5 subjects each (two of them are elective SLOTS),
// followed by pages that list MANY elective options "for the 7th/8th semester".
// Those later lists must never be counted as subjects of the semester.
const DOC = `
Proposed Revised Scheme of Studies for BS (CS)
Semester VII
CS6701 Technical and Scientific Writing 3(3+0)
CS6702 FYP - I 3(0+3)
BA565 Entrepreneurship 3(3+0)
CS67XX Specialization Elective - I 3(3+0)
CS67XX Specialization Elective - II 3(3+0)
Total Credit Hours 15
Semester VIII
CS6801 Natural Language Processing 3(3+0)
CS6802 Professional Practices 3(3+0)
CS6803 FYP - II 3(0+3)
CS68XX Specialization Elective - III 3(3+0)
CS68XX Specialization Elective - IV 3(3+0)
Total Credit Hours 15

6. 7th Semester Specializations Elective Courses
CS6711 Machine Learning 3(3+0)
CS6712 Deep Learning 3(3+0)
CS6713 Data Mining 3(3+0)
CS6714 Big Data Analytics 3(3+0)
CS6715 Cloud Computing 3(3+0)
CS6716 Cyber Security 3(3+0)
Semester VII
CS6717 Computer Vision 3(3+0)
CS6718 Robotics 3(3+0)
7. 8th Semester Specializations Elective Courses
CS6811 Reinforcement Learning 3(3+0)
CS6812 Speech Processing 3(3+0)
Semester VIII
CS6813 Blockchain 3(3+0)
`;

test('later elective lists never add subjects to semesters 7 and 8', () => {
  const { programs } = normalizeDraft(parseCurriculumRules(DOC));
  const sems = Object.fromEntries(programs[0].semesters.map((s) => [s.number, s.subjects.map((x) => x.code)]));
  assert.equal(sems[7].length, 5);
  assert.equal(sems[8].length, 5);
  assert.ok(sems[7].includes('CS-6701') && sems[7].includes('CS67XX-II'));
  assert.ok(!sems[7].includes('CS-6711') && !sems[7].includes('CS-6717'));
  assert.ok(!sems[8].includes('CS-6811') && !sems[8].includes('CS-6813'));
});
