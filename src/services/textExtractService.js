import fs from 'fs';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse/lib/pdf-parse.js'; // the package root runs a debug script on import, so we import the library file

const decodeXml = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Pulls the readable text out of a PowerPoint file: every <a:t> element of every slide.
const pptxText = async (filePath) => {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const parts = [];
  for (const name of slides) {
    const xml = await zip.files[name].async('string');
    const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1]));
    if (texts.length) parts.push(texts.join(' '));
  }
  return parts.join('\n\n');
};

// Returns plain text, or '' for formats we cannot read (images).
export const extractText = async (filePath, mimeType) => {
  switch (mimeType) {
    case 'application/pdf':
      return (await pdfParse(fs.readFileSync(filePath))).text || '';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return (await mammoth.extractRawText({ path: filePath })).value || '';
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return pptxText(filePath);
    case 'text/plain':
      return fs.readFileSync(filePath, 'utf8');
    default:
      return '';
  }
};

// Splits text into overlapping passages of about `size` characters, cutting at word boundaries.
export const chunkText = (text, size = 900, overlap = 150) => {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const lastSpace = clean.lastIndexOf(' ', end);
      if (lastSpace > start + size / 2) end = lastSpace;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    // The next passage starts `overlap` characters back, moved forward to the start of a whole word.
    let next = Math.max(end - overlap, start + 1);
    const space = clean.indexOf(' ', next);
    if (space !== -1 && space < end) next = space + 1;
    start = next;
  }
  return chunks.filter(Boolean);
};
