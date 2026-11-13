// ==========================================================================================================
// Spelling help for the assistant (pure, no database, unit tested).
//   fixSpelling("show attendnce of techers")  ->  { text: "show attendance of teachers", fixes: [...] }
//   closeMatches("kafel", ["kafeel", "ali"])   ->  [{ value: "kafeel", distance: 1 }]
// Only words the assistant knows (its own vocabulary and the department names) are corrected, and only when the match is
// close and unique. A student's or teacher's name is never rewritten here (names are fixed later, against the real names in
// the database, see assistantBrain.js).
// ==========================================================================================================

// Optimal string alignment distance: insert, delete, replace, or swap two neighbouring letters (each counts as 1 mistake).
export const editDistance = (a, b) => {
  const x = String(a);
  const y = String(b);
  const d = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= x.length; i += 1) {
    for (let j = 1; j <= y.length; j += 1) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[x.length][y.length];
};

// The words the assistant understands. Also used by recordsParse.js so these words are never mistaken for a person's name.
export const VOCAB = `students student teachers teacher faculty lecturers lecturer professors professor staff
attendance absent absentees present
fees fee payment payments paid unpaid pending outstanding collected collection revenue income
refund refunds balance amount amounts receipt receipts challan defaulters dues
semester semesters department departments course courses subject subjects curriculum timetable
promotion promoted examination examinations exam exams result results marks grade grades percentage
total totals statistics report reports summary overview college university principal finance
details detail record records number enrolled information list show`.split(/\s+/).filter(Boolean);

// Ordinary English words that look like a vocabulary word with one mistake. They must never be "corrected".
const ENGLISH_OK = new Set(`summer member members teaching teaches taught states state stated graded grader trades recorded recorder reported reporter
marked marker paying payer balanced feels feeds feeling graph grand grace grape grain stuff stiff prevent presence pressed collage`.split(/\s+/));

// A few very common slips of short words (short words are otherwise left alone, because they may be a name).
const TYPOS = { fess: 'fees', fese: 'fees', feez: 'fees', feee: 'fees' };

const maxMistakes = (len) => (len <= 6 ? 1 : 2);

export const fixSpelling = (question, extraWords = []) => {
  const source = String(question ?? '');
  const extra = extraWords.map((w) => String(w).toLowerCase()).filter(Boolean);
  const known = new Set([...VOCAB, ...ENGLISH_OK, ...extra]);
  const targets = [...new Set([...VOCAB, ...extra.filter((w) => w.length >= 5)])];
  const fixes = [];

  const text = source.replace(/[A-Za-z]+/g, (word, offset) => {
    const lower = word.toLowerCase();
    let fixed = TYPOS[lower] || null;

    if (!fixed) {
      if (word.length < 5 || known.has(lower)) return word;
      // A capital letter in the middle of a sentence is probably a name: leave it.
      const before = source.slice(0, offset).trimEnd();
      const sentenceStart = before === '' || /[.!?\n]$/.test(before);
      if (/^[A-Z]/.test(word) && !/^[A-Z]+$/.test(word) && !sentenceStart) return word;

      const max = maxMistakes(lower.length);
      let best = [];
      let bestDistance = Infinity;
      for (const v of targets) {
        if (v[0] !== lower[0] || Math.abs(v.length - lower.length) > max) continue;
        const d = editDistance(lower, v);
        if (d > max) continue;
        if (d < bestDistance) { bestDistance = d; best = [v]; } else if (d === bestDistance) best.push(v);
      }
      if (!best.length) return word;
      if (best.length > 1) {
        // "studens" is close to "student" and "students": accept it only when the candidates are the same word (singular / plural).
        best.sort((a, b) => b.length - a.length);
        const stem = best[best.length - 1];
        if (!best.every((v) => v.startsWith(stem))) return word;
      }
      [fixed] = best;
    }

    if (fixed === lower) return word;
    const out = /^[A-Z]+$/.test(word) && word.length > 1 ? fixed.toUpperCase() : /^[A-Z]/.test(word) ? fixed[0].toUpperCase() + fixed.slice(1) : fixed;
    fixes.push({ from: word, to: out });
    return out;
  });

  const seen = new Set();
  return { text, fixes: fixes.filter((f) => (seen.has(f.from.toLowerCase()) ? false : seen.add(f.from.toLowerCase()))) };
};

// Candidates that are a small distance away from `word` (for "Did you mean ...?"). Short words are never guessed.
export const closeMatches = (word, candidates, { max = 3 } = {}) => {
  const w = String(word).toLowerCase();
  const allowed = w.length <= 3 ? 0 : w.length <= 6 ? 1 : 2;
  if (!allowed) return [];
  const best = new Map();
  for (const c of candidates) {
    const v = String(c).toLowerCase();
    if (v === w || Math.abs(v.length - w.length) > allowed) continue;
    const d = editDistance(w, v);
    if (d <= allowed && (!best.has(v) || best.get(v) > d)) best.set(v, d);
  }
  return [...best].map(([value, distance]) => ({ value, distance })).sort((a, b) => a.distance - b.distance || a.value.localeCompare(b.value)).slice(0, max);
};

// "Spelling corrected: attendnce → attendance, techers → teachers"
export const describeFixes = (fixes) => (fixes.length ? `I corrected the spelling: ${fixes.map((f) => `${f.from} → ${f.to}`).join(', ')}.` : '');
