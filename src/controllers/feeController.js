import FeeNotice from '../models/FeeNotice.js';
import mongoose from 'mongoose';
import FeeCart from '../models/FeeCart.js';
import Payment from '../models/Payment.js';
import Semester from '../models/Semester.js';
import Department from '../models/Department.js';
import Examination from '../models/Examination.js';
import StudentProfile from '../models/StudentProfile.js';
import CourseEnrollment from '../models/CourseEnrollment.js';
import User from '../models/User.js';
import UniversitySettings from '../models/UniversitySettings.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { assertDepartmentAccess } from '../middleware/auth.js';
import { logAudit } from '../utils/audit.js';
import { notifyUsers } from '../utils/notify.js';
import { oid } from '../utils/oid.js';
import { priceNotice, isPayablePhase, paidNoticeIds, semesterProfiles, clampPracticals, pendingBankNoticeIds } from '../services/feeService.js';
import { ROLES, FEE_NOTICE_STATUS, DEPARTMENT_STATUS, PAYMENT_STATUS, STUDENT_STATUS, SEMESTER_STATUS } from '../config/constants.js';

// Practical fees count as examination money in the finance reports.
const reportType = (t) => (t === 'practical' ? 'examination' : ['examination', 'promotion'].includes(t) ? t : 'other');

const populateNotice = (q) => q.populate('department', 'name code').populate('semester', 'name number academicYear').populate('examination', 'name type');

const loadNotice = async (id) => {
  const n = await FeeNotice.findById(id);
  if (!n) throw ApiError.notFound('Fee notice not found');
  return n;
};

// Finance officers work university-wide; an HOD only inside their own department.
const assertManageAccess = (user, notice) => {
  if (user.role === ROLES.FINANCE_OFFICER) return;
  assertDepartmentAccess(user, notice.department);
};

// ---------- Staff: create and manage notices ----------
export const createNotice = asyncHandler(async (req, res) => {
  const { department, semester: semesterId, examination: examId, ...rest } = req.body;
  const deptId = req.user.role === ROLES.HOD ? req.user.department : department;
  if (!deptId) throw ApiError.badRequest('Department is required');
  const dept = await Department.findById(deptId);
  if (!dept || dept.status !== DEPARTMENT_STATUS.ACTIVE) throw ApiError.badRequest('Department not found or not active');

  const semester = await Semester.findById(semesterId);
  if (!semester || String(semester.department) !== String(deptId)) throw ApiError.badRequest('Semester does not belong to this department');
  if (examId) {
    const exam = await Examination.findById(examId);
    if (!exam || String(exam.semester) !== String(semesterId)) throw ApiError.badRequest('Examination does not belong to this semester');
  }
  const notice = await FeeNotice.create({
    ...rest,
    department: deptId,
    semester: semesterId,
    examination: examId || null,
    createdBy: req.user._id,
    createdByRole: req.user.role,
  });
  logAudit(req, 'fee.notice_create', 'FeeNotice', notice._id, { title: notice.title, amount: notice.amount });
  sendSuccess(res, await populateNotice(FeeNotice.findById(notice._id)), 'Fee notice created', 201);
});

export const listNotices = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.user.role === ROLES.HOD) filter.department = req.user.department;
  else if (req.query.department) filter.department = req.query.department;
  if (req.query.semester) filter.semester = req.query.semester;
  if (req.query.status) filter.status = req.query.status;
  sendSuccess(res, await populateNotice(FeeNotice.find(filter)).sort({ createdAt: -1 }));
});

