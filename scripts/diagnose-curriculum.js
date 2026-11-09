// Shows how the curriculum reader sees a PDF / Word / text file, so you can find out WHY a semester ended up with too few subjects.
//
//   cd server
//   node scripts/diagnose-curriculum.js "uploads/private/curriculum/<file>.pdf"
//
// It uses exactly the same text extraction and the same rule-based reader as the "BS Curriculum" page (the AI is not used here),
// prints what was found per semester, the lines that look like courses but were NOT counted, and the lines around each
// "Semester" heading. It also writes the raw extracted text to curriculum-text.txt, so you can open it or send it to someone.
// Nothing in the database is changed.
import fs from 'fs';
import { extractText } from '../src/services/textExtractService.js';
import { explodeLines, parseCurriculumRules, normalizeCode } from '../src/services/curriculumService.js';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('Usage: node scripts/diagnose-curriculum.js "<path to the curriculum file>"');
  process.exit(1);
}
const lower = file.toLowerCase();
const mime = lower.endsWith('.pdf')
  ? 'application/pdf'
  : lower.endsWith('.docx')
  ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  : 'text/plain';

const text = (await extractText(file, mime)) || '';
fs.writeFileSync('curriculum-text.txt', text);
const lines = explodeLines(text).split('\n').map((l) => l.replace(/\s+/g, ' ').trim());

console.log(`\nFile: ${file}`);
console.log(`Extracted ${text.length} characters, ${lines.length} lines (saved to curriculum-text.txt)\n`);
if (text.length < 200) {
  console.log('Almost no text could be extracted. If this is a scanned or photographed document, it has no text layer.');
  console.log('Upload a text-based PDF or a Word file, or add the subjects by hand on the review screen.\n');
}

const { programs, warnings } = parseCurriculumRules(text);

console.log('=== What the reader found ===');
if (!programs.length) console.log('(nothing)');
for (const p of programs) {
  console.log(`\n${p.name}`);
  for (const s of [...p.semesters].sort((a, b) => a.number - b.number)) {
    const core = s.subjects.filter((x) => !x.elective);
    const electives = s.subjects.length - core.length;
    const flag = core.length <= 1 ? '   <-- only ONE or none: look below' : '';
    console.log(`  Semester ${s.number}: ${core.length} subject(s)${electives ? ` + ${electives} elective option(s)` : ''}${flag}`);
    for (const x of core) console.log(`      ${x.code}  ${x.title}  (${x.creditHours} cr)`);
  }
}

console.log('\n=== Reader warnings ===');
if (!warnings.length) console.log('(none)');
warnings.forEach((w) => console.log(`- ${w}`));

// Lines that contain something that looks like a course code, but whose code is not among the subjects that were kept.
const kept = new Set(programs.flatMap((p) => p.semesters.flatMap((s) => s.subjects.map((x) => x.code))));
const CODE_LIKE = /\b([A-Z]{2,6})\s?-?\s?(\d{3,4}[A-Z]?)\b/;
const CREDIT_LIKE = /\d\s*\(\s*\d\s*[+\-,]\s*\d\s*\)/;
const missed = lines.map((l, i) => ({ l, i })).filter(({ l }) => {
  const m = l.match(CODE_LIKE);
  return m && CREDIT_LIKE.test(l) && !kept.has(normalizeCode(`${m[1]}-${m[2]}`));
});
console.log('\n=== Lines that look like courses (code + credit hours) but were NOT counted ===');
if (!missed.length) console.log('(none)');
missed.slice(0, 60).forEach(({ l, i }) => console.log(`line ${i + 1}: ${l.slice(0, 140)}`));
if (missed.length > 60) console.log(`... and ${missed.length - 60} more`);

console.log('\n=== The lines around every "Semester" heading (look for two semesters side by side, or a heading inside a table of contents) ===');
const HEADING = /^(?:semester|sem\.?|term)\s*[-:#]?\s*(?:\d{1,2}|[ivx]{1,4}|one|two|three|four|five|six|seven|eight)\b/i;
lines.forEach((l, i) => {
  if (!HEADING.test(l)) return;
  console.log(`\n--- line ${i + 1}: ${l.slice(0, 100)}`);
  lines.slice(i + 1, i + 6).forEach((x, k) => console.log(`    ${i + 2 + k}: ${x.slice(0, 120)}`));
});
console.log('\nDone.');
