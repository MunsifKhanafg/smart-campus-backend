import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffDays, isDayKey, dueDayFrom, calcFine, loanBalance, lostPenalty, reminderDecision, escalationStage, makeCopyCode, makeBookId, normalizeCode, codeFromScan,
  smsText, detectIntents, keywordsOf, pageParams, maskPhone, buildXlsxFiles, xmlEscape, colName, escapeRegex,
} from '../src/services/libraryRules.js';

const rules = { reminderBeforeDays: [3, 1], remindOnDueDay: true, overdueReminderEveryDays: 2, maxOverdueReminders: 3, complaintAfterOverdueDays: 7, principalAfterOverdueDays: 30 };

// ---------- days ----------
test('diffDays counts whole calendar days, also across a month end and a leap day', () => {
  assert.equal(diffDays('2026-03-10', '2026-03-08'), 2);
  assert.equal(diffDays('2026-03-08', '2026-03-10'), -2);
  assert.equal(diffDays('2026-03-01', '2026-02-28'), 1);
  assert.equal(diffDays('2028-03-01', '2028-02-28'), 2); // 2028 is a leap year
  assert.equal(diffDays('2026-01-01', '2026-01-01'), 0);
});

test('dueDayFrom adds the loan days', () => {
  assert.equal(dueDayFrom('2026-02-20', 14), '2026-03-06');
  assert.ok(isDayKey('2026-02-20'));
  assert.ok(!isDayKey('2026-2-20'));
  assert.ok(!isDayKey('2026-13-40'));
});

// ---------- fines ----------
test('no fine on the due day or before', () => {
  assert.deepEqual(calcFine({ dueDay: '2026-03-10', endDay: '2026-03-10', perDay: 10 }), { overdueDays: 0, chargeableDays: 0, amount: 0 });
  assert.equal(calcFine({ dueDay: '2026-03-10', endDay: '2026-03-01', perDay: 10 }).amount, 0);
});

test('the fine starts on the day after the due day', () => {
  assert.deepEqual(calcFine({ dueDay: '2026-03-10', endDay: '2026-03-11', perDay: 10 }), { overdueDays: 1, chargeableDays: 1, amount: 10 });
  assert.equal(calcFine({ dueDay: '2026-03-10', endDay: '2026-03-20', perDay: 10 }).amount, 100);
});

test('grace days delay the fine and the cap limits it', () => {
  const g = calcFine({ dueDay: '2026-03-10', endDay: '2026-03-14', perDay: 10, grace: 2 });
  assert.deepEqual(g, { overdueDays: 4, chargeableDays: 2, amount: 20 });
  assert.equal(calcFine({ dueDay: '2026-03-10', endDay: '2026-04-30', perDay: 10, cap: 250 }).amount, 250);
  assert.equal(calcFine({ dueDay: '2026-03-10', endDay: '2026-04-30', perDay: 10, cap: null }).amount, 510);
});

test('fines with cents are rounded to 2 decimals', () => {
  assert.equal(calcFine({ dueDay: '2026-03-10', endDay: '2026-03-13', perDay: 0.1 }).amount, 0.3);
});

test('the balance is charges minus payments and waivers, never negative', () => {
  const b = loanBalance({ fineAccrued: 100, penalties: [{ amount: 500 }], payments: [{ kind: 'payment', amount: 200 }, { kind: 'waiver', amount: 50 }] });
  assert.deepEqual(b, { fine: 100, penalty: 500, charged: 600, paid: 200, waived: 50, pending: 350 });
  assert.equal(loanBalance({ fineAccrued: 10, payments: [{ kind: 'payment', amount: 30 }] }).pending, 0);
  assert.equal(loanBalance({}).pending, 0);
});

test('a lost book costs price x multiplier + processing fee', () => {
  assert.equal(lostPenalty({ price: 800, multiplier: 1, processingFee: 100 }), 900);
  assert.equal(lostPenalty({ price: 800, multiplier: 2 }), 1600);
  assert.equal(lostPenalty({}), 0);
});

// ---------- reminders ----------
const base = { dueDay: '2026-03-20', issuedDay: '2026-03-06', rules };

test('a reminder goes out 3 days and 1 day before the due day, and on the due day', () => {
  assert.deepEqual(reminderDecision({ ...base, todayKey: '2026-03-17' }), { kind: 'before_due', key: 'b3', daysLeft: 3 });
  assert.deepEqual(reminderDecision({ ...base, todayKey: '2026-03-19' }), { kind: 'before_due', key: 'b1', daysLeft: 1 });
  assert.deepEqual(reminderDecision({ ...base, todayKey: '2026-03-20' }), { kind: 'due_today', key: 'd0', daysLeft: 0 });
});

