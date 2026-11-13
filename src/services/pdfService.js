import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { BRANDING_DIR } from '../middleware/upload.js';

const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '-');
const money = (n, cur) => `${cur} ${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const start = (res, filename) => {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: filename } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  return doc;
};

// University name, campus and logo from the current settings, so a rename shows up on every new document.
const header = (doc, settings, title) => {
  // The logo normally comes from the database (settings.logoData). An older logo FILE in uploads/branding is still understood.
  let logo = null;
  if (settings.logoData?.length && /png|jpe?g/i.test(settings.logoMime || '')) logo = Buffer.from(settings.logoData);
  else if (settings.logoUrl?.startsWith('/uploads/branding/')) {
    const logoFile = path.join(BRANDING_DIR, path.basename(settings.logoUrl));
    if (/\.(png|jpe?g)$/i.test(logoFile) && fs.existsSync(logoFile)) logo = logoFile;
  }
  if (logo) {
    try { doc.image(logo, 40, 36, { fit: [60, 60] }); } catch { /* a damaged image must never stop the document */ } // pdfkit cannot draw webp
  }
  doc.font('Helvetica-Bold').fontSize(18).text(settings.universityName, 40, 40, { align: 'center', width: 515 });
  doc.font('Helvetica').fontSize(10).text(settings.campusName || '', { align: 'center', width: 515 });
  if (settings.address) doc.text(settings.address, { align: 'center', width: 515 });
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(14).text(title, { align: 'center', width: 515 });
  const y = doc.y + 6;
  doc.moveTo(40, y).lineTo(555, y).lineWidth(1).stroke();
  doc.y = y + 10;
  doc.x = 40;
};

const infoRows = (doc, pairs) => {
  for (const [label, value] of pairs) {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(10).text(`${label}:`, 40, y, { width: 130 });
    doc.font('Helvetica').text(String(value ?? '-'), 175, y, { width: 380 });
  }
  doc.moveDown(0.5);
};

// Draws a bordered table. columns: [{ label, width, align? }], rows: arrays of strings.
const table = (doc, columns, rows) => {
  const rowH = 22;
  const drawRow = (cells, bold) => {
    if (doc.y + rowH > 780) doc.addPage();
    const y = doc.y;
    let x = 40;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    columns.forEach((c, i) => {
      doc.rect(x, y, c.width, rowH).stroke();
      doc.text(String(cells[i] ?? ''), x + 4, y + 7, { width: c.width - 8, align: c.align || 'left', lineBreak: false });
      x += c.width;
    });
    doc.y = y + rowH;
  };
  drawRow(columns.map((c) => c.label), true);
  rows.forEach((r) => drawRow(r, false));
  doc.x = 40;
};

// ---------------------------------------------------------------------------------------------
export const renderDmc = (res, { settings, student, profile, department, semester, exam, result, dmc }) => {
  const doc = start(res, `DMC-${profile.rollNumber}.pdf`);
  header(doc, settings, 'DETAILED MARKS CERTIFICATE (DMC)');
  infoRows(doc, [
    ['Student name', student.name],
    ['Roll number', profile.rollNumber],
    ['Department', department.name],
    ['Semester', `${semester.name} (${semester.academicYear})`],
    ['Examination', `${exam.name} - ${exam.type}`],
  ]);
  doc.moveDown(0.5);
  table(
    doc,
    [
      { label: 'Code', width: 70 },
      { label: 'Subject', width: 225 },
      { label: 'Max', width: 55, align: 'right' },
      { label: 'Passing', width: 55, align: 'right' },
      { label: 'Obtained', width: 60, align: 'right' },
      { label: 'Result', width: 50 },
    ],
    result.subjects.map((s) => [s.code, s.title, s.maxMarks, s.passingMarks, s.absent ? 'ABS' : s.obtained, s.passed ? 'Pass' : 'Fail'])
  );
  doc.moveDown(1);
  infoRows(doc, [
    ['Total marks', `${result.totalObtained} / ${result.totalMax}`],
    ['Percentage', `${result.percentage}%`],
    ['Grade', result.grade],
    ['Result', result.outcome.toUpperCase()],
    ['Published on', fmtDate(result.publishedAt)],
  ]);
  doc.moveDown(2);
  doc.font('Helvetica').fontSize(8).fillColor('#555555');
  doc.text(`DMC No: ${dmc.dmcNumber}    Verification code: ${dmc.verificationCode}`, 40, doc.y, { width: 515 });
  doc.text('Verify this certificate on the university result page. This is a computer generated document.', { width: 515 });
  doc.end();
};

// ---------------------------------------------------------------------------------------------
export const renderReceipt = (res, { settings, receipt }) => {
  const doc = start(res, `${receipt.receiptNumber}.pdf`);
  header(doc, settings, 'FEE PAYMENT RECEIPT');
  infoRows(doc, [
    ['Receipt number', receipt.receiptNumber],
    ['Date', fmtDate(receipt.issuedAt)],
    ['Student', receipt.studentName],
    ['Roll number', receipt.rollNumber],
    ['Department', receipt.departmentName],
    ['Payment method', { manual: 'Collected at the university office', bank: 'Bank transfer (verified by the finance office)' }[receipt.method] || 'Online payment'],
    ...(receipt.bankReference ? [['Bank reference', receipt.bankReference]] : []),
    ...(receipt.collectedBy ? [[receipt.method === 'bank' ? 'Received by' : 'Collected by', receipt.collectedBy]] : []),
  ]);
  doc.moveDown(0.5);
  table(
    doc,
    [
      { label: 'Fee', width: 235 },
      { label: 'Fee amount', width: 95, align: 'right' },
      { label: 'Late fee', width: 90, align: 'right' },
      { label: 'Total', width: 95, align: 'right' },
    ],
    receipt.lines.map((l) => [l.title, money(l.baseAmount, receipt.currency), money(l.lateFee, receipt.currency), money(l.total, receipt.currency)])
  );
  doc.moveDown(1);
  doc.font('Helvetica-Bold').fontSize(12).text(`Total paid: ${money(receipt.totalAmount, receipt.currency)}`, 40, doc.y, { align: 'right', width: 515 });
  doc.moveDown(2);
  doc.font('Helvetica').fontSize(8).fillColor('#555555').text('This is a computer generated receipt.', 40, doc.y, { width: 515 });
  doc.end();
};

// ---------------------------------------------------------------------------------------------
export const renderAdmitCard = (res, { settings, student, profile, department, semester, exam, papers, admission }) => {
  const doc = start(res, `AdmitCard-${profile.rollNumber}.pdf`);
  header(doc, settings, 'EXAMINATION ADMIT CARD');
  infoRows(doc, [
    ['Student name', student.name],
    ['Roll number', profile.rollNumber],
    ['Department', department.name],
    ['Semester', `${semester.name} (${semester.academicYear})`],
    ['Examination', `${exam.name} - ${exam.type}`],
    ['Admission status', 'APPROVED'],
  ]);
  doc.moveDown(0.5);
  table(
    doc,
    [
      { label: 'Date', width: 80 },
      { label: 'Time', width: 90 },
      { label: 'Code', width: 70 },
      { label: 'Subject', width: 205 },
      { label: 'Room', width: 70 },
    ],
    papers.map((p) => [fmtDate(p.date), `${p.startTime}-${p.endTime}`, p.code, p.title, p.room])
  );
  doc.moveDown(2);
  doc.font('Helvetica').fontSize(8).fillColor('#555555');
  doc.text(`Admission ID: ${admission._id}. Bring this card and your student ID to every paper.`, 40, doc.y, { width: 515 });
  doc.end();
};

// ---------------------------------------------------------------------------------------------
// A plain table report (the library reports). columns: [{ label, width }] (widths are relative, they are scaled to the page),
// rows: arrays of values, summary: [[label, value]].
export const renderTableReport = (res, { settings, title, filename, summary = [], columns, rows, generated = '' }) => {
  const doc = start(res, filename);
  header(doc, settings, title);
  if (generated) doc.font('Helvetica').fontSize(8).fillColor('#555555').text(generated, 40, doc.y - 4, { width: 515, align: 'right' }).fillColor('#000000');
  if (summary.length) infoRows(doc, summary);
  const total = columns.reduce((s, c) => s + (c.width || 60), 0);
  const cols = columns.map((c) => ({ ...c, w: Math.floor(((c.width || 60) / total) * 515) }));
  const rowH = 20;
  const drawRow = (cells, bold) => {
    if (doc.y + rowH > 790) { doc.addPage(); doc.x = 40; }
    const y = doc.y;
    let x = 40;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5);
    if (bold) doc.rect(40, y, cols.reduce((s, c) => s + c.w, 0), rowH).fill('#e8edf5').fillColor('#000000');
    cols.forEach((c, i) => {
      doc.rect(x, y, c.w, rowH).lineWidth(0.5).stroke();
      doc.text(String(cells[i] ?? ''), x + 3, y + 6, { width: c.w - 6, height: 10, ellipsis: true, lineBreak: false });
      x += c.w;
    });
    doc.y = y + rowH;
  };
  drawRow(cols.map((c) => c.label), true);
  if (!rows.length) { doc.moveDown(1); doc.font('Helvetica').fontSize(10).text('No records for this report.', 40, doc.y, { width: 515 }); }
  rows.forEach((r) => drawRow(r, false));
  doc.x = 40;
  doc.end();
};
