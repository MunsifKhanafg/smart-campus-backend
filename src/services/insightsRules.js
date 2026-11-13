import { ROLES } from '../config/constants.js';

// ==========================================================================================================
// Statistics and reports for the AI assistant: "how many students", "list all teachers", "total pending fees",
// "department report", "students who have not paid the exam fee" ...
//
// This file is PURE (no database). It understands the question, decides what the role may see, adds up the fee rows and
// writes the facts as text. The database part is in insightsContext.js. Keeping this part pure makes it easy to unit test,
// and the access rules (decideScope) are the heart of the role-based security, so they are small and readable:
//
//   Principal       : the whole college: people, academic results and fees.
//   HOD             : ONLY their own department: its people, courses, academic results and fees. Asking for another
//                     department is refused here, before any data is read.
//   Finance officer : fee and payment information of the whole college. Nothing academic.
// ==========================================================================================================

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordsOf = (s) => String(s || '').toLowerCase().match(/[a-z0-9]+/g) || [];
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Words of the statistics questions. The records search must not mistake them for a person's name.
export const INSIGHT_WORDS = `collected collect pending outstanding revenue unpaid defaulter defaulters dues balance report reports stats count counts many
  average rate passed fail failed income earned amount amounts money breakdown semesterwise departmentwise deptwise receivable compare comparison
  whole entire everyone paying payers practical`.split(/\s+/);

// ---------- which department does the question name? ----------
const GENERIC = new Set(['department', 'departments', 'dept', 'college', 'university', 'studies', 'faculty', 'school', 'institute', 'center', 'centre']);
// A short code that is also an ordinary English word ("IT", "ME") counts only when it is typed in capitals.
const ENGLISH_CODES = new Set(['it', 'me', 'be', 'as', 'at', 'an', 'in', 'is', 'on', 'or', 'to', 'we', 'us', 'do', 'go', 'no', 'so', 'up', 'of', 'by', 'my', 'he', 'if', 'am', 'all', 'any']);

// hits = departments clearly named (by code, by full name, or by a word that only this department has).
// weak = departments that share a word with the question that other departments have too ("engineering"): ambiguous.
export const findDepartments = (raw, departments = []) => {
  const ws = wordsOf(raw);
  const joined = ` ${ws.join(' ')} `;
  const nameWords = (d) => [...new Set(wordsOf(d.name).filter((w) => w.length >= 4 && !GENERIC.has(w)))];
  const used = new Map();
  for (const d of departments) for (const w of nameWords(d)) used.set(w, (used.get(w) || 0) + 1);
  const touches = (w, n) => w.length >= 4 && (w === n || (w.length >= 5 && n.startsWith(w)));
  const hits = [];
  const weak = [];
  for (const d of departments) {
    const code = String(d.code || '');
    const codeRx = code ? new RegExp(`(^|[^A-Za-z0-9])${esc(code)}($|[^A-Za-z0-9])`, ENGLISH_CODES.has(code.toLowerCase()) ? '' : 'i') : null;
    const byCode = !!codeRx && codeRx.test(String(raw || ''));
    const nameList = wordsOf(d.name);
    const byPhrase = nameList.length > 0 && joined.includes(` ${nameList.join(' ')} `);
    const names = nameWords(d);
    const strong = names.some((n) => used.get(n) === 1 && ws.some((w) => touches(w, n)));
    const shared = names.some((n) => used.get(n) > 1 && ws.some((w) => touches(w, n)));
    if (byCode || byPhrase || strong) hits.push(d);
    else if (shared) weak.push(d);
  }
  return { hits, weak };
};

