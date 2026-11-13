import Book from '../models/Book.js';
import { ROLES } from '../config/constants.js';
import { studentSummary, libraryOverview, bookView, findStudent, studentHistory, libraryToday, getCurrency } from './libraryService.js';
import LibraryRules from '../models/LibraryRules.js';
import { detectIntents, keywordsOf, escapeRegex } from './libraryRules.js';

// ============================================================================================================
// The library chatbot: what it may know about the person asking, and an answer that needs no AI key.
//
//   * A STUDENT gets ONLY their own loans, fines and reservations (studentSummary(user._id)). No other student's data is ever loaded,
//     whatever the message says, so the AI model (and the fallback below) cannot reveal it.
//   * The LIBRARY CONTROLLER gets the library totals, and the history of a student whose roll number is typed in the message.
//   * Everybody gets the public catalogue (titles, authors, categories, availability).
// The user is always the logged-in user from the token, never something that is written in the message.
// ============================================================================================================

const BOOK_FIELDS = (b) => `${b.title}${b.authors?.length ? ` by ${b.authors.join(', ')}` : ''} [${b.bookId}] · ${b.category} · ${b.copiesAvailable > 0 ? `${b.copiesAvailable} of ${b.copiesTotal} available` : 'no copy available now'}${b.shelf ? ` · shelf ${b.shelf}` : ''}`;

const searchBooks = async (message, intents) => {
  const words = keywordsOf(message);
  const base = { status: 'active' };
  let books = [];
  if (words.length) {
    const rx = words.map((w) => new RegExp(escapeRegex(w), 'i'));
    const field = (r) => ({ $or: [{ title: r }, { authors: r }, { category: r }, { isbn: r }, { bookId: r }, { publisher: r }] });
    books = await Book.find({ ...base, $and: rx.map(field) }).sort({ copiesAvailable: -1, title: 1 }).limit(12).lean(); // every word must match
    if (!books.length) books = await Book.find({ ...base, $or: rx.flatMap((r) => field(r).$or) }).sort({ copiesAvailable: -1, title: 1 }).limit(12).lean(); // any word
  } else if (intents.has('available')) {
    books = await Book.find({ ...base, copiesAvailable: { $gt: 0 } }).sort({ title: 1 }).limit(15).lean();
  }
  return books.map((b) => bookView(b, false));
};

const rollTokens = (message) => (String(message).match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/g) || []).filter((t) => /\d/.test(t)).slice(0, 2);

export const loadLibraryContext = async (user, message, previous = '') => {
  const asked = detectIntents(message);
  const intents = asked.size ? asked : detectIntents(previous); // a follow-up such as "and the fine?" has no keyword of its own
  const [today, currency, rules] = await Promise.all([libraryToday(), getCurrency(), LibraryRules.getRules()]);
  const ctx = {
    role: user.role, name: user.name, today, currency, intents: [...intents],
    rules: { loanDays: rules.loanDays, maxBooksPerStudent: rules.maxBooksPerStudent, maxRenewals: rules.maxRenewals, renewDays: rules.renewDays, finePerDay: rules.finePerDay, graceDays: rules.graceDays, reservationHoldDays: rules.reservationHoldDays, maxReservationsPerStudent: rules.maxReservationsPerStudent },
    books: await searchBooks(message, intents),
    categories: intents.has('available') ? (await Book.distinct('category', { status: 'active' })).sort().slice(0, 40) : [],
  };
  if (user.role === ROLES.STUDENT) {
    ctx.me = await studentSummary(user._id); // the logged-in student only
  } else {
    ctx.overview = await libraryOverview();
    ctx.students = [];
    for (const t of rollTokens(message)) {
      try { const found = await findStudent(t); ctx.students.push(await studentHistory(found.user._id)); } catch { /* not a roll number */ }
    }
  }
  return ctx;
};

const cur = (ctx, n) => `${ctx.currency} ${n}`;
const loanLine = (ctx, l) => `${l.book?.title} (copy ${l.copyCode}): issued ${l.issuedDay}, due ${l.dueDay}, ${l.state === 'overdue' ? `OVERDUE by ${l.overdueDays} day(s), fine so far ${cur(ctx, l.fine)}` : `${l.daysLeft} day(s) left`}${l.renewals ? `, renewed ${l.renewals}x` : ''}`;

