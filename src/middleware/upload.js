import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { ApiError } from '../utils/apiHelpers.js';

// On Vercel the project folder is READ-ONLY; only the temporary folder can be written, and it is wiped whenever the function
// restarts. Uploads therefore work there but do NOT last (see docs/VERCEL.md). On your own computer or a normal server they
// live in the uploads/ folder as before.
export const UPLOAD_ROOT = process.env.VERCEL ? path.join(os.tmpdir(), 'uploads') : path.resolve('uploads');

// Creating a folder must never stop the whole server from starting.
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.warn(`Could not create the upload folder ${dir}: ${err.message}`);
  }
}
export const BRANDING_DIR = path.join(UPLOAD_ROOT, 'branding');
// PRIVATE_ROOT is NEVER served statically. Files here are only reachable through protected download routes.
export const PRIVATE_ROOT = path.join(UPLOAD_ROOT, 'private');
ensureDir(BRANDING_DIR);
ensureDir(PRIVATE_ROOT);

const ALLOWED = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

// Random filename + extension taken from the verified MIME type (never from the user's filename).
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, BRANDING_DIR),
  filename: (_req, file, cb) => cb(null, `logo-${crypto.randomBytes(12).toString('hex')}${ALLOWED[file.mimetype]}`),
});

export const uploadLogo = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) =>
    ALLOWED[file.mimetype] ? cb(null, true) : cb(ApiError.badRequest('Logo must be a PNG, JPG or WEBP image')),
}).single('logo');

// ---------------------------------------------------------------------------------------------
// Private files (course materials, submissions, student documents, complaint attachments)
// ---------------------------------------------------------------------------------------------
export const DOC_TYPES = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/plain': '.txt',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

// First bytes of each format. A renamed .exe will not pass this check even if the browser says "application/pdf".
const MAGIC = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [0x50, 0x4b, 0x03, 0x04],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': [0x50, 0x4b, 0x03, 0x04],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/webp': [0x52, 0x49, 0x46, 0x46],
};

const removeFiles = (files = []) => files.forEach((f) => fs.promises.unlink(f.path).catch(() => {}));

const checkMagic = (req, _res, next) => {
  const files = req.files || [];
  try {
    for (const f of files) {
      const sig = MAGIC[f.mimetype];
      if (!sig) continue; // text/plain has no signature
      const fd = fs.openSync(f.path, 'r');
      const buf = Buffer.alloc(sig.length);
      fs.readSync(fd, buf, 0, sig.length, 0);
      fs.closeSync(fd);
      if (!sig.every((b, i) => buf[i] === b)) {
        removeFiles(files);
        return next(ApiError.badRequest(`"${f.originalname}" does not look like a valid ${DOC_TYPES[f.mimetype]} file`));
      }
    }
    next();
  } catch (err) {
    removeFiles(files);
    next(err);
  }
};

// privateUpload('materials') -> [multer, magic-number check]. Files land in uploads/private/<category>/.
export const privateUpload = (category, { maxMB = 10, maxFiles = 5, field = 'files' } = {}) => {
  const dir = path.join(PRIVATE_ROOT, category);
  ensureDir(dir);
  const multerMw = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, dir),
      filename: (_req, file, cb) => cb(null, `${crypto.randomBytes(16).toString('hex')}${DOC_TYPES[file.mimetype]}`),
    }),
    limits: { fileSize: maxMB * 1024 * 1024, files: maxFiles },
    fileFilter: (_req, file, cb) =>
      DOC_TYPES[file.mimetype]
        ? cb(null, true)
        : cb(ApiError.badRequest('Allowed files: PDF, DOCX, PPTX, TXT, PNG, JPG, WEBP')),
  }).array(field, maxFiles);
  return [multerMw, checkMagic];
};

const cleanName = (n) => String(n || 'file').replace(/[\r\n"\\/]/g, '_').slice(0, 150);

// Turns multer files into the small descriptors we store in MongoDB (the file itself stays on disk).
export const toFileDocs = (files = []) =>
  files.map((f) => ({ originalName: cleanName(f.originalname), storedName: f.filename, mimeType: f.mimetype, size: f.size }));

export const storedPath = (category, storedName) => path.join(PRIVATE_ROOT, category, path.basename(storedName));

export const removeStored = (category, docs = []) =>
  docs.forEach((d) => fs.promises.unlink(storedPath(category, d.storedName)).catch(() => {}));

// Deletes uploaded files by stored name when the category folder is not known (used when a whole semester is deleted).
// Stored names are random, so the same name can never exist in two folders.
export const removeStoredAnywhere = (docs = []) => {
  const dirs = fs
    .readdirSync(PRIVATE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(PRIVATE_ROOT, d.name));
  docs.forEach((d) => dirs.forEach((dir) => fs.promises.unlink(path.join(dir, path.basename(d.storedName))).catch(() => {})));
};

// Removes files that multer already saved when the request then fails validation.
export const discardUploads = (req) => removeFiles(req.files || []);

export const sendStored = (res, category, doc) => {
  const p = storedPath(category, doc.storedName);
  if (!fs.existsSync(p)) throw ApiError.notFound('File is missing on the server');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.download(p, doc.originalName);
};