export const updateNotice = asyncHandler(async (req, res) => {
  const notice = await loadNotice(req.params.id);
  assertManageAccess(req.user, notice);
  if (notice.status === FEE_NOTICE_STATUS.CLOSED) throw ApiError.badRequest('A closed notice cannot be edited');

  // Money fields are frozen as soon as a student has started paying, so records stay consistent.
  const touchesMoney = ['amount', 'lateFee', 'practicalFee', 'practicalLateFee', 'maxPracticals'].some((k) => req.body[k] !== undefined && req.body[k] !== notice[k]);
  if (touchesMoney && (await Payment.exists({ 'items.notice': notice._id, status: { $in: [PAYMENT_STATUS.PAID, PAYMENT_STATUS.PENDING] } }))) {
    throw ApiError.conflict('Payments exist for this fee, so its amounts cannot change. Close it and create a new notice');
  }
  notice.set(req.body);
  await notice.save();
  logAudit(req, 'fee.notice_update', 'FeeNotice', notice._id, { fields: Object.keys(req.body) });
  sendSuccess(res, await populateNotice(FeeNotice.findById(notice._id)), 'Fee notice updated');
});

export const publishNotice = asyncHandler(async (req, res) => {
  const notice = await loadNotice(req.params.id);
  assertManageAccess(req.user, notice);
  if (notice.status !== FEE_NOTICE_STATUS.DRAFT) throw ApiError.conflict('Only draft notices can be published');
  notice.status = FEE_NOTICE_STATUS.PUBLISHED;
  notice.publishedAt = new Date();
  await notice.save();

  await announceNotices([notice]);
  logAudit(req, 'fee.notice_publish', 'FeeNotice', notice._id);
  sendSuccess(res, notice, 'Fee notice published. Students, teachers and the HOD were notified');
});

// ---------- Fee announcements: one notice per semester (plus a practical fee) sent together ----------
const day = (d) => new Date(d).toISOString().slice(0, 10);
const PART = { theory: 'exam fee', practical: 'practical fee', general: 'fee' };

// Tells the students of each semester about THEIR fees, and the teachers and HODs of the department(s) that a
// fee announcement was published. A failure to notify never breaks the publish itself (notifyUsers swallows errors).
const announceNotices = async (notices) => {
  if (!notices.length) return;
  const cur = (await UniversitySettings.getSettings()).feePolicy.currency;
  const group = (list, key) => list.reduce((m, n) => m.set(String(n[key]), [...(m.get(String(n[key])) || []), n]), new Map());

  for (const [semId, list] of group(notices, 'semester')) {
    const dept = String(list[0].department);
    const students = (await semesterProfiles(semId)).filter((p) => String(p.department) === dept).map((p) => p.user);
    const first = list[0];
    const parts = list
      .map((n) => `${PART[n.component] || 'fee'} ${cur} ${n.amount}${n.practicalFee > 0 ? ` + practical fee ${cur} ${n.practicalFee} for each practical (up to ${n.maxPracticals ?? 3})` : ''}`)
      .join(' + ');
    const late = first.lateFee > 0 && first.lateDueDate ? `, or until ${day(first.lateDueDate)} with a late fee of ${cur} ${first.lateFee}` : '';
    await notifyUsers(students, {
      title: 'New fee notice',
      message: `${first.batchTitle || first.title}: ${parts}. Pay from ${day(first.startDate)} until ${day(first.dueDate)}${late}.`,
      type: 'fee',
      link: '/fees',
    });
  }

  for (const [deptId, list] of group(notices, 'department')) {
    const semCount = new Set(list.map((n) => String(n.semester))).size;
    const from = day(Math.min(...list.map((n) => new Date(n.startDate))));
    const to = day(Math.max(...list.map((n) => new Date(n.dueDate))));
    const staff = await User.find({ department: deptId, role: { $in: [ROLES.TEACHER, ROLES.HOD] }, isActive: true }).select('_id role').lean();
    const body = { title: 'Fee announcement', message: `${list[0].batchTitle || list[0].title}: ${semCount} semester${semCount === 1 ? '' : 's'}. Fee collection ${from} to ${to}.`, type: 'fee' };
    await notifyUsers(staff.filter((s) => s.role === ROLES.HOD).map((s) => s._id), { ...body, link: '/fee-notices' });
    await notifyUsers(staff.filter((s) => s.role === ROLES.TEACHER).map((s) => s._id), { ...body, link: '/announcements' });
  }
};

