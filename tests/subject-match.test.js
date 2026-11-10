import test from 'node:test';
import assert from 'node:assert/strict';
import { teacherMatchesSubject as fits, subjectKeys } from '../../client/src/components/subjectMatch.mjs';

// ---------- the common subjects every department teaches ----------
test('an English teacher fits every English subject', () => {
  for (const title of ['English', 'Functional English', 'English Composition and Comprehension', 'Technical Report Writing', 'Communication Skills']) {
    assert.equal(fits(title, ['English']), true, title);
  }
});

test('an English teacher does not fit other subjects (also not "Data Communication")', () => {
  for (const title of ['Islamic Studies', 'Calculus and Analytical Geometry', 'Data Communication and Networking', 'Pakistan Studies']) {
    assert.equal(fits(title, ['English']), false, title);
  }
});

test('a Maths teacher fits the whole maths family, however it is spelled', () => {
  for (const title of ['Calculus and Analytical Geometry', 'Applied Mathematics', 'Linear Algebra', 'Probability and Statistics', 'Discrete Structures']) {
    assert.equal(fits(title, ['Mathematics']), true, title);
    assert.equal(fits(title, ['Maths']), true, title);
  }
  assert.equal(fits('English', ['Mathematics']), false);
});

test('Islamiyat and Pak Studies are matched by their other names', () => {
  assert.equal(fits('Islamic Studies', ['Islamiyat']), true);
  assert.equal(fits('Islamiyat', ['Islamic Studies']), true);
  assert.equal(fits('Islamic Studies', ['Islamiat']), true);
  assert.equal(fits('Pakistan Studies', ['Pak Studies']), true);
  assert.equal(fits('Islamic Studies', ['Pak Studies']), false);
  assert.equal(fits('Pakistan Studies', ['Islamiyat']), false);
});

// ---------- department subjects ----------
test('a teacher of a specific subject fits its longer and shorter names, but not a similar-sounding one', () => {
  assert.equal(fits('Data Structures and Algorithms', ['Data Structures']), true);
  assert.equal(fits('Database Management Systems', ['Database Systems']), true);
  assert.equal(fits('Programming Fundamentals', ['Programming']), true);
  assert.equal(fits('Database Systems', ['Data Structures']), false);
  assert.equal(fits('Operating Systems', ['Database Systems']), false);
});

// ---------- how people type ----------
test('capital letters, punctuation and plurals do not matter', () => {
  assert.equal(fits('ENGLISH!!', ['english']), true);
  assert.equal(fits('Data Structure', ['  data   STRUCTURES ']), true);
});

test('a teacher with several subjects fits when any one of them fits', () => {
  assert.equal(fits('Pakistan Studies', ['English', 'Pak Studies']), true);
  assert.equal(fits('Calculus', ['English', 'Pak Studies']), false);
});

// ---------- nothing to compare ----------
test('no subjects listed, no subject name, or only filler words never match', () => {
  assert.equal(fits('English', []), false);
  assert.equal(fits('English'), false);
  assert.equal(fits('English', undefined), false);
  assert.equal(fits('', ['English']), false);
  assert.equal(fits('Introduction to', ['English']), false);
  assert.equal(fits('English', ['Introduction to']), false);
});

// ---------- the building block ----------
test('subjectKeys reduces a name to its important words in one spelling', () => {
  assert.deepEqual([...subjectKeys('Pak Studies')], ['pakistan']);
  assert.deepEqual([...subjectKeys('Pakistan Studies')], ['pakistan']);
  assert.deepEqual([...subjectKeys('Probability and Statistics')], ['math']);
  assert.deepEqual([...subjectKeys('Calculus and Analytical Geometry')].sort(), ['analytical', 'math']);
  assert.deepEqual([...subjectKeys('Communication Skills')], ['english']);
  assert.deepEqual([...subjectKeys('')], []);
});