// A roll number, course code or e-mail means the question is about ONE person or course: the records search answers it.
const looksLikeCode = (t) => t.length >= 4 && /\d/.test(t) && /[a-z]/i.test(t) && !/^(semester|sem|class|year)\d+$/i.test(t) && !/^\d+(st|nd|rd|th)$/i.test(t);
const hasSpecificId = (raw) => {
  const text = String(raw || '');
  if (/[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/.test(text)) return true;
  return (text.match(/[A-Za-z0-9](?:[A-Za-z0-9_./-]*[A-Za-z0-9])?/g) || []).some(looksLikeCode);
};

// ---------- understanding the question ----------
export const parseInsightsQuery = (question, departments = []) => {
  const raw = String(question || '');
  const text = raw.toLowerCase();
  const sem = text.match(/semester\s*(?:no\.?|number)?\s*(\d{1,2})|(\d{1,2})\s*(?:st|nd|rd|th)?\s*semester/);
  const semester = sem ? Number(sem[1] || sem[2]) : null;
  const { hits, weak } = findDepartments(raw, departments);

  const feeWord = /\b(fees?|revenue|collect\w*|payments?|dues?|outstanding|unpaid|defaulters?|income|receivable|challan)\b/.test(text);
  const aggregateCue = /\b(total|totals|collect\w*|pending|outstanding|unpaid|revenue|income|reports?|summary|overview|statistics|stats|breakdown|how much|how many|all|whole|entire|overall|compare|comparison|defaulters?|dues?|balance|receivable|average|rate)\b|\w*wise\b/.test(text);
  const countCue = /\b(how many|total|count|counts|number of|numbers of|statistics|stats|strength)\b/.test(text);
  const listCue = /\b(list|show|display|give|names?|all|every|each|who|which|details?|records?|enrolled)\b/.test(text);
  const reportCue = /\b(reports?|summary|overview|statistics|stats|breakdown|college|university|whole|entire|overall)\b|\w*wise\b/.test(text);

  const studentsPl = /\b(students|roll numbers?)\b/.test(text);
  const teachersPl = /\b(teachers|faculty|lecturers|professors)\b/.test(text);
  const coursesPl = /\b(courses|subjects)\b/.test(text);
  const deptWord = /\b(departments?|hods?|heads?)\b/.test(text);
  const perfWord = /\b(performance|pass|passed|fail\w*|attendance|results?|grades?|gpa|percentage|academic|marks)\b/.test(text);
  const scopedAsk = hits.length > 0 || semester !== null;

  const kindExam = /\b(exam\w*|practicals?|midterm|final)\b/.test(text);
  const kindPromotion = /promot/.test(text);
  const feeKind = kindExam && !kindPromotion ? 'examination' : kindPromotion && !kindExam ? 'promotion' : null;
  const unpaidWord = /(unpaid|defaulter|not paid|not yet paid|n't paid|nt paid|who owe|still to pay)/.test(text);

  const flags = {
    wantsFees: feeWord && (aggregateCue || scopedAsk),
    wantsUnpaidList: unpaidWord && (listCue || !countCue),
    studentsList: studentsPl && (listCue || (scopedAsk && !countCue)),
    teachersList: teachersPl && (listCue || (hits.length > 0 && !countCue)),
    coursesList: coursesPl && (listCue || (scopedAsk && !countCue)),
    counts: countCue && (/\b(students?|teachers?|courses?|subjects?|faculty|lecturers?|hods?)\b/.test(text) || deptWord),
    wantsPerformance: perfWord && (aggregateCue || scopedAsk),
    wantsDeptList: deptWord && (listCue || countCue || /\bhods?\b/.test(text)),
    peopleReport: reportCue && !feeWord && !perfWord,
  };
  const specific = hasSpecificId(raw);
  return {
    semester,
    depts: hits,
    ambiguous: hits.length ? [] : weak,
    feeKind,
    ...flags,
    studentsPl, teachersPl, coursesPl, reportCue, feeWord,
    wantsContact: /\b(phone|mobile|contact|email|e-mail|guardian|parent)\b/.test(text),
    wholeCollege: /\b(college|university|whole|entire|all departments|every department|each department|overall)\b|department[- ]?wise/.test(text),
    specific,
    active: !specific && Object.values(flags).some(Boolean),
  };
};

// "and for semester 3?" has no cue of its own: it continues the previous statistics question.
export const canFollowUp = (message) => {
  const t = String(message || '').toLowerCase();
  return t.split(/\s+/).filter(Boolean).length <= 12
    && /\b(semester|pending|collected|unpaid|outstanding|department|exam\w*|promotion|students|teachers|courses|attendance|pass|fees?|\d{1,2}(st|nd|rd|th)?)\b/.test(t);
};

// ---------- who may see what ----------
// Decides the reach of the user's role BEFORE anything is read from the database.
//   deptIds: null = every department; otherwise only these departments
//   ok:false = nothing is read at all
export const decideScope = (user, parsed) => {
  const named = parsed.depts || [];
  if (user.role === ROLES.UNIVERSITY_HEAD) {
    return { ok: true, deptIds: named.length ? named.map((d) => d._id) : null, domains: ['people', 'academics', 'fees'], feeByDefault: false, notes: [],
      label: named.length ? named.map((d) => d.name).join(', ') : 'the whole college' };
  }
  if (user.role === ROLES.FINANCE_OFFICER) {
    return { ok: true, deptIds: named.length ? named.map((d) => d._id) : null, domains: ['fees'], feeByDefault: true, notes: [],
      label: named.length ? `fees of ${named.map((d) => d.name).join(', ')}` : 'fees of the whole college' };
  }
  if (user.role === ROLES.HOD) {
    const own = String(user.department);
    if (!user.department) return { ok: false, deptIds: [], domains: [], notes: [], label: 'none', message: 'Your account has no department, so there is no department data to show.' };
    const other = named.filter((d) => String(d._id) !== own);
    if (other.length) {
      return { ok: false, deptIds: [], domains: [], notes: [], label: 'your department',
        message: 'I can only share information about your own department. The question asks about another department, which is outside your access.' };
    }
    return { ok: true, deptIds: [user.department], domains: ['people', 'academics', 'fees'], feeByDefault: false, label: 'your department',
      notes: parsed.wholeCollege ? ['The question is about the whole college, but this user may see only their own department, so the figures below are for their department only.'] : [] };
  }
  return { ok: false, deptIds: [], domains: [], notes: [], label: 'none', message: 'This assistant is not available for your role.' };
};

// ---------- fee arithmetic (the same rules as the Finance Overview page) ----------
// Practical fees count with the examination fees. Outstanding = unpaid students x the notice amount (late and practical extras are not guessed).
export const FEE_TYPES = ['examination', 'promotion', 'other'];
export const feeType = (t) => (t === 'practical' ? 'examination' : FEE_TYPES.includes(t) ? t : 'other');

// collectedRows: [{ department, semester, type, collected, late, count }]   (money really received, from payments)
// noticeRows:    [{ title, type, department, semester, amount, students, paid, collected }]   (one per published or closed fee notice)
// departments: Map(id -> { code, name }); semesters: Map(id -> { name, number })
export const buildFeeReport = ({ collectedRows = [], noticeRows = [], departments = new Map(), semesters = new Map(), semesterNumber = null }) => {
  const semOf = (id) => (id ? semesters.get(String(id)) : undefined);
  const keep = (semId) => semesterNumber === null || semOf(semId)?.number === semesterNumber;
  const blank = (extra = {}) => ({ ...extra, collected: 0, outstanding: 0, unpaidStudents: 0, types: Object.fromEntries(FEE_TYPES.map((t) => [t, { collected: 0, outstanding: 0 }])) });
  const rowFor = (map, key, extra) => { if (!map.has(key)) map.set(key, blank(extra())); return map.get(key); };
  const add = (row, type, collected, outstanding, unpaid = 0) => {
    row.collected += collected; row.outstanding += outstanding; row.unpaidStudents += unpaid;
    row.types[type].collected += collected; row.types[type].outstanding += outstanding;
  };

  const totals = { collected: 0, outstanding: 0, late: 0, payments: 0, unpaidStudents: 0 };
  const byType = Object.fromEntries(FEE_TYPES.map((t) => [t, { collected: 0, outstanding: 0, late: 0, payments: 0 }]));
  const deptRows = new Map();
  const semRows = new Map();
  const numRows = new Map();
  const where = (depId, semId) => {
    const dep = departments.get(String(depId)) || { code: '?', name: 'Unknown department' };
    const sem = semOf(semId);
    return { dep, sem, number: sem?.number ?? 99, semName: sem?.name || 'unknown semester' };
  };
  const spread = (depId, semId, type, collected, outstanding, unpaid) => {
    const w = where(depId, semId);
    add(rowFor(deptRows, String(depId), () => ({ code: w.dep.code, name: w.dep.name })), type, collected, outstanding, unpaid);
    add(rowFor(semRows, `${depId}:${semId}`, () => ({ department: w.dep.code, semester: w.semName, number: w.number })), type, collected, outstanding, unpaid);
    add(rowFor(numRows, String(w.number), () => ({ number: w.number })), type, collected, outstanding, unpaid);
  };

  for (const r of collectedRows) {
    if (!keep(r.semester)) continue;
    const t = feeType(r.type);
    const amount = Number(r.collected) || 0;
    totals.collected += amount; totals.late += Number(r.late) || 0; totals.payments += Number(r.count) || 0;
    byType[t].collected += amount; byType[t].late += Number(r.late) || 0; byType[t].payments += Number(r.count) || 0;
    spread(r.department, r.semester, t, amount, 0, 0);
  }
  const notices = [];
  for (const n of noticeRows) {
    if (!keep(n.semester)) continue;
    const t = feeType(n.type);
    const unpaid = Math.max((n.students || 0) - (n.paid || 0), 0);
    const outstanding = unpaid * (Number(n.amount) || 0);
    totals.outstanding += outstanding; totals.unpaidStudents += unpaid;
    byType[t].outstanding += outstanding;
    spread(n.department, n.semester, t, 0, outstanding, unpaid);
    const w = where(n.department, n.semester);
    notices.push({ title: n.title, type: t, department: w.dep.code, semester: w.semName, number: w.number, amount: n.amount, students: n.students, paid: n.paid, unpaid, collected: n.collected || 0, outstanding });
  }

  const fix = (row) => ({ ...row, collected: round2(row.collected), outstanding: round2(row.outstanding) });
  return {
    totals: { ...totals, collected: round2(totals.collected), outstanding: round2(totals.outstanding), late: round2(totals.late) },
    byType: Object.fromEntries(FEE_TYPES.map((t) => [t, { ...byType[t], collected: round2(byType[t].collected), outstanding: round2(byType[t].outstanding), late: round2(byType[t].late) }])),
    byDepartment: [...deptRows.values()].map(fix).sort((a, b) => a.name.localeCompare(b.name)),
    bySemester: [...semRows.values()].map(fix).sort((a, b) => a.department.localeCompare(b.department) || a.number - b.number),
    bySemesterNumber: [...numRows.values()].map(fix).sort((a, b) => a.number - b.number),
    notices: notices.sort((a, b) => a.department.localeCompare(b.department) || a.number - b.number || a.title.localeCompare(b.title)),
  };
};

// ---------- presentation ----------
const money = (n, c = 'PKR') => `${c} ${Number(n || 0).toLocaleString('en-US')}`;
const cell = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '-';
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
const semLabel = (n) => (n === 99 ? 'unknown semester' : `Semester ${n}`);
const pct = (v) => (v === null || v === undefined ? 'n/a' : `${v}%`);
const TYPE_LABEL = { examination: 'Examination (incl. practical)', promotion: 'Promotion', other: 'Other' };

// The facts as plain text for the AI model (inside <insights_data>). It must not add anything that is not here.
export const insightsText = (d) => {
  const out = [`Scope: ${d.scopeLabel}`, ...(d.notes || []).map((n) => `Note: ${n}`)];
  if (d.denied) return [...out, `ACCESS REFUSED: ${d.denied}`].join('\n');
  const cur = d.currency;
  const o = d.overview;
  if (o) {
    const status = Object.entries(o.students.byStatus).map(([k, v]) => `${k} ${v}`).join(', ');
    out.push(`Totals: ${o.students.active} active students (all statuses: ${status || 'none'}); ${o.teachers.total} teachers${o.teachers.noDepartment ? ` (${o.teachers.noDepartment} of them common-subject teachers without a home department)` : ''}; ${o.hods} HODs; ${o.courses} active courses; ${o.departments.length} departments.`);
    out.push(`Departments:\n${o.departments.map((x) => `  ${x.name} (${x.code}): HOD ${x.hod}; ${x.students} active students; ${x.teachers} teachers; ${x.courses} active courses${x.attendance !== undefined ? `; attendance ${pct(x.attendance)} (present + approved leave); pass rate ${pct(x.passRate)}; average result ${pct(x.avgPercentage)} over ${x.results} published results` : ''}`).join('\n') || '  none'}`);
    out.push(`Active students per semester:\n${o.perSemester.map((x) => `  ${x.department} ${x.semester}: ${x.students}`).join('\n') || '  none'}`);
    if (o.semesterPerformance?.length) out.push(`Results per semester:\n${o.semesterPerformance.map((x) => `  ${x.department} ${semLabel(x.number)}: pass rate ${pct(x.passRate)}; average ${pct(x.avgPercentage)}; ${x.results} published results`).join('\n')}`);
  }
  if (d.students) out.push(`Students (${d.students.rows.length} shown of ${d.students.total}):\n${d.students.rows.map((s) => `  ${s.name} | ${s.roll} | ${s.department} | ${s.semester} | sec ${s.section}${s.email !== undefined ? ` | ${s.email} | ${s.phone || 'no phone'} | guardian: ${s.guardian || 'none'}` : ''}`).join('\n') || '  none'}`);
  if (d.teachers) out.push(`Teachers (${d.teachers.rows.length} shown of ${d.teachers.total}):\n${d.teachers.rows.map((t) => `  ${t.name} | ${t.role} | ${t.department} | ${t.qualification || 'no qualification'} | ${t.email} | ${t.phone || 'no phone'} | ${t.creditHours} credit hours | subjects: ${t.subjects.join('; ') || 'none'}`).join('\n') || '  none'}`);
  if (d.courses) out.push(`Courses (${d.courses.rows.length} shown of ${d.courses.total}):\n${d.courses.rows.map((c) => `  ${c.code} ${c.title} | ${c.department} | ${c.semester} sec ${c.section} | ${c.creditHours} credit hours | teacher ${c.teacher} | ${c.students} enrolled`).join('\n') || '  none'}`);
  if (d.fees) {
    const f = d.fees;
    const t = f.report.totals;
    out.push(`FEES (currency ${cur}${d.semesterNumber ? `, semester ${d.semesterNumber} only` : ''}${f.kind ? `, asked about ${f.kind} fees` : ''}). Collected = money received (paid payments). Outstanding = unpaid students x the fee amount of every published or closed fee notice (late fees and practical extras are not added). Practical fees are counted with examination fees.`);
    out.push(`Total collected ${money(t.collected, cur)} in ${t.payments} fee lines (of which late fees ${money(t.late, cur)}); total outstanding ${money(t.outstanding, cur)} from ${t.unpaidStudents} unpaid student-fee entries.`);
    out.push(`By fee type:\n${Object.entries(f.report.byType).map(([k, v]) => `  ${TYPE_LABEL[k]}: collected ${money(v.collected, cur)}; outstanding ${money(v.outstanding, cur)}`).join('\n')}`);
    out.push(`By department:\n${f.report.byDepartment.map((x) => `  ${x.name} (${x.code}): collected ${money(x.collected, cur)} (exam ${money(x.types.examination.collected, cur)}, promotion ${money(x.types.promotion.collected, cur)}, other ${money(x.types.other.collected, cur)}); outstanding ${money(x.outstanding, cur)} (exam ${money(x.types.examination.outstanding, cur)}, promotion ${money(x.types.promotion.outstanding, cur)})`).join('\n') || '  none'}`);
    out.push(`By semester (department, semester):\n${f.report.bySemester.map((x) => `  ${x.department} ${x.semester}: collected ${money(x.collected, cur)} (exam ${money(x.types.examination.collected, cur)}, promotion ${money(x.types.promotion.collected, cur)}); outstanding ${money(x.outstanding, cur)}; ${x.unpaidStudents} unpaid`).join('\n') || '  none'}`);
    if (f.report.bySemesterNumber.length > 1) out.push(`By semester number (all departments together):\n${f.report.bySemesterNumber.map((x) => `  ${semLabel(x.number)}: collected ${money(x.collected, cur)}; outstanding ${money(x.outstanding, cur)}`).join('\n')}`);
    out.push(`Fee notices (${f.report.notices.length}):\n${f.report.notices.map((n) => `  ${n.title} | ${TYPE_LABEL[n.type]} | ${n.department} ${n.semester} | fee ${money(n.amount, cur)} | ${n.students} students, ${n.paid} paid, ${n.unpaid} unpaid | collected ${money(n.collected, cur)} | outstanding ${money(n.outstanding, cur)}`).join('\n') || '  none'}`);
    out.push(`How it was paid: online ${money(f.methods.online.amount, cur)} (${f.methods.online.count} payments); at the office ${money(f.methods.office.amount, cur)} (${f.methods.office.count}); bank transfer ${money(f.methods.bank.amount, cur)} (${f.methods.bank.count}). Bank transfers waiting for the finance office to verify: ${money(f.bankPending.amount, cur)} (${f.bankPending.count}) (not counted as collected). Refunded: ${money(f.refunded.amount, cur)} (${f.refunded.count}) (not counted as collected).`);
    if (f.defaulters) out.push(`Students who have not paid${f.kind ? ` the ${f.kind} fee` : ''} (${f.defaulters.rows.length} shown of ${f.defaulters.total} unpaid entries):\n${f.defaulters.rows.map((r) => `  ${r.name} | ${r.roll} | ${r.department} | ${r.semester} | ${r.fee} | ${money(r.amount, cur)}`).join('\n') || '  none'}`);
  }
  const text = out.join('\n\n');
  return text.length > 14000 ? `${text.slice(0, 13900)}\n...(cut: ask a narrower question, for example one department or semester)` : text;
};

// Without an AI key the same facts are shown directly, as tables.
export const insightsFallback = (d) => {
  const out = [];
  const cur = d.currency;
  if (d.denied) return `**${d.denied}**`;
  for (const n of d.notes || []) out.push(`_${n}_`);
  const o = d.overview;
  if (o) {
    out.push(`### ${d.scopeLabel === 'the whole college' ? 'College' : 'Department'} overview`);
    out.push(`- **${o.students.active}** active students · **${o.teachers.total}** teachers${o.teachers.noDepartment ? ` (${o.teachers.noDepartment} common-subject teachers have no home department)` : ''} · **${o.hods}** HODs · **${o.courses}** active courses`);
    const perf = o.departments.some((x) => x.attendance !== undefined);
    out.push('', table(['Department', 'HOD', 'Students', 'Teachers', 'Courses', ...(perf ? ['Attendance', 'Pass rate', 'Avg result'] : [])],
      o.departments.map((x) => [`${x.name} (${x.code})`, x.hod, x.students, x.teachers, x.courses, ...(perf ? [pct(x.attendance), pct(x.passRate), pct(x.avgPercentage)] : [])])));
    if (o.perSemester.length) out.push('', '**Active students per semester**', table(['Department', 'Semester', 'Students'], o.perSemester.map((x) => [x.department, x.semester, x.students])));
    if (o.semesterPerformance?.length) out.push('', '**Results per semester**', table(['Department', 'Semester', 'Pass rate', 'Avg result', 'Results'], o.semesterPerformance.map((x) => [x.department, semLabel(x.number), pct(x.passRate), pct(x.avgPercentage), x.results])));
    out.push('');
  }
  if (d.students) {
    const wide = d.students.rows.some((s) => s.email !== undefined);
    out.push(`### Students (${d.students.rows.length}${d.students.total > d.students.rows.length ? ` of ${d.students.total}` : ''})`,
      table(['Name', 'Roll no', 'Dept', 'Semester', 'Section', ...(wide ? ['Email', 'Phone', 'Guardian'] : [])], d.students.rows.map((s) => [s.name, s.roll, s.department, s.semester, s.section, ...(wide ? [s.email, s.phone, s.guardian] : [])])), '');
  }
  if (d.teachers) out.push(`### Teachers (${d.teachers.rows.length}${d.teachers.total > d.teachers.rows.length ? ` of ${d.teachers.total}` : ''})`, table(['Name', 'Role', 'Dept', 'Qualification', 'Email', 'Phone', 'Credit hrs', 'Subjects'], d.teachers.rows.map((t) => [t.name, t.role, t.department, t.qualification, t.email, t.phone, t.creditHours, t.subjects.join('; ')])), '');
  if (d.courses) out.push(`### Courses (${d.courses.rows.length}${d.courses.total > d.courses.rows.length ? ` of ${d.courses.total}` : ''})`, table(['Code', 'Subject', 'Dept', 'Semester', 'Sec', 'Credit hrs', 'Teacher', 'Enrolled'], d.courses.rows.map((c) => [c.code, c.title, c.department, c.semester, c.section, c.creditHours, c.teacher, c.students])), '');
  if (d.fees) {
    const f = d.fees;
    const t = f.report.totals;
    out.push(`### Fees${d.semesterNumber ? ` · semester ${d.semesterNumber}` : ''}`,
      `- **Total collected:** ${money(t.collected, cur)} (${t.payments} fee lines; late fees ${money(t.late, cur)})`,
      `- **Total outstanding:** ${money(t.outstanding, cur)} (${t.unpaidStudents} unpaid student-fee entries)`,
      `- Bank transfers waiting for verification: ${money(f.bankPending.amount, cur)} (${f.bankPending.count}) · Refunded: ${money(f.refunded.amount, cur)} (${f.refunded.count})`, '',
      table(['Fee type', 'Collected', 'Outstanding'], Object.entries(f.report.byType).map(([k, v]) => [TYPE_LABEL[k], money(v.collected, cur), money(v.outstanding, cur)])));
    if (f.report.byDepartment.length) out.push('', '**By department**', table(['Department', 'Exam collected', 'Promotion collected', 'Total collected', 'Outstanding'], f.report.byDepartment.map((x) => [`${x.name} (${x.code})`, money(x.types.examination.collected, cur), money(x.types.promotion.collected, cur), money(x.collected, cur), money(x.outstanding, cur)])));
    if (f.report.bySemester.length) out.push('', '**By semester**', table(['Department', 'Semester', 'Collected', 'Outstanding', 'Unpaid'], f.report.bySemester.map((x) => [x.department, x.semester, money(x.collected, cur), money(x.outstanding, cur), x.unpaidStudents])));
    if (f.report.notices.length) out.push('', '**Fee notices**', table(['Fee', 'Dept', 'Semester', 'Amount', 'Students', 'Paid', 'Unpaid', 'Collected', 'Outstanding'], f.report.notices.map((n) => [n.title, n.department, n.semester, money(n.amount, cur), n.students, n.paid, n.unpaid, money(n.collected, cur), money(n.outstanding, cur)])));
    if (f.defaulters) out.push('', `**Students who have not paid${f.kind ? ` the ${f.kind} fee` : ''}** (${f.defaulters.rows.length} of ${f.defaulters.total})`, f.defaulters.rows.length ? table(['Name', 'Roll no', 'Dept', 'Semester', 'Fee', 'Amount'], f.defaulters.rows.map((r) => [r.name, r.roll, r.department, r.semester, r.fee, money(r.amount, cur)])) : '- Everyone has paid.');
    out.push('', '_Outstanding = unpaid students × the fee amount (late fees and practical extras are not added). Practical fees are counted with examination fees._', '');
  }
  if (!out.length) return 'I have no figures for that question.';
  out.push('_The AI model is not switched on, so this is a direct report from the database. Add an AI key on the server to ask free questions._');
  return out.join('\n');
};
