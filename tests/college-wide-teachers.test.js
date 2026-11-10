import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import User from '../src/models/User.js';
import { teachesIn, permittedDepartments, collegeTeacherQuery, eligibleTeacherQuery } from '../src/services/teacherService.js';

const id = () => new mongoose.Types.ObjectId();
const CS = id();
const SE = id();
const MATH = id();
const base = { name: 'Test Person', email: 'person@example.edu', password: 'Password123', role: 'teacher' };

test('a teacher needs a home department, unless they teach in every department', async () => {
  await assert.rejects(new User(base).validate(), /Department is required/);
  await assert.doesNotReject(new User({ ...base, department: CS }).validate());
  // A common-subject teacher (English, Mathematics, Islamiat...) belongs to the whole college: no department needed.
  await assert.doesNotReject(new User({ ...base, allDepartments: true }).validate());
});

test('an HOD and a student always need a department, even with the common-subject flag', async () => {
  await assert.rejects(new User({ ...base, role: 'hod', allDepartments: true }).validate(), /Department is required/);
  await assert.rejects(new User({ ...base, role: 'student', allDepartments: true }).validate(), /Department is required/);
});

test('a finance officer never needs a department', async () => {
  await assert.doesNotReject(new User({ ...base, role: 'finance_officer' }).validate());
});

test('teachesIn: home department, extra departments, and "every department"', () => {
  const own = { department: CS };
  assert.equal(teachesIn(own, CS), true);
  assert.equal(teachesIn(own, SE), false);

  const shared = { department: CS, extraDepartments: [SE] };
  assert.equal(teachesIn(shared, SE), true);
  assert.equal(teachesIn(shared, MATH), false);

  const common = { allDepartments: true }; // no home department at all
  assert.equal(teachesIn(common, CS), true);
  assert.equal(teachesIn(common, MATH), true);
});

test('teachesIn also works with populated departments (as the screens receive them)', () => {
  const t = { department: { _id: CS, code: 'CS' }, extraDepartments: [{ _id: SE, code: 'SE' }] };
  assert.equal(teachesIn(t, CS), true);
  assert.equal(teachesIn(t, SE), true);
  assert.equal(teachesIn(t, MATH), false);
});

test('permittedDepartments lists where a teacher may teach, for the picker', () => {
  const t = { department: { _id: CS, code: 'CS', name: 'Computer Science' }, extraDepartments: [{ _id: SE, code: 'SE', name: 'Software Engineering' }], allDepartments: false };
  const p = permittedDepartments(t);
  assert.equal(p.all, false);
  assert.deepEqual(p.list.map((d) => d.code), ['CS', 'SE']);
  assert.equal(p.list[0].home, true);
  assert.equal(p.list[1].home, false);

  const common = permittedDepartments({ allDepartments: true });
  assert.equal(common.all, true);
  assert.deepEqual(common.list, []); // no home department to show
});

test('collegeTeacherQuery returns every active teacher, eligibleTeacherQuery only those permitted in one department', () => {
  assert.deepEqual(collegeTeacherQuery().isActive, true);
  assert.equal(collegeTeacherQuery().$or, undefined); // nobody is filtered out by department
  const q = eligibleTeacherQuery(CS);
  assert.equal(q.isActive, true);
  assert.equal(q.$or.length, 3); // home department, extra departments, every department
  assert.ok(q.$or.some((c) => c.allDepartments === true));
});