// The facts as text for the AI model (it may only use this).
export const libraryText = (ctx) => {
  const out = [`Today: ${ctx.today}. Currency: ${ctx.currency}. The user is a ${ctx.role === ROLES.STUDENT ? 'student' : 'library controller'} named ${ctx.name}.`];
  out.push(`Library rules: loan period ${ctx.rules.loanDays} days; at most ${ctx.rules.maxBooksPerStudent} books at a time; ${ctx.rules.maxRenewals ? `renewable ${ctx.rules.maxRenewals} time(s), ${ctx.rules.renewDays} extra days each` : 'books cannot be renewed'}; late fine ${cur(ctx, ctx.rules.finePerDay)} per book per day${ctx.rules.graceDays ? ` after ${ctx.rules.graceDays} grace day(s)` : ''}; a reserved book is held ${ctx.rules.reservationHoldDays} days; at most ${ctx.rules.maxReservationsPerStudent} reservations.`);
  out.push('How to borrow: find the book in the Library page, take it to the library desk with your student card; the library controller scans the book and issues it. How to return: bring the book to the desk; the controller scans it and records the return. A fine is charged for every late day. If all copies are out, reserve the book on the Library page and it is held for you when one comes back.');
  if (ctx.me) {
    const m = ctx.me;
    out.push(`THIS STUDENT'S OWN LIBRARY RECORD: books now ${m.totals.active}, overdue ${m.totals.overdue}, total fine/charges still to pay ${cur(ctx, m.totals.pending)}, books returned so far ${m.totals.returned}, lost ${m.totals.lost}.`);
    out.push(m.current.length ? `Books borrowed now:\n${m.current.map((l) => `- ${loanLine(ctx, l)}`).join('\n')}` : 'Books borrowed now: none.');
    if (m.unpaid.length) out.push(`Fines to pay on returned/lost books:\n${m.unpaid.map((l) => `- ${l.book?.title}: ${cur(ctx, l.pending)}`).join('\n')}`);
    if (m.reservations.length) out.push(`Reservations:\n${m.reservations.map((r) => `- ${r.book?.title}: ${r.status === 'ready' ? `READY, collect by ${r.holdUntilDay}` : `waiting, position ${r.position}`}`).join('\n')}`);
  }
  if (ctx.overview) {
    const o = ctx.overview;
    out.push(`LIBRARY TOTALS: titles ${o.books.titles}, copies ${o.books.copies}, available ${o.books.available}, issued ${o.books.issued}, lost ${o.books.lost}, damaged ${o.books.damaged}; overdue loans ${o.loans.overdue}; fines to collect ${cur(ctx, o.fines.pending)}; reservations waiting ${o.reservations.waiting}; open complaints ${o.complaints.open}.`);
    for (const s of ctx.students) out.push(`STUDENT ${s.student.name} (${s.student.rollNumber}): books now ${s.totals.active}, overdue ${s.totals.overdue}, pending ${cur(ctx, s.totals.pending)}.\n${s.loans.filter((l) => l.status === 'issued').map((l) => `- ${loanLine(ctx, l)}`).join('\n')}`);
  }
  if (ctx.books.length) out.push(`CATALOGUE MATCHES:\n${ctx.books.map((b) => `- ${BOOK_FIELDS(b)}`).join('\n')}`);
  if (ctx.categories.length) out.push(`Categories: ${ctx.categories.join(', ')}.`);
  return out.join('\n\n');
};

const HELP = `I can help with the library. Ask me for example:
- **Which books are available?** (or a title, author or subject, e.g. "books on algorithms")
- **Which books have I borrowed?**
- **When is my return deadline?**
- **Do I have overdue books?**
- **What is my pending fine?**
- **How can I borrow or return a book?**`;