export const createAnnouncement = asyncHandler(async (req, res) => {
  const { title, feeType, examType, lines, publish } = req.body;
  const ids = lines.map((l) => String(l.semester));
  if (new Set(ids).size !== ids.length) throw ApiError.badRequest('A semester appears twice in this announcement');

  const semesters = await Semester.find({ _id: { $in: ids } }).populate('department', 'name code status');
  if (semesters.length !== ids.length) throw ApiError.badRequest('One of the semesters was not found');
  const semById = new Map(semesters.map((s) => [String(s._id), s]));
  for (const s of semesters) {
    assertManageAccess(req.user, { department: s.department._id }); // an HOD can only announce for their own department
    if (s.department.status !== DEPARTMENT_STATUS.ACTIVE) throw ApiError.badRequest(`${s.department.code} is not an active department`);
    // Promotion fees may be announced for earlier (completed) semesters, because students who skipped them are now further ahead.
    if (feeType !== 'promotion' && [SEMESTER_STATUS.COMPLETED, SEMESTER_STATUS.ARCHIVED].includes(s.status)) {
      throw ApiError.badRequest(`${s.name} is already ${s.status}, so its examination fee cannot be announced`);
    }
  }

  // Link every semester to its examination session of the chosen type, so exam admission can check the payment.
  const warnings = [];
  const examOf = new Map();
  if (examType && feeType === 'examination') {
    const exams = await Examination.find({ semester: { $in: ids }, type: examType }).sort({ createdAt: -1 }).select('semester name');
    for (const x of exams) if (!examOf.has(String(x.semester))) examOf.set(String(x.semester), x._id);
    for (const s of semesters) if (!examOf.has(String(s._id))) warnings.push(`${s.name}: no ${examType} examination session exists yet, so its fee is not linked to an exam (create the exam and edit the notice to link it).`);
  }

  const batch = new mongoose.Types.ObjectId();
  const now = new Date();
  const docs = [];
  for (const line of lines) {
    const sem = semById.get(String(line.semester));
    const base = {
      department: sem.department._id, semester: sem._id, examination: examOf.get(String(sem._id)) || null,
      startDate: line.startDate, dueDate: line.dueDate, lateDueDate: line.lateDueDate || null,
      requirements: line.requirements || '', requiredDocuments: line.requiredDocuments || [],
      batch, batchTitle: title, createdBy: req.user._id, createdByRole: req.user.role,
      status: publish ? FEE_NOTICE_STATUS.PUBLISHED : FEE_NOTICE_STATUS.DRAFT, publishedAt: publish ? now : undefined,
    };
    if (feeType === 'examination') {
      // ONE notice. The practical fee is per practical: the student says how many practicals they have and pays
      // exam fee + practicals x practical fee in a single payment.
      docs.push(new FeeNotice({
        ...base, title, feeType: 'examination', component: 'theory', amount: line.amount, lateFee: line.lateFee,
        practicalFee: line.practicalFee, practicalLateFee: line.practicalLateFee, maxPracticals: line.maxPracticals,
      }));
    } else {
      docs.push(new FeeNotice({
        ...base, title, feeType, component: 'general', amount: line.amount, lateFee: line.lateFee,
        // A promotion fee can carry practicals too: fee + practicals x practical fee, ONE payment.
        ...(feeType === 'promotion' ? { practicalFee: line.practicalFee, practicalLateFee: line.practicalLateFee, maxPracticals: line.maxPracticals } : {}),
      }));
    }
  }
  // Validate everything first so a mistake in one semester does not leave half of the announcement saved.
  for (const d of docs) {
    try { await d.validate(); } catch (err) { throw ApiError.badRequest(`${semById.get(String(d.semester)).name}: ${err.message}`); }
  }
  await FeeNotice.insertMany(docs);
  if (publish) await announceNotices(docs);

  logAudit(req, publish ? 'fee.announcement_publish' : 'fee.announcement_create', 'FeeNotice', batch, { title, semesters: ids.length, notices: docs.length });
  sendSuccess(res, { batch, notices: docs.length, semesters: ids.length, published: !!publish, warnings },
    publish ? 'Fee announcement published. Students, teachers and HODs were notified' : 'Fee announcement saved as a draft', 201);
});

