import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import User from '../models/User.js';
import Book from '../models/Book.js';
import LibraryLoan from '../models/LibraryLoan.js';
import StudentProfile from '../models/StudentProfile.js';
import { ROLES } from '../config/constants.js';
import { addDays } from '../services/staffAttendanceRules.js';
import { escapeRegex } from '../services/libraryRules.js';
import * as lib from '../services/libraryService.js';

// ==========================================================================================================
// LIBRARY STARTER DATA:  npm run seed:library
//   1. a Library Controller account (only when the college has none yet)
//   2. real textbooks for semesters 1 to 8 (10 titles each; the library keeps up to 30 per semester), 2 to 3 copies of every title
//   3. when students exist (npm run seed:demo) and the library has no loans yet: a few example loans, so every screen has something to show
//        - one normal loan, one due tomorrow, one overdue (department complaint), one very overdue (department + principal), one returned
// Safe to run again: books that already exist (same title) are skipped, loans are only added to an empty library.
// Students are told through the in-app notification (the bell). There is no SMS.
// ==========================================================================================================

// [semester, title, authors, category]. No publisher, year or ISBN is invented: the librarian can add them in Library > Books.
const BOOKS = [
  [1, 'C How to Program', 'Paul Deitel, Harvey Deitel', 'Programming'],
  [1, 'The C Programming Language', 'Brian W. Kernighan, Dennis M. Ritchie', 'Programming'],
  [1, 'Programming in C', 'Stephen G. Kochan', 'Programming'],
  [1, 'Python Crash Course', 'Eric Matthes', 'Programming'],
  [1, 'Calculus: Early Transcendentals', 'James Stewart', 'Mathematics'],
  [1, 'Thomas\' Calculus', 'George B. Thomas', 'Mathematics'],
  [1, 'Computing Essentials', 'Timothy J. O\'Leary, Linda I. O\'Leary', 'Information Technology'],
  [1, 'Practical English Usage', 'Michael Swan', 'English'],
  [1, 'English Grammar in Use', 'Raymond Murphy', 'English'],
  [1, 'Pakistan: A Modern History', 'Ian Talbot', 'Social Sciences'],

  [2, 'Object-Oriented Programming in C++', 'Robert Lafore', 'Programming'],
  [2, 'C++ How to Program', 'Paul Deitel, Harvey Deitel', 'Programming'],
  [2, 'The C++ Programming Language', 'Bjarne Stroustrup', 'Programming'],
  [2, 'Discrete Mathematics and Its Applications', 'Kenneth H. Rosen', 'Mathematics'],
  [2, 'Linear Algebra and Its Applications', 'David C. Lay', 'Mathematics'],
  [2, 'Digital Design', 'M. Morris Mano, Michael D. Ciletti', 'Computer Engineering'],
  [2, 'Physics for Scientists and Engineers', 'Raymond A. Serway, John W. Jewett', 'Physics'],
  [2, 'The Elements of Style', 'William Strunk Jr., E. B. White', 'English'],
  [2, 'Head First Java', 'Kathy Sierra, Bert Bates', 'Programming'],
  [2, 'Introduction to Java Programming', 'Y. Daniel Liang', 'Programming'],

  [3, 'Data Structures and Algorithm Analysis in C++', 'Mark Allen Weiss', 'Data Structures'],
  [3, 'Introduction to Algorithms', 'Thomas H. Cormen, Charles E. Leiserson, Ronald L. Rivest, Clifford Stein', 'Algorithms'],
  [3, 'Data Structures Using C++', 'D. S. Malik', 'Data Structures'],
  [3, 'Database System Concepts', 'Abraham Silberschatz, Henry F. Korth, S. Sudarshan', 'Databases'],
  [3, 'Fundamentals of Database Systems', 'Ramez Elmasri, Shamkant B. Navathe', 'Databases'],
  [3, 'Probability and Statistics for Engineers and Scientists', 'Ronald E. Walpole, Raymond H. Myers', 'Mathematics'],
  [3, 'Computer Organization and Design', 'David A. Patterson, John L. Hennessy', 'Computer Architecture'],
  [3, 'Computer Organization and Architecture', 'William Stallings', 'Computer Architecture'],
  [3, 'A First Course in Differential Equations', 'Dennis G. Zill', 'Mathematics'],
  [3, 'SQL Cookbook', 'Anthony Molinaro', 'Databases'],

  [4, 'Operating System Concepts', 'Abraham Silberschatz, Peter B. Galvin, Greg Gagne', 'Operating Systems'],
  [4, 'Modern Operating Systems', 'Andrew S. Tanenbaum, Herbert Bos', 'Operating Systems'],
  [4, 'Computer Networking: A Top-Down Approach', 'James F. Kurose, Keith W. Ross', 'Networks'],
  [4, 'Computer Networks', 'Andrew S. Tanenbaum, David J. Wetherall', 'Networks'],
  [4, 'Software Engineering', 'Ian Sommerville', 'Software Engineering'],
  [4, 'Software Engineering: A Practitioner\'s Approach', 'Roger S. Pressman, Bruce R. Maxim', 'Software Engineering'],
  [4, 'Introduction to the Theory of Computation', 'Michael Sipser', 'Theory of Computation'],
  [4, 'Introduction to Automata Theory, Languages, and Computation', 'John E. Hopcroft, Rajeev Motwani, Jeffrey D. Ullman', 'Theory of Computation'],
  [4, 'Algorithm Design', 'Jon Kleinberg, Eva Tardos', 'Algorithms'],
  [4, 'Systems Analysis and Design', 'Kenneth E. Kendall, Julie E. Kendall', 'Software Engineering'],

  [5, 'Artificial Intelligence: A Modern Approach', 'Stuart Russell, Peter Norvig', 'Artificial Intelligence'],
  [5, 'Learning Web Design', 'Jennifer Niederst Robbins', 'Web Technologies'],
  [5, 'JavaScript: The Good Parts', 'Douglas Crockford', 'Web Technologies'],
  [5, 'Eloquent JavaScript', 'Marijn Haverbeke', 'Web Technologies'],
  [5, 'Human-Computer Interaction', 'Alan Dix, Janet Finlay, Gregory D. Abowd, Russell Beale', 'Human Computer Interaction'],
  [5, 'Compilers: Principles, Techniques, and Tools', 'Alfred V. Aho, Monica S. Lam, Ravi Sethi, Jeffrey D. Ullman', 'Compilers'],
  [5, 'Computer Graphics: C Version', 'Donald Hearn, M. Pauline Baker', 'Computer Graphics'],
  [5, 'Design Patterns: Elements of Reusable Object-Oriented Software', 'Erich Gamma, Richard Helm, Ralph Johnson, John Vlissides', 'Software Engineering'],
  [5, 'Clean Code', 'Robert C. Martin', 'Software Engineering'],
  [5, 'Refactoring', 'Martin Fowler', 'Software Engineering'],

  [6, 'Machine Learning', 'Tom M. Mitchell', 'Artificial Intelligence'],
  [6, 'Pattern Recognition and Machine Learning', 'Christopher M. Bishop', 'Artificial Intelligence'],
  [6, 'Deep Learning', 'Ian Goodfellow, Yoshua Bengio, Aaron Courville', 'Artificial Intelligence'],
  [6, 'Cryptography and Network Security', 'William Stallings', 'Information Security'],
  [6, 'Distributed Systems: Principles and Paradigms', 'Andrew S. Tanenbaum, Maarten van Steen', 'Distributed Systems'],
  [6, 'An Introduction to Parallel Programming', 'Peter Pacheco', 'Parallel Computing'],
  [6, 'Software Testing', 'Ron Patton', 'Software Engineering'],
  [6, 'Software Project Management', 'Bob Hughes, Mike Cotterell', 'Software Engineering'],
  [6, 'Cloud Computing: Concepts, Technology and Architecture', 'Thomas Erl, Ricardo Puttini, Zaigham Mahmood', 'Cloud Computing'],
  [6, 'Hands-On Machine Learning with Scikit-Learn, Keras, and TensorFlow', 'Aurelien Geron', 'Artificial Intelligence'],

  [7, 'Data Mining: Concepts and Techniques', 'Jiawei Han, Micheline Kamber, Jian Pei', 'Data Science'],
  [7, 'Hadoop: The Definitive Guide', 'Tom White', 'Data Science'],
  [7, 'Speech and Language Processing', 'Daniel Jurafsky, James H. Martin', 'Artificial Intelligence'],
  [7, 'Computer Vision: Algorithms and Applications', 'Richard Szeliski', 'Artificial Intelligence'],
  [7, 'Digital Image Processing', 'Rafael C. Gonzalez, Richard E. Woods', 'Artificial Intelligence'],
  [7, 'Research Methodology: Methods and Techniques', 'C. R. Kothari', 'Research'],
  [7, 'Ethics for the Information Age', 'Michael J. Quinn', 'Professional Practices'],
  [7, 'Introduction to Information Retrieval', 'Christopher D. Manning, Prabhakar Raghavan, Hinrich Schutze', 'Data Science'],
  [7, 'The Pragmatic Programmer', 'David Thomas, Andrew Hunt', 'Software Engineering'],
  [7, 'Mining of Massive Datasets', 'Jure Leskovec, Anand Rajaraman, Jeffrey D. Ullman', 'Data Science'],

  [8, 'The Lean Startup', 'Eric Ries', 'Entrepreneurship'],
  [8, 'Zero to One', 'Peter Thiel, Blake Masters', 'Entrepreneurship'],
  [8, 'Management', 'Stephen P. Robbins, Mary Coulter', 'Management'],
  [8, 'Security Engineering', 'Ross Anderson', 'Information Security'],
  [8, 'The Art of Computer Programming, Volume 1', 'Donald E. Knuth', 'Algorithms'],
  [8, 'Code Complete', 'Steve McConnell', 'Software Engineering'],
  [8, 'Designing Data-Intensive Applications', 'Martin Kleppmann', 'Software Engineering'],
  [8, 'Site Reliability Engineering', 'Betsy Beyer, Chris Jones, Jennifer Petoff, Niall Richard Murphy', 'Software Engineering'],
  [8, 'Writing for Computer Science', 'Justin Zobel', 'Research'],
  [8, 'The Mythical Man-Month', 'Frederick P. Brooks Jr.', 'Software Engineering'],
];

