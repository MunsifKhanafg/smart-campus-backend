import test from 'node:test';
import assert from 'node:assert/strict';
import { portalState, calcPercentage, rankApplications, DEFAULT_REQUIRED_DOCUMENTS } from '../src/services/applicationService.js';
import { flatten } from '../src/utils/flatten.js';

const at = (iso) => Date.parse(iso);
const portal = (admissionPortal) => ({ admissionPortal });

// ---------- opening and closing dates ----------
test('admissions are "off" until the University Head switches them on', () => {
  const s = portalState(portal({ open: false }), at('2026-06-10T10:00:00Z'));
  assert.equal(s.status, 'off');
  assert.equal(s.open, false);
  assert.match(s.closedReason, /not open/);
});

test('switched on with no dates means open', () => {
  const s = portalState(portal({ open: true }), at('2026-06-10T10:00:00Z'));
  assert.equal(s.status, 'open');
  assert.equal(s.open, true);
  assert.equal(s.closedReason, '');
});

test('before the opening date the portal is "upcoming" and says when it opens', () => {
  const s = portalState(portal({ open: true, startDate: '2026-06-01' }), at('2026-05-31T12:00:00Z'));
  assert.equal(s.status, 'upcoming');
  assert.equal(s.open, false);
  assert.match(s.closedReason, /1 June 2026/);
});

test('the opening day itself is already open (from the start of that day)', () => {
  const s = portalState(portal({ open: true, startDate: '2026-06-01' }), at('2026-06-01T00:00:00Z'));
  assert.equal(s.status, 'open');
});

test('the closing day itself still counts, applications close when that day ends', () => {
  const settings = portal({ open: true, startDate: '2026-06-01', deadline: '2026-06-30' });
  assert.equal(portalState(settings, at('2026-06-30T23:59:00Z')).status, 'open');
  const closed = portalState(settings, at('2026-07-01T00:00:00Z'));
  assert.equal(closed.status, 'closed');
  assert.equal(closed.open, false);
  assert.match(closed.closedReason, /30 June 2026/);
});

test('the master switch beats the dates: switched off inside the date range is still closed', () => {
  const s = portalState(portal({ open: false, startDate: '2026-06-01', deadline: '2026-06-30' }), at('2026-06-15T00:00:00Z'));
  assert.equal(s.status, 'off');
});

test('the public state carries the dates, intake, link and the document list', () => {
  const s = portalState(portal({ open: true, intakeName: 'Fall 2026', startDate: '2026-06-01', deadline: '2026-06-30', externalUrl: 'https://apply.example.edu', requiredDocuments: ['CNIC'] }), at('2026-06-10T00:00:00Z'));
  assert.equal(s.intakeName, 'Fall 2026');
  assert.equal(s.externalUrl, 'https://apply.example.edu');
  assert.deepEqual(s.requiredDocuments, ['CNIC']);
  assert.equal(s.meritListPublished, false);
});

test('an empty document list falls back to the default list', () => {
  assert.deepEqual(portalState(portal({ open: true, requiredDocuments: [] })).requiredDocuments, DEFAULT_REQUIRED_DOCUMENTS);
  assert.deepEqual(portalState({}).requiredDocuments, DEFAULT_REQUIRED_DOCUMENTS);
});

// ---------- percentage ----------
test('the percentage is calculated from the marks and rounded to two decimals', () => {
  assert.equal(calcPercentage(450, 600), 75);
  assert.equal(calcPercentage(1033, 1100), 93.91);
  assert.equal(calcPercentage(1, 3), 33.33);
  assert.equal(calcPercentage('900', '1100'), 81.82); // form values arrive as text
});

// ---------- merit ranking ----------
const app = (id, percentage, createdAt, extra = {}) => ({
  _id: id,
  applicationNumber: `APP-${id}`,
  department: 'D1',
  program: 'P1',
  intake: 'Fall 2026',
  education: { percentage },
  createdAt: new Date(createdAt),
  ...extra,
});

test('a higher percentage ranks first', () => {
  const ranks = rankApplications([app('a', 70, '2026-06-01'), app('b', 90, '2026-06-02'), app('c', 80, '2026-06-03')]);
  assert.equal(ranks.get('b'), 1);
  assert.equal(ranks.get('c'), 2);
  assert.equal(ranks.get('a'), 3);
});

test('equal percentages are ranked by who applied first, so the order is never random', () => {
  const ranks = rankApplications([app('late', 80, '2026-06-05'), app('early', 80, '2026-06-01')]);
  assert.equal(ranks.get('early'), 1);
  assert.equal(ranks.get('late'), 2);
});

test('each department, programme and intake has its own merit list starting at rank 1', () => {
  const ranks = rankApplications([
    app('cs1', 90, '2026-06-01'),
    app('cs2', 60, '2026-06-01'),
    app('ee1', 50, '2026-06-01', { department: 'D2' }),
    app('se1', 55, '2026-06-01', { program: 'P2' }),
    app('spring1', 40, '2026-06-01', { intake: 'Spring 2027' }),
  ]);
  assert.equal(ranks.get('cs1'), 1);
  assert.equal(ranks.get('cs2'), 2);
  assert.equal(ranks.get('ee1'), 1);
  assert.equal(ranks.get('se1'), 1);
  assert.equal(ranks.get('spring1'), 1);
});

test('a missing percentage counts as zero and an empty list gives an empty ranking', () => {
  const ranks = rankApplications([app('x', undefined, '2026-06-01'), app('y', 10, '2026-06-02')]);
  assert.equal(ranks.get('y'), 1);
  assert.equal(ranks.get('x'), 2);
  assert.equal(rankApplications([]).size, 0);
});

// ---------- settings are saved with dotted paths: dates must survive flatten ----------
test('flatten keeps a Date as a value (it used to be dropped silently)', () => {
  const day = new Date('2026-06-01T00:00:00Z');
  const flat = flatten({ admissionPortal: { open: true, startDate: day, deadline: null, requiredDocuments: ['CNIC', 'Photo'] } });
  assert.equal(flat['admissionPortal.startDate'], day);
  assert.equal(flat['admissionPortal.deadline'], null);
  assert.deepEqual(flat['admissionPortal.requiredDocuments'], ['CNIC', 'Photo']);
  assert.equal(flat['admissionPortal.open'], true);
  assert.equal('admissionPortal' in flat, false);
});