export const listAnnouncements = asyncHandler(async (req, res) => {
  const filter = { batch: { $ne: null } };
  if (req.user.role === ROLES.HOD) filter.department = req.user.department;
  const notices = await populateNotice(FeeNotice.find(filter)).sort({ createdAt: -1 }).limit(600).lean();

  const map = new Map();
  for (const n of notices) {
    const key = String(n.batch);
    const entry = map.get(key) || { batch: key, title: n.batchTitle || n.title, feeType: n.feeType === 'practical' ? 'examination' : n.feeType, createdAt: n.createdAt, notices: [] };
    entry.notices.push(n);
    map.set(key, entry);
  }
  const out = [...map.values()].slice(0, 40).map((e) => {
    const statuses = new Set(e.notices.map((n) => n.status));
    const rows = new Map();
    for (const n of e.notices) {
      const k = String(n.semester._id);
      const row = rows.get(k) || { semester: n.semester, department: n.department, examination: n.examination };
      if (n.component === 'practical') row.practical = n; else row.main = n;
      rows.set(k, row);
    }
    return {
      batch: e.batch, title: e.title, feeType: e.feeType, createdAt: e.createdAt,
      status: statuses.size === 1 ? [...statuses][0] : 'mixed',
      lines: [...rows.values()].sort((a, b) => (a.department.code || '').localeCompare(b.department.code || '') || a.semester.number - b.semester.number),
    };
  });
  sendSuccess(res, out);
});

const loadBatch = async (user, batch) => {
  const notices = await FeeNotice.find({ batch });
  if (!notices.length) throw ApiError.notFound('Fee announcement not found');
  notices.forEach((n) => assertManageAccess(user, n));
  return notices;
};

export const publishBatch = asyncHandler(async (req, res) => {
  const drafts = (await loadBatch(req.user, req.params.batch)).filter((n) => n.status === FEE_NOTICE_STATUS.DRAFT);
  if (!drafts.length) throw ApiError.conflict('Nothing left to publish in this announcement');
  await FeeNotice.updateMany({ _id: { $in: drafts.map((n) => n._id) } }, { status: FEE_NOTICE_STATUS.PUBLISHED, publishedAt: new Date() });
  await announceNotices(drafts);
  logAudit(req, 'fee.announcement_publish', 'FeeNotice', req.params.batch, { notices: drafts.length });
  sendSuccess(res, { published: drafts.length }, 'Fee announcement published. Students, teachers and HODs were notified');
});

export const closeBatch = asyncHandler(async (req, res) => {
  const open = (await loadBatch(req.user, req.params.batch)).filter((n) => n.status === FEE_NOTICE_STATUS.PUBLISHED);
  if (!open.length) throw ApiError.conflict('There is no open fee in this announcement');
  await FeeNotice.updateMany({ _id: { $in: open.map((n) => n._id) } }, { status: FEE_NOTICE_STATUS.CLOSED });
  logAudit(req, 'fee.announcement_close', 'FeeNotice', req.params.batch, { notices: open.length });
  sendSuccess(res, { closed: open.length }, 'Fee announcement closed');
});

export const closeNotice = asyncHandler(async (req, res) => {
  const notice = await loadNotice(req.params.id);
  assertManageAccess(req.user, notice);
  notice.status = FEE_NOTICE_STATUS.CLOSED;
  await notice.save();
  logAudit(req, 'fee.notice_close', 'FeeNotice', notice._id);
  sendSuccess(res, notice, 'Fee notice closed');
});