await connectDB();
const log = (m) => console.log(m);

// ---- 1. the library controller ----
let controller = await User.findOne({ role: ROLES.LIBRARY_CONTROLLER, isActive: true }).sort({ createdAt: 1 });
if (!controller) {
  const email = 'library@university.edu';
  const password = 'Library@2026#';
  controller = (await User.findOne({ email })) || (await User.create({ name: 'Library Controller', email, password, role: ROLES.LIBRARY_CONTROLLER, mustChangePassword: true }));
  log(`Library controller created: ${email}  /  ${password}  (must choose a new password at the first login)`);
  fs.appendFileSync(path.resolve('demo-credentials.txt'), `\nLibrary Controller     Library Controller       ${email.padEnd(36)} ${password}\n`);
} else {
  log(`Library controller already exists: ${controller.email}`);
}

// ---- 2. the books ----
let added = 0;
let skipped = 0;
const perSemester = new Map();
for (const [sem, title, authors, category] of BOOKS) {
  const exists = await Book.findOne({ title: new RegExp(`^${escapeRegex(title)}$`, 'i'), status: 'active' });
  if (exists) { skipped += 1; continue; }
  const n = (perSemester.get(sem) || 0) + 1;
  perSemester.set(sem, n);
  try {
    await lib.createBook({
      title, authors: authors.split(/,\s*(?=[A-Z])/), category, language: 'English', shelf: `Semester ${sem} · Rack ${String.fromCharCode(64 + sem)}-${n}`,
      description: `Recommended reading for semester ${sem}.`, price: 1500 + ((n * 37 + sem * 101) % 50) * 100, semesterNumber: sem, copies: n <= 2 ? 3 : 2,
    }, controller);
    added += 1;
  } catch (err) {
    log(`Could not add "${title}": ${err.message}`);
  }
}
log(`Books: ${added} added, ${skipped} already in the library.`);

