export const ROLES = Object.freeze({
  UNIVERSITY_HEAD: 'university_head',
  HOD: 'hod',
  FINANCE_OFFICER: 'finance_officer',
  LIBRARY_CONTROLLER: 'library_controller', // runs the library. Created by the principal, belongs to no department (like the finance officer)
  TEACHER: 'teacher',
  STUDENT: 'student',
});

export const ROLE_LIST = Object.values(ROLES);

export const DEPARTMENT_STATUS = Object.freeze({
  ACTIVE: 'active',
  ARCHIVED: 'archived',
});

export const SEMESTER_STATUS = Object.freeze({
  UPCOMING: 'upcoming',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  ARCHIVED: 'archived',
});

export const COURSE_STATUS = Object.freeze({
  ACTIVE: 'active',
  ARCHIVED: 'archived',
});

export const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// ---------- Phase 3 ----------
export const STUDENT_STATUS = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  GRADUATED: 'graduated',
  WITHDRAWN: 'withdrawn',
});

export const ENROLLMENT_STATUS = Object.freeze({
  ENROLLED: 'enrolled',
  DROPPED: 'dropped', // kept for history, never deleted
});

export const TIMETABLE_STATUS = Object.freeze({
  DRAFT: 'draft',
  PUBLISHED: 'published',
});

// Types that stop teaching on their days (see services/teachingCalendar.js): holiday, midterm_exam, final_exam,
// summer_vacation, winter_vacation, semester_break. "semester_start", "semester_end" and "event" do not.
export const CALENDAR_EVENT_TYPES = [
  'semester_start',
  'semester_end',
  'midterm_exam',
  'final_exam',
  'summer_vacation',
  'winter_vacation',
  'semester_break',
  'holiday',
  'event',
];

// Semesters in these states no longer accept changes to enrollments or timetables.
export const CLOSED_SEMESTER_STATES = [SEMESTER_STATUS.COMPLETED, SEMESTER_STATUS.ARCHIVED];

// ---------- Phase 4: teaching ----------
export const ATTENDANCE_STATUS = Object.freeze({ PRESENT: 'present', ABSENT: 'absent', LEAVE: 'leave' });
export const ASSIGNMENT_TYPES = ['assignment', 'presentation'];
export const QUIZ_TYPES = ['scheduled', 'surprise'];
export const QUIZ_STATUS = Object.freeze({ DRAFT: 'draft', SCHEDULED: 'scheduled', LIVE: 'live', CLOSED: 'closed' });
export const ATTEMPT_STATUS = Object.freeze({ IN_PROGRESS: 'in_progress', SUBMITTED: 'submitted', AUTO_SUBMITTED: 'auto_submitted' });

// ---------- Phase 5: examinations ----------
export const EXAM_TYPES = ['midterm', 'final', 'other'];
export const EXAM_STATUS = Object.freeze({ DRAFT: 'draft', PUBLISHED: 'published' });
export const MARKS_STATUS = Object.freeze({ DRAFT: 'draft', SUBMITTED: 'submitted' });
export const RESULT_STATUS = Object.freeze({ DRAFT: 'draft', PUBLISHED: 'published' });

// ---------- Phase 6: fees and admission ----------
export const FEE_TYPES = ['examination', 'practical', 'promotion', 'other'];
export const FEE_NOTICE_STATUS = Object.freeze({ DRAFT: 'draft', PUBLISHED: 'published', CLOSED: 'closed' });
export const PAYMENT_STATUS = Object.freeze({ PENDING: 'pending', PAID: 'paid', FAILED: 'failed', REFUNDED: 'refunded' });
export const REVIEW_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  REQUIRES_CORRECTION: 'requires_correction',
});

// ---------- Phase 7: complaints ----------
export const COMPLAINT_CATEGORIES = [
  'teacher_change_request',
  'teacher_complaint',
  'attendance_correction',
  'result_correction',
  'facility_complaint',
  'fee_complaint',
  'record_correction',
  'other',
];
export const COMPLAINT_RECIPIENTS = ['hod', 'university_head', 'finance_officer'];
export const COMPLAINT_STATUS = Object.freeze({ OPEN: 'open', IN_REVIEW: 'in_review', RESOLVED: 'resolved', REJECTED: 'rejected' });

// ---------- Library ----------
// Complaints the library files by itself when a student does not return a book. They live in the normal Complaint collection, so the HOD
// (and the principal) review and resolve them on the existing Complaints page. Students cannot pick these categories themselves.
export const LIBRARY_COMPLAINT_CATEGORIES = ['library_overdue', 'library_lost'];
export const BOOK_COPY_STATUS = Object.freeze({
  AVAILABLE: 'available',
  ISSUED: 'issued',
  RESERVED: 'reserved', // held at the desk for the student who reserved the book
  LOST: 'lost',
  DAMAGED: 'damaged',
  WITHDRAWN: 'withdrawn', // taken out of the collection (kept for history)
});
export const LOAN_STATUS = Object.freeze({ ISSUED: 'issued', RETURNED: 'returned', LOST: 'lost' });
export const RESERVATION_STATUS = Object.freeze({ WAITING: 'waiting', READY: 'ready', FULFILLED: 'fulfilled', CANCELLED: 'cancelled', EXPIRED: 'expired' });
// A student's "Request book" (a book that is available now): pending -> approved (a copy is held at the desk) -> collected (issued), or rejected / cancelled / expired.
export const REQUEST_STATUS = Object.freeze({ PENDING: 'pending', APPROVED: 'approved', COLLECTED: 'collected', REJECTED: 'rejected', CANCELLED: 'cancelled', EXPIRED: 'expired' });

// ---------- New student admission applications (public portal) ----------
export const APPLICATION_STATUS = Object.freeze({
  SUBMITTED: 'submitted',
  UNDER_REVIEW: 'under_review',
  NEEDS_INFO: 'needs_info',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
});