// ---------- Student: obligations and cart ----------
const studentContext = async (userId) => {
  const profile = await StudentProfile.findOne({ user: userId });
  if (!profile) throw ApiError.notFound('Your student profile has not been created yet');
  const semesterIds = await CourseEnrollment.find({ student: userId }).distinct('semester');
  if (profile.semester) semesterIds.push(profile.semester);
  return { profile, semesterIds };
};

// All the fees of one student with their state and price. Used by the student's own page and by the finance officer
// who takes a payment at the office, so both see exactly the same thing.
const feesForStudent = async (userId) => {
  const { profile, semesterIds } = await studentContext(userId);
  const settings = await UniversitySettings.getSettings();
  const [notices, paid, pendingBank, cart] = await Promise.all([
    populateNotice(FeeNotice.find({ department: profile.department, semester: { $in: semesterIds }, status: { $in: [FEE_NOTICE_STATUS.PUBLISHED, FEE_NOTICE_STATUS.CLOSED] } })).sort({ dueDate: 1 }),
    paidNoticeIds(userId),
    pendingBankNoticeIds(userId),
    FeeCart.findOne({ student: userId }),
  ]);
  const inCart = new Map((cart?.items || []).map((i) => [String(i.notice), i.practicals || 0]));

  return notices.map((n) => {
    const id = String(n._id);
    const price = priceNotice(n, new Date(), settings.feePolicy.lateFeeEnabled, inCart.get(id) || 0);
    const isPaid = paid.has(id);
    const state = isPaid ? 'paid'
      : pendingBank.has(id) ? 'bank_pending'
      : n.status === FEE_NOTICE_STATUS.CLOSED ? 'expired'
      : inCart.has(id) ? 'in_cart'
      : price.phase === 'not_started' ? 'not_started'
      : price.phase === 'closed' ? 'expired' : 'payable';
    return { ...n.toObject(), state, practicalsInCart: inCart.has(id) ? inCart.get(id) : null, price: isPaid ? null : price, currency: settings.feePolicy.currency };
  });
};

export const myFees = asyncHandler(async (req, res) => sendSuccess(res, await feesForStudent(req.user._id)));

// Finance officer: the same list for the student standing at the counter.
export const studentFees = asyncHandler(async (req, res) => {
  const student = await User.findOne({ _id: req.params.id, role: ROLES.STUDENT }).select('_id');
  if (!student) throw ApiError.notFound('Student not found');
  sendSuccess(res, await feesForStudent(student._id));
});

const cartView = async (studentId) => {
  const settings = await UniversitySettings.getSettings();
  const cart = await FeeCart.findOne({ student: studentId });
  const lines = cart?.items || [];
  const notices = await FeeNotice.find({ _id: { $in: lines.map((i) => i.notice) } });
  const count = new Map(lines.map((i) => [String(i.notice), i.practicals || 0]));
  const items = notices.map((n) => ({
    notice: n._id, title: n.title, practicalFee: n.practicalFee || 0, maxPracticals: n.maxPracticals ?? 3,
    ...priceNotice(n, new Date(), settings.feePolicy.lateFeeEnabled, count.get(String(n._id)) || 0),
  }));
  const payable = items.filter((i) => isPayablePhase(i.phase));
  return { items, total: payable.reduce((s, i) => s + i.total, 0), currency: settings.feePolicy.currency };
};

export const getCart = asyncHandler(async (req, res) => sendSuccess(res, await cartView(req.user._id)));