// An answer from the database facts alone (used when no AI key is configured). Never invents anything.
export const libraryFallback = (ctx, message) => {
  const has = (k) => ctx.intents.includes(k);
  const parts = [];
  const m = ctx.me;

  if (m) {
    if (has('overdue') || has('deadline') || has('borrowed') || has('fine')) {
      if (has('overdue') && !has('borrowed') && !has('deadline')) {
        const late = m.current.filter((l) => l.state === 'overdue');
        parts.push(late.length ? `**You have ${late.length} overdue book(s):**\n${late.map((l) => `- ${loanLine(ctx, l)}`).join('\n')}\n\nPlease return ${late.length === 1 ? 'it' : 'them'} to the library desk as soon as possible; the fine grows every day.` : '**No overdue books.** Everything you borrowed is still within its deadline.');
      } else if (has('deadline') && !has('fine')) {
        parts.push(m.current.length ? `**Your return deadlines:**\n${m.current.map((l) => `- ${l.book?.title}: **${l.dueDay}** (${l.state === 'overdue' ? `${l.overdueDays} day(s) overdue` : `${l.daysLeft} day(s) left`})`).join('\n')}` : 'You have no borrowed books, so you have no return deadline.');
      } else if (has('fine') && !has('borrowed')) {
        parts.push(m.totals.pending > 0
          ? `**Your pending library fine: ${cur(ctx, m.totals.pending)}**\n${[...m.current.filter((l) => l.pending > 0).map((l) => `- ${l.book?.title} (still with you, growing): ${cur(ctx, l.pending)}`), ...m.unpaid.map((l) => `- ${l.book?.title}: ${cur(ctx, l.pending)}`)].join('\n')}\n\nPay it at the library desk.`
          : '**You have no pending fine.** ');
      } else {
        parts.push(m.current.length ? `**Books you have borrowed now (${m.current.length}):**\n${m.current.map((l) => `- ${loanLine(ctx, l)}`).join('\n')}` : 'You have no borrowed books right now.');
        if (has('fine') || m.totals.pending > 0) parts.push(`Pending fine: **${cur(ctx, m.totals.pending)}**.`);
      }
    }
    if (has('borrowed') && /history|before|returned|past|earlier/i.test(message) && m.history.length) {
      parts.push(`**Your recent borrowing history:**\n${m.history.slice(0, 8).map((l) => `- ${l.book?.title}: ${l.issuedDay} to ${l.returnedDay || '-'} (${l.status})`).join('\n')}`);
    }
    if (has('reserve') && m.reservations.length) {
      parts.push(`**Your reservations:**\n${m.reservations.map((r) => `- ${r.book?.title}: ${r.status === 'ready' ? `ready, collect by ${r.holdUntilDay}` : `waiting, position ${r.position}`}`).join('\n')}`);
    }
  } else if (ctx.overview) {
    const o = ctx.overview;
    if (has('overdue') || has('fine') || has('borrowed')) parts.push(`**Library today (${ctx.today}):** ${o.loans.issued} books are out, **${o.loans.overdue} overdue**, fines to collect ${cur(ctx, o.fines.pending)}, ${o.students.withOverdue} student(s) have an overdue book.`);
    for (const s of ctx.students) parts.push(`**${s.student.name} (${s.student.rollNumber}):** ${s.totals.active} book(s) now, ${s.totals.overdue} overdue, pending ${cur(ctx, s.totals.pending)}.`);
  }

  if (has('howBorrow')) parts.push(`**How to borrow a book**\n1. Search the book on the Library page and check that a copy is available.\n2. Go to the library desk with your student card.\n3. The library controller scans the book and you. It is issued for **${ctx.rules.loanDays} days** (up to ${ctx.rules.maxBooksPerStudent} books at a time), and you get a message with the return date.`);
  if (has('howReturn')) parts.push(`**How to return a book**\n1. Bring the book to the library desk before the deadline.\n2. The controller scans it and records the return; you get a confirmation message.\n3. ${ctx.rules.maxRenewals ? `You can renew a book up to ${ctx.rules.maxRenewals} time(s) (${ctx.rules.renewDays} more days) from the Library page, if nobody is waiting for it and it is not overdue.` : 'Books cannot be renewed.'}\n4. After the deadline the fine is ${cur(ctx, ctx.rules.finePerDay)} per day${ctx.rules.graceDays ? ` (after ${ctx.rules.graceDays} grace day(s))` : ''}.`);
  if (has('rules') && !has('howBorrow') && !has('howReturn')) parts.push(`**Library rules:** loan period ${ctx.rules.loanDays} days · up to ${ctx.rules.maxBooksPerStudent} books · ${ctx.rules.maxRenewals ? `${ctx.rules.maxRenewals} renewal(s) of ${ctx.rules.renewDays} days` : 'no renewals'} · late fine ${cur(ctx, ctx.rules.finePerDay)} per day · reserved books are held ${ctx.rules.reservationHoldDays} days.`);
  if (has('reserve') && !m?.reservations.length) parts.push(`**Reservations:** if every copy of a book is out, press **Reserve** on that book in the Library page. When a copy comes back it is held at the desk for you for ${ctx.rules.reservationHoldDays} days and you get a message. You can reserve up to ${ctx.rules.maxReservationsPerStudent} books.`);

  if (ctx.books.length) parts.push(`**${has('available') || !ctx.intents.length ? 'Books found' : 'Matching books'}:**\n${ctx.books.map((b) => `- ${BOOK_FIELDS(b)}`).join('\n')}`);
  else if (ctx.categories.length) parts.push(`No book list matched. The library has these categories: ${ctx.categories.join(', ')}. Ask for a title, an author or a subject.`);
  else if (has('available')) parts.push('No book is available right now that matches your question.');

  return parts.length ? parts.join('\n\n') : HELP;
};