// ---- 3. example loans (only into an empty library) ----
if ((await LibraryLoan.countDocuments({})) === 0) {
  const profiles = await StudentProfile.find({ status: 'active' }).populate('semester', 'number').sort({ rollNumber: 1 });
  const picks = [];
  const seen = new Set();
  for (const p of profiles) {
    const sem = p.semester?.number;
    if (!sem || seen.has(sem)) continue;
    seen.add(sem);
    picks.push({ profile: p, sem });
    if (picks.length === 5) break;
  }
  if (!picks.length) {
    log('No students yet, so no example loans. Run "npm run seed:demo" first, then "npm run seed:library" again.');
  } else {
    const today = await lib.libraryToday();
    const backdate = async (loan, issuedAgo, dueAgo) => LibraryLoan.updateOne({ _id: loan._id }, { issuedDay: addDays(today, -issuedAgo), dueDay: addDays(today, -dueAgo), originalDueDay: addDays(today, -dueAgo) });
    // what happens to each student's book: [description, then a change after issuing]
    const plans = [
      ['normal loan', null],
      ['due tomorrow (a reminder is sent)', (l) => backdate(l, 13, -1)],
      ['10 days overdue (department complaint)', (l) => backdate(l, 24, 10)],
      ['returned on time', 'return'],
      ['40 days overdue (department and principal)', (l) => backdate(l, 54, 40)],
    ];
    for (let i = 0; i < picks.length; i += 1) {
      const { profile, sem } = picks[i];
      const [what, change] = plans[i];
      try {
        const book = await Book.findOne({ semesterNumber: sem, status: 'active', copiesAvailable: { $gt: 0 } }).sort({ bookId: 1 }).skip(i % 3);
        if (!book) { log(`No free book for semester ${sem}`); continue; }
        const r = await lib.issueBook({ student: profile.rollNumber, code: book.bookId, issuer: controller });
        if (change === 'return') await lib.returnBook({ loanId: r.loan._id, receiver: controller });
        else if (change) await change(r.loan);
        log(`Loan: ${profile.rollNumber} - "${book.title}" (${what})`);
      } catch (err) {
        log(`Could not issue to ${profile.rollNumber}: ${err.message}`);
      }
    }
    const jobs = await lib.runLibraryJobs({ force: true });
    log(`Reminders and complaints: ${JSON.stringify(jobs)}`);
  }
} else {
  log('The library already has loans, so no example loans were added.');
}

log('\nDone. Log in as the library controller to work, or as the principal to watch (Library Monitoring).');
await mongoose.connection.close();