test('after a pause the job sends ONE catch-up reminder, not a pile', () => {
  // 2 days left: the nearest configured day not yet passed is 3, so only "b3"
  assert.equal(reminderDecision({ ...base, todayKey: '2026-03-18' }).key, 'b3');
  // 10 days left: nothing yet (3 and 1 are both smaller than 10 days?). 3 >= 10 is false, so no candidate.
  assert.equal(reminderDecision({ ...base, todayKey: '2026-03-10' }), null);
});

test('a reminder day as long as the loan itself is skipped (the "issued" message covers it)', () => {
  const short = { dueDay: '2026-03-08', issuedDay: '2026-03-06', rules }; // 2-day loan
  assert.equal(reminderDecision({ ...short, todayKey: '2026-03-06' }).key, 'b1'); // 3 is skipped, 1 stays
  assert.equal(reminderDecision({ ...short, todayKey: '2026-03-06' }).daysLeft, 2);
});

test('overdue reminders repeat every N days and stop after the maximum', () => {
  const at = (d) => reminderDecision({ ...base, todayKey: d });
  assert.deepEqual(at('2026-03-21'), { kind: 'overdue', key: 'o0', overdueDays: 1 });
  assert.equal(at('2026-03-22').key, 'o0'); // same 2-day slot, already claimed -> the job skips it
  assert.equal(at('2026-03-23').key, 'o1');
  assert.equal(at('2026-03-25').key, 'o2');
  assert.equal(at('2026-03-27'), null); // 3 reminders are the maximum
});

test('maxOverdueReminders 0 means: keep reminding', () => {
  const unlimited = { ...rules, maxOverdueReminders: 0 };
  assert.equal(reminderDecision({ ...base, rules: unlimited, todayKey: '2026-06-01' }).kind, 'overdue');
});

test('reminders can be switched off one by one', () => {
  assert.equal(reminderDecision({ ...base, rules: { ...rules, remindOnDueDay: false }, todayKey: '2026-03-20' }), null);
  assert.equal(reminderDecision({ ...base, rules: { ...rules, reminderBeforeDays: [] }, todayKey: '2026-03-19' }), null);
});

test('escalation: department complaint and principal follow the overdue days', () => {
  assert.deepEqual(escalationStage({ overdueDays: 3, rules }), { department: false, principal: false });
  assert.deepEqual(escalationStage({ overdueDays: 7, rules }), { department: true, principal: false });
  assert.deepEqual(escalationStage({ overdueDays: 31, rules }), { department: true, principal: true });
});

// ---------- codes ----------
test('copy codes and book ids', () => {
  assert.equal(makeBookId(12), 'LB-000012');
  assert.equal(makeCopyCode('LB-000012', 1), 'LB-000012-01');
  assert.equal(makeCopyCode('LB-000012', 12), 'LB-000012-12');
});

test('scanner input is cleaned: spaces, Enter/Tab and case', () => {
  assert.equal(normalizeCode(' lb-000012-01\r\n'), 'LB-000012-01');
  assert.equal(normalizeCode('lb-000012-01\t'), 'LB-000012-01');
  assert.equal(normalizeCode(null), '');
});

test('a QR code with a link keeps only the code at its end', () => {
  assert.equal(codeFromScan('LB-000012-01'), 'LB-000012-01');
  assert.equal(codeFromScan('https://library.example.edu/copy/LB-000012-01'), 'LB-000012-01');
  assert.equal(codeFromScan('  cs-s1-03 '), 'CS-S1-03');
});