// Adds a fee to the cart, or changes the number of practicals of a fee that is already there.
export const addToCart = asyncHandler(async (req, res) => {
  const { profile, semesterIds } = await studentContext(req.user._id);
  const notice = await loadNotice(req.body.notice);
  const settings = await UniversitySettings.getSettings();
  const eligible = String(notice.department) === String(profile.department) && semesterIds.map(String).includes(String(notice.semester));
  if (!eligible) throw ApiError.forbidden('This fee is not for you');
  if (notice.status !== FEE_NOTICE_STATUS.PUBLISHED) throw ApiError.badRequest('This fee is not open for payment');
  if ((await paidNoticeIds(req.user._id)).has(String(notice._id))) throw ApiError.conflict('You have already paid this fee');
  if ((await pendingBankNoticeIds(req.user._id)).has(String(notice._id))) throw ApiError.conflict('Your bank transfer for this fee is waiting for the finance office');
  if (!isPayablePhase(priceNotice(notice, new Date(), settings.feePolicy.lateFeeEnabled).phase)) throw ApiError.badRequest('This fee cannot be paid online right now');

  const asked = req.body.practicals || 0;
  if (asked > 0 && !(notice.practicalFee > 0)) throw ApiError.badRequest('This fee has no practical fee');
  if (asked > (notice.maxPracticals ?? 3)) throw ApiError.badRequest(`At most ${notice.maxPracticals ?? 3} practical(s) can be added to this fee`);
  const practicals = clampPracticals(notice, asked);

  await FeeCart.updateOne({ student: req.user._id }, { $pull: { items: { notice: notice._id } } }, { upsert: true });
  await FeeCart.updateOne({ student: req.user._id }, { $push: { items: { notice: notice._id, practicals } } });
  sendSuccess(res, await cartView(req.user._id), 'Added to cart');
});

export const removeFromCart = asyncHandler(async (req, res) => {
  await FeeCart.updateOne({ student: req.user._id }, { $pull: { items: { notice: req.params.id } } });
  sendSuccess(res, await cartView(req.user._id), 'Removed from cart');
});

