import FeeCart from '../models/FeeCart.js';
import FeeNotice from '../models/FeeNotice.js';
import User from '../models/User.js';
import { ApiError, asyncHandler, sendSuccess } from '../utils/apiHelpers.js';
import { buildRequirements, missingDocuments } from '../services/requirementService.js';
import { ROLES } from '../config/constants.js';

// The requirements form of a payment: mobile number + the documents the chosen fees ask for, each with its current state.
const view = async (studentId, notices) => {
  const user = await User.findById(studentId).select('phone');
  const form = await buildRequirements({ studentId, notices, phone: user?.phone || '' });
  return {
    phone: user?.phone || '',
    text: form.text,
    documents: form.documents,
    missing: missingDocuments(form),
    fees: notices.map((n) => ({ notice: n._id, title: n.title, requirements: n.requirements, documents: n.requiredDocuments })),
  };
};

// Student: for the fees currently in the cart.
export const myRequirements = asyncHandler(async (req, res) => {
  const cart = await FeeCart.findOne({ student: req.user._id });
  const notices = await FeeNotice.find({ _id: { $in: (cart?.items || []).map((i) => i.notice) } });
  sendSuccess(res, await view(req.user._id, notices));
});

// Finance officer: for the student at the counter and the fees the officer ticked (?notices=id1,id2).
export const studentRequirements = asyncHandler(async (req, res) => {
  const student = await User.findOne({ _id: req.params.id, role: ROLES.STUDENT }).select('_id');
  if (!student) throw ApiError.notFound('Student not found');
  const ids = String(req.query.notices || '').split(',').map((s) => s.trim()).filter((s) => /^[a-f\d]{24}$/i.test(s));
  const notices = ids.length ? await FeeNotice.find({ _id: { $in: ids } }) : [];
  sendSuccess(res, await view(student._id, notices));
});
