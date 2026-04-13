'use strict';

const express = require('express');
const router = express.Router();
const yazl = require('yazl');
const {
  documentsAsync,
  transcriptsAsync,
  documentCollectionsAsync
} = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { normalizeDocumentAssets } = require('../utils/document-assets');
const { asyncHandler } = require('../utils/async-handler');

router.use(requireAuth);

// Helper: check if any of the document's collections allow export
async function canExport(docId, userId, user) {
  const isAdmin = user.role === 'admin';
  const accessAll = !!user.access_all;

  // Verify the user can access the document at all
  if (!(await documentsAsync.canAccess(docId, userId, isAdmin, accessAll))) {
    return false;
  }

  // Check if any collection this document belongs to has allow_export enabled
  const collections = await documentCollectionsAsync.getByDocumentId(docId);
  return collections.some(c => c.allow_export);
}

// Helper: get document + best transcript for export
async function getExportData(docId) {
  const doc = normalizeDocumentAssets(await documentsAsync.getById(docId));
  if (!doc) return null;
  const transcript = await transcriptsAsync.getBestByDocumentId(docId);
  return { doc, transcript };
}

function sanitizeFilename(title) {
  return (title || 'document').replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_').substring(0, 80);
}

// ── Single document PDF export ──────────────────────────────────────────────
router.get('/documents/:id/pdf', asyncHandler(async (req, res) => {
  const docId = parseInt(req.params.id);
  if (!(await canExport(docId, req.user.id, req.user))) {
    return res.status(403).render('error', { message: 'Export is not enabled for this document.', error: {} });
  }

  const data = await getExportData(docId);
  if (!data) return res.status(404).render('error', { message: 'Document not found', error: {} });

  const { generatePDF } = require('../utils/export-document');
  const pdfBytes = await generatePDF(data.doc, data.transcript);
  const filename = sanitizeFilename(data.doc.title) + '.pdf';

  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': pdfBytes.length
  });
  res.send(Buffer.from(pdfBytes));
}));

// ── Single document TEI export ──────────────────────────────────────────────
router.get('/documents/:id/tei', asyncHandler(async (req, res) => {
  const docId = parseInt(req.params.id);
  if (!(await canExport(docId, req.user.id, req.user))) {
    return res.status(403).render('error', { message: 'Export is not enabled for this document.', error: {} });
  }

  const data = await getExportData(docId);
  if (!data) return res.status(404).render('error', { message: 'Document not found', error: {} });

  const { generateTEI } = require('../utils/export-document');
  const xml = generateTEI(data.doc, data.transcript);
  const filename = sanitizeFilename(data.doc.title) + '.xml';

  res.set({
    'Content-Type': 'application/xml',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': Buffer.byteLength(xml, 'utf8')
  });
  res.send(xml);
}));

// ── Bulk export (ZIP containing PDFs and/or TEIs) ───────────────────────────
router.post('/documents/bulk', express.json(), asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(n => !isNaN(n)) : [];
  const format = req.body.format || 'pdf'; // 'pdf', 'tei', or 'both'

  if (ids.length === 0) {
    return res.status(400).json({ error: 'No documents selected' });
  }
  if (ids.length > 200) {
    return res.status(400).json({ error: 'Too many documents (max 200)' });
  }

  // Verify export permission for each document
  for (const docId of ids) {
    if (!(await canExport(docId, req.user.id, req.user))) {
      return res.status(403).json({ error: `Export not permitted for document ${docId}` });
    }
  }

  const zipfile = new yazl.ZipFile();

  for (const docId of ids) {
    const data = await getExportData(docId);
    if (!data) continue;
    const basename = sanitizeFilename(data.doc.title) + '_' + docId;

    if (format === 'pdf' || format === 'both') {
      const { generatePDF } = require('../utils/export-document');
      const pdfBytes = await generatePDF(data.doc, data.transcript);
      zipfile.addBuffer(Buffer.from(pdfBytes), basename + '.pdf');
    }
    if (format === 'tei' || format === 'both') {
      const { generateTEI } = require('../utils/export-document');
      const xml = generateTEI(data.doc, data.transcript);
      zipfile.addBuffer(Buffer.from(xml, 'utf8'), basename + '.xml');
    }
  }

  zipfile.end();

  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename="export.zip"'
  });
  zipfile.outputStream.pipe(res);
}));

module.exports = router;