// ---------- Finance officer: find a student (for office payments) ----------
// By name, roll number OR email, so the officer can use whatever the student tells them at the counter.
export const studentLookup = asyncHandler(async (req, res) => {
  const rx = new RegExp(req.query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const [byRoll, byUser] = await Promise.all([
    StudentProfile.find({ rollNumber: rx, status: STUDENT_STATUS.ACTIVE }).select('user').limit(20).lean(),
    User.find({ role: ROLES.STUDENT, isActive: true, $or: [{ name: rx }, { email: rx }] }).select('_id').limit(20).lean(),
  ]);
  const ids = [...new Set([...byRoll.map((p) => String(p.user)), ...byUser.map((u) => String(u._id))])].slice(0, 20);
  const [users, profiles] = await Promise.all([
    User.find({ _id: { $in: ids } }).select('name email phone').lean(),
    StudentProfile.find({ user: { $in: ids } }).populate('department', 'code name').populate('semester', 'name').lean(),
  ]);
  const info = new Map(users.map((u) => [String(u._id), u]));
  sendSuccess(res, profiles.map((p) => ({
    _id: p.user, name: info.get(String(p.user))?.name, email: info.get(String(p.user))?.email, hasPhone: !!info.get(String(p.user))?.phone,
    rollNumber: p.rollNumber, department: p.department, semester: p.semester,
  })));
});

// ---------- Staff: who has paid? ----------
export const noticeStatus = asyncHandler(async (req, res) => {
  const notice = await loadNotice(req.query.notice);
  assertManageAccess(req.user, notice);
  const profiles = (await semesterProfiles(notice.semester)).filter((p) => String(p.department) === String(notice.department));
  const ids = profiles.map((p) => p.user);
  const [users, payments] = await Promise.all([
    User.find({ _id: { $in: ids } }).select('name').lean(),
    Payment.find({ student: { $in: ids }, 'items.notice': notice._id, status: PAYMENT_STATUS.PAID }).select('student totalAmount paidAt receiptNumber items').lean(),
  ]);
  const name = new Map(users.map((u) => [String(u._id), u.name]));
  const paidBy = new Map(payments.map((p) => [String(p.student), p]));

  const rows = profiles
    .map((p) => {
      const pay = paidBy.get(String(p.user));
      const line = pay?.items.find((i) => String(i.notice) === String(notice._id));
      return { student: p.user, name: name.get(String(p.user)), rollNumber: p.rollNumber, paid: !!pay, amount: line?.total ?? null, paidAt: pay?.paidAt || null, receiptNumber: pay?.receiptNumber || null };
    })
    .sort((a, b) => a.rollNumber.localeCompare(b.rollNumber));
  sendSuccess(res, { notice: { _id: notice._id, title: notice.title, amount: notice.amount }, paidCount: rows.filter((r) => r.paid).length, unpaidCount: rows.filter((r) => !r.paid).length, rows });
});

// Finance / HOD: one line per published notice with collected vs outstanding.
export const outstanding = asyncHandler(async (req, res) => {
  const filter = { status: { $in: [FEE_NOTICE_STATUS.PUBLISHED, FEE_NOTICE_STATUS.CLOSED] } };
  if (req.user.role === ROLES.HOD) filter.department = req.user.department;
  else if (req.query.department) filter.department = req.query.department;
  if (req.query.semester) filter.semester = req.query.semester;

  const notices = await populateNotice(FeeNotice.find(filter)).sort({ dueDate: -1 });
  const rows = [];
  for (const n of notices) {
    const students = (await semesterProfiles(n.semester._id)).filter((p) => String(p.department) === String(n.department._id)).length;
    const paid = await Payment.aggregate([
      { $match: { status: PAYMENT_STATUS.PAID, 'items.notice': n._id } },
      { $unwind: '$items' },
      { $match: { 'items.notice': n._id } },
      { $group: { _id: null, count: { $sum: 1 }, collected: { $sum: '$items.total' } } },
    ]);
    const count = paid[0]?.count || 0;
    rows.push({ notice: n, students, paid: count, unpaid: Math.max(students - count, 0), collected: paid[0]?.collected || 0, outstandingAmount: Math.max(students - count, 0) * n.amount });
  }
  sendSuccess(res, rows);
});

// Finance / head: money collected split by fee type (examination, promotion, other), by month and by department,
// plus what is still outstanding. Powers the charts on the Finance Overview page.
export const feeTypeReport = asyncHandler(async (req, res) => {
  const TYPES = ['examination', 'promotion', 'other'];
  const match = { status: PAYMENT_STATUS.PAID };
  if (req.query.department) match.department = oid(req.query.department);

  const rows = await Payment.aggregate([
    { $match: match },
    { $unwind: '$items' },
    { $lookup: { from: 'feenotices', localField: 'items.notice', foreignField: '_id', as: 'n' } },
    { $addFields: { feeType: { $ifNull: [{ $arrayElemAt: ['$n.feeType', 0] }, 'other'] } } },
    {
      $group: {
        _id: { type: '$feeType', month: { $dateToString: { format: '%Y-%m', date: '$paidAt' } }, department: '$department' },
        collected: { $sum: '$items.total' },
        late: { $sum: '$items.lateFee' },
        count: { $sum: 1 },
      },
    },
  ]);

  const zero = () => ({ collected: 0, late: 0, count: 0, outstanding: 0 });
  const byType = Object.fromEntries(TYPES.map((t) => [t, zero()]));
  const monthMap = new Map();
  const deptMap = new Map();
  for (const r of rows) {
    const t = reportType(r._id.type);
    byType[t].collected += r.collected;
    byType[t].late += r.late;
    byType[t].count += r.count;
    const m = monthMap.get(r._id.month) || { month: r._id.month, examination: 0, promotion: 0, other: 0 };
    m[t] += r.collected;
    monthMap.set(r._id.month, m);
    const d = deptMap.get(String(r._id.department)) || { id: String(r._id.department), examination: 0, promotion: 0, other: 0 };
    d[t] += r.collected;
    deptMap.set(d.id, d);
  }

  // Outstanding = unpaid students x notice amount, for every published or closed notice.
  const noticeFilter = { status: { $in: [FEE_NOTICE_STATUS.PUBLISHED, FEE_NOTICE_STATUS.CLOSED] } };
  if (req.query.department) noticeFilter.department = req.query.department;
  const notices = await FeeNotice.find(noticeFilter).lean();
  for (const n of notices) {
    const students = (await semesterProfiles(n.semester)).filter((p) => String(p.department) === String(n.department)).length;
    const paid = await Payment.countDocuments({ status: PAYMENT_STATUS.PAID, 'items.notice': n._id });
    const t = reportType(n.feeType);
    byType[t].outstanding += Math.max(students - paid, 0) * n.amount;
  }

  const depts = await Department.find({ _id: { $in: [...deptMap.keys()] } }).select('name code').lean();
  const deptName = new Map(depts.map((d) => [String(d._id), d.name]));
  const departments = [...deptMap.values()].map((d) => ({
    name: deptName.get(d.id) || 'Unknown',
    examination: d.examination, promotion: d.promotion, other: d.other, total: d.examination + d.promotion + d.other,
  })).sort((a, b) => b.total - a.total);

  const total = TYPES.reduce((s, t) => s + byType[t].collected, 0);
  const outstandingTotal = TYPES.reduce((s, t) => s + byType[t].outstanding, 0);
  sendSuccess(res, {
    total, outstandingTotal, byType,
    months: [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month)),
    departments,
  });
});