// ---------- SMS ----------
test('every SMS text is short and carries the book and the date', () => {
  const t = 'A very long book title '.repeat(10);
  const texts = [
    smsText.issued({ title: t, issuedDay: '2026-03-06', dueDay: '2026-03-20', currency: 'PKR', perDay: 10 }),
    smsText.before_due({ title: t, dueDay: '2026-03-20', daysLeft: 3 }),
    smsText.due_today({ title: t, dueDay: '2026-03-20' }),
    smsText.overdue({ title: t, dueDay: '2026-03-20', overdueDays: 4, fine: 40, currency: 'PKR' }),
    smsText.returned({ title: t, returnedDay: '2026-03-22', pending: 20, currency: 'PKR' }),
    smsText.lost({ title: t, pending: 900, currency: 'PKR' }),
    smsText.reservation_ready({ title: t, holdUntilDay: '2026-03-24' }),
    smsText.reservation_expired({ title: t }),
    smsText.fine({ title: t, amount: 20, pending: 0, currency: 'PKR' }),
  ];
  for (const x of texts) assert.ok(x.length < 320, x);
  assert.match(texts[0], /2026-03-20/);
  assert.match(texts[1], /3 days left/);
  assert.match(smsText.before_due({ title: 'X', dueDay: '2026-03-20', daysLeft: 1 }), /1 day left/);
  assert.match(texts[3], /4 days overdue/);
  assert.ok(!/Fine so far/.test(smsText.overdue({ title: 'X', dueDay: '2026-03-20', overdueDays: 1, fine: 0, currency: 'PKR' })));
});

// ---------- chatbot ----------
test('the chatbot recognises what the student asks', () => {
  assert.ok(detectIntents('Which books are available?').has('available'));
  assert.ok(detectIntents('Which books have I borrowed?').has('borrowed'));
  assert.ok(detectIntents('When is my return deadline?').has('deadline'));
  assert.ok(detectIntents('Do I have overdue books?').has('overdue'));
  assert.ok(detectIntents('What is my pending fine?').has('fine'));
  assert.ok(detectIntents('How can I borrow a book?').has('howBorrow'));
  assert.ok(detectIntents('How can I return a book?').has('howReturn'));
  assert.ok(detectIntents('Can I reserve a book?').has('reserve'));
  assert.equal(detectIntents('hello').size, 0);
});

test('keywords of a question skip filler words', () => {
  assert.deepEqual(keywordsOf('Do you have a book on Data Structures?'), ['data', 'structures']);
  assert.deepEqual(keywordsOf('Is "Clean Code" by Robert Martin available?'), ['clean', 'code', 'robert', 'martin']);
  assert.deepEqual(keywordsOf('hello'), ['hello']);
  assert.ok(keywordsOf('9780132350884').includes('9780132350884'));
});

// ---------- helpers ----------
test('paging is bounded', () => {
  assert.deepEqual(pageParams({}), { limit: 25, page: 1, skip: 0 });
  assert.deepEqual(pageParams({ page: '3', limit: '10' }), { limit: 10, page: 3, skip: 20 });
  assert.equal(pageParams({ limit: '100000' }).limit, 100);
  assert.equal(pageParams({ page: '-4', limit: 'abc' }).page, 1);
});

test('phone numbers are masked for the screen', () => {
  assert.equal(maskPhone('03001234567'), '0300•••4567');
  assert.equal(maskPhone(''), '');
  assert.equal(maskPhone('123'), '•••');
});

test('regex characters in a search are escaped', () => {
  assert.equal(new RegExp(escapeRegex('C++ (2nd ed.)')).test('Learn C++ (2nd ed.)'), true);
  assert.equal(new RegExp(escapeRegex('a.b')).test('axb'), false);
});

// ---------- Excel ----------
test('colName turns a column number into letters', () => {
  assert.deepEqual([0, 1, 25, 26, 27, 51, 52].map(colName), ['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA']);
});

test('xmlEscape protects the XML and drops control characters', () => {
  assert.equal(xmlEscape('A & B <c> "d"\u0001'), 'A &amp; B &lt;c&gt; &quot;d&quot;');
});

test('the Excel builder makes all parts of an .xlsx and keeps numbers numeric', () => {
  const files = buildXlsxFiles({
    sheetName: 'Over/due: [books]?', title: 'Overdue books', summary: [['Total', 2]],
    columns: [{ label: 'Title', width: 200 }, { label: 'Days', width: 60 }],
    rows: [['Clean <Code>', 3], ['Algorithms', 12]],
  });
  for (const p of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) assert.ok(files[p], p);
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /Clean &lt;Code&gt;/);
  assert.match(sheet, /<c r="B5"><v>3<\/v><\/c>/); // title row 1, summary row 2, empty row 3, header row 4, first data row 5
  assert.match(files['xl/workbook.xml'], /name="Over due&#58; books ?"|name="Over due  books "|name="Over due/);
  assert.ok(!/[\\/?*[\]:]/.test(files['xl/workbook.xml'].match(/sheet name="([^"]*)"/)[1].replace(/&[a-z]+;/g, '')));
});