// Finance / head: totals for a period.
export const financialReport = asyncHandler(async (req, res) => {
  const match = { status: { $in: [PAYMENT_STATUS.PAID, PAYMENT_STATUS.REFUNDED] } };
  if (req.query.department) match.department = req.query.department;
  if (req.query.from || req.query.to) {
    match.paidAt = {};
    if (req.query.from) match.paidAt.$gte = req.query.from;
    if (req.query.to) match.paidAt.$lte = req.query.to;
  }
  if (match.department) match.department = oid(match.department);

  const [totals, byDepartment, byMonth, lateFees] = await Promise.all([
    Payment.aggregate([{ $match: match }, { $group: { _id: { status: '$status', method: '$method' }, count: { $sum: 1 }, amount: { $sum: '$totalAmount' } } }]),
    Payment.aggregate([{ $match: { ...match, status: PAYMENT_STATUS.PAID } }, { $group: { _id: '$department', count: { $sum: 1 }, amount: { $sum: '$totalAmount' } } }, { $lookup: { from: 'departments', localField: '_id', foreignField: '_id', as: 'd' } }, { $project: { count: 1, amount: 1, department: { $arrayElemAt: ['$d.name', 0] } } }]),
    Payment.aggregate([{ $match: { ...match, status: PAYMENT_STATUS.PAID } }, { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$paidAt' } }, count: { $sum: 1 }, amount: { $sum: '$totalAmount' } } }, { $sort: { _id: 1 } }]),
    Payment.aggregate([{ $match: { ...match, status: PAYMENT_STATUS.PAID } }, { $unwind: '$items' }, { $group: { _id: null, lateFees: { $sum: '$items.lateFee' } } }]),
  ]);
  const pick = (status, method) => totals.find((t) => t._id.status === status && t._id.method === method) || { count: 0, amount: 0 };
  sendSuccess(res, {
    collected: { online: pick('paid', 'gateway'), office: pick('paid', 'manual'), bank: pick('paid', 'bank') },
    refunded: {
      count: pick('refunded', 'gateway').count + pick('refunded', 'manual').count + pick('refunded', 'bank').count,
      amount: pick('refunded', 'gateway').amount + pick('refunded', 'manual').amount + pick('refunded', 'bank').amount,
    },
    lateFeesCollected: lateFees[0]?.lateFees || 0,
    byDepartment,
    byMonth: byMonth.map((m) => ({ month: m._id, count: m.count, amount: m.amount })),
  });
});
