const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { documents, transcripts, settings, collections, documentCollections, users, transcriptionJobs, importJobs, saveDatabase } = require('../database/db');
const { createProvider, listProviders, listConfiguredProviders } = require('../utils/llm');
const { savePdfPages } = require('../utils/pdf');

// ── In-memory job store for background PDF processing ──────────────────────
const jobs = new Map(); // jobId → { status, progress, pageCount, pages, error }

function createJob() {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  jobs.set(id, { status: 'processing', progress: 0, pageCount: null, pages: [], error: null });
  return id;
}

// Configure multer for temporary file uploads (images + PDFs)
const upload = multer({
  dest: path.join(__dirname, '..', 'temp'),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB for PDFs
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff',
      'application/pdf'
    ];
    if (allowedTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type. Images and PDFs are allowed.'));
  }
});

const tempDir = path.join(__dirname, '..', 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

// Admin dashboard
router.get('/', (req, res) => {
  const docCount        = documents.getCount();
  const pendingCount    = users.getPending().length;
  const collectionCount = collections.getAll().length;
  const allUsers        = users.getAll();
  const userCount       = allUsers.filter(u => u.status === 'active').length;

  res.render('admin/index', {
    pageTitle: 'Admin',
    docCount,
    pendingCount,
    collectionCount,
    userCount,
    providers: listProviders()
  });
});

// Settings page
router.get('/settings', (req, res) => {
  res.render('admin/settings', {
    pageTitle: 'LLM Settings',
    cfg: settings.getAll(),
    providers: listProviders(),
    saved: req.query.saved === '1'
  });
});

// Save settings
router.post('/settings', express.urlencoded({ extended: false }), (req, res) => {
  // Non-secret fields: always save (even if empty)
  const plainFields = [
    'default_provider',
    'openai_model',
    'anthropic_model',
    'ollama_base_url', 'ollama_model',
    'lmstudio_base_url', 'lmstudio_model'
  ];
  for (const field of plainFields) {
    if (req.body[field] !== undefined) settings.set(field, req.body[field]);
  }
  // Secret fields: only overwrite if a new non-empty value was submitted
  const secretFields = ['openai_api_key', 'anthropic_api_key'];
  for (const field of secretFields) {
    if (req.body[field] && req.body[field].trim() !== '') {
      settings.set(field, req.body[field].trim());
    }
  }
  saveDatabase();
  res.redirect('/admin/settings?saved=1');
});

// Import page
router.get('/import', (req, res) => {
  const configuredProviders = listConfiguredProviders();

  // If resuming from a completed import job, pass the job data
  let resumeJob = null;
  if (req.query.importJobId) {
    const job = importJobs.getById(parseInt(req.query.importJobId));
    if (job && job.status === 'done' && job.pages && !job.submitted) {
      resumeJob = {
        id: job.id,
        originalName: job.original_name,
        pages: JSON.parse(job.pages)
      };
    }
  }

  res.render('admin/import', {
    pageTitle: 'Import Document',
    providers: configuredProviders,
    hasNoProviders: configuredProviders.length === 0,
    allCollections: collections.getAll(),
    resumeJob
  });
});

// API: Upload file (image or PDF)
// Images: returns temp file info immediately.
// PDFs: starts background rendering job, returns jobId immediately.
router.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  if (req.file.mimetype === 'application/pdf') {
    const pdfPath = req.file.path;
    const fileSize = req.file.size || 0;

    // Decide inline vs. background: use file size as fast heuristic first,
    // only count pages for small files
    const LARGE_PDF_THRESHOLD = 5;
    const FILE_SIZE_THRESHOLD = 5 * 1024 * 1024; // 5MB — skip page count for large files

    let numPages = 0;
    if (fileSize < FILE_SIZE_THRESHOLD) {
      try {
        const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
        const pdfBuffer = fs.readFileSync(pdfPath);
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
        numPages = pdf.numPages;
        pdf.destroy();
      } catch (e) {
        // If page count fails, treat as large (go to background)
        numPages = LARGE_PDF_THRESHOLD + 1;
      }
    } else {
      // Large file — skip expensive page count, go straight to background
      numPages = LARGE_PDF_THRESHOLD + 1;
    }

    if (numPages > LARGE_PDF_THRESHOLD) {
      // Large PDF: queue as a persistent background import job
      const dbJobId = importJobs.create({
        original_name: req.file.originalname,
        file_path: pdfPath
      });
      if (numPages > LARGE_PDF_THRESHOLD + 1) {
        // We know the real count (small-file path counted it)
        importJobs.updateProgress(dbJobId, { page_count: numPages });
      }

      res.json({
        success: true,
        type: 'pdf_queued',
        importJobId: dbJobId,
        pageCount: numPages > LARGE_PDF_THRESHOLD + 1 ? numPages : null,
        originalName: req.file.originalname
      });

      // Process in a child process so it doesn't block the event loop
      const { fork } = require('child_process');
      const child = fork(path.join(__dirname, '..', 'utils', 'pdf-worker.js'), [], {
        stdio: ['pipe', 'inherit', 'inherit', 'ipc']
      });
      let childDone = false;
      child.send({ pdfPath, tempDir, dbJobId, originalName: req.file.originalname });
      child.on('message', (msg) => {
        if (msg.type === 'progress') {
          importJobs.updateProgress(msg.dbJobId, { page_count: msg.pageCount, pages_rendered: msg.pagesRendered });
        } else if (msg.type === 'done') {
          childDone = true;
          importJobs.markDone(msg.dbJobId, msg.pages);
          console.log(`[import] PDF "${msg.originalName}" processed: ${msg.pages.length} pages`);
        } else if (msg.type === 'failed') {
          childDone = true;
          importJobs.markFailed(msg.dbJobId, msg.error);
        }
      });
      child.on('error', (err) => {
        console.error('PDF worker process error:', err);
        if (!childDone) importJobs.markFailed(dbJobId, err.message);
      });
      child.on('exit', (code) => {
        if (!childDone) {
          console.error(`PDF worker exited unexpectedly with code ${code}`);
          importJobs.markFailed(dbJobId, `Worker process exited with code ${code}`);
        }
      });

    } else {
      // Small PDF: inline processing with in-memory job (existing flow)
      const jobId = createJob();

      res.json({
        success: true,
        type: 'pdf',
        jobId,
        originalName: req.file.originalname
      });

      setImmediate(async () => {
        const job = jobs.get(jobId);
        try {
          const pdfBuffer = fs.readFileSync(pdfPath);
          try { fs.unlinkSync(pdfPath); } catch (e) {}

          const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
          const { createCanvas } = require('canvas');

          const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
          job.pageCount = pdf.numPages;

          const prefix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 2.0 });
            const canvas = createCanvas(viewport.width, viewport.height);
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            page.cleanup();

            const filename = `${prefix}_page${i}.png`;
            fs.writeFileSync(path.join(tempDir, filename), canvas.toBuffer('image/png'));

            job.pages.push({ pageNumber: i, filename });
            job.progress = Math.round((i / pdf.numPages) * 100);
          }

          pdf.destroy();
          job.status = 'done';
          job.progress = 100;
        } catch (err) {
          console.error('PDF background processing error:', err);
          job.status = 'error';
          job.error = err.message;
          try { fs.unlinkSync(pdfPath); } catch (e) {}
        }
      });
    }

  } else {
    // Image: return temp file info immediately
    res.json({
      success: true,
      type: 'image',
      tempFile: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype
    });
  }
});

// API: Poll job status
router.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    status: job.status,       // 'processing' | 'done' | 'error'
    progress: job.progress,   // 0-100
    pageCount: job.pageCount,
    pages: job.status === 'done' ? job.pages : [],
    error: job.error || null
  });
});

// API: Serve temp page image (for previews)
router.get('/api/temp-image/:filename', (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9_.-]/g, '');
  const filePath = path.join(tempDir, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.type('image/png').sendFile(filePath);
});

// API: Transcribe a single image (by temp filename)
router.post('/api/transcribe', express.json(), async (req, res) => {
  const { tempFile, provider: providerName = 'openai', temperature } = req.body;
  if (!tempFile) return res.status(400).json({ error: 'No temp file specified' });

  const filePath = path.join(tempDir, tempFile.replace(/[^a-zA-Z0-9_.-]/g, ''));
  if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'Temp file not found' });

  try {
    const provider = createProvider(providerName);
    const imageBuffer = fs.readFileSync(filePath);
    const mimeType = 'image/png';
    const opts = {
      temperature: temperature !== '' && temperature != null
        ? parseFloat(temperature)
        : null
    };

    const result = await provider.transcribeDocument(imageBuffer, mimeType, opts);

    res.json({
      success: true,
      transcription: result.transcription,
      metadata: result.metadata,
      notes: result.notes,
      paradata: result.paradata || null
    });
  } catch (err) {
    console.error('Transcription error:', err);
    res.status(500).json({ error: err.message });
  }
});

// API: Transcribe a group of pages (multi-page document)
router.post('/api/transcribe-group', express.json(), async (req, res) => {
  const { tempFiles, provider: providerName = 'openai', temperature } = req.body;
  if (!Array.isArray(tempFiles) || tempFiles.length === 0) {
    return res.status(400).json({ error: 'No files specified' });
  }

  try {
    const provider = createProvider(providerName);
    const opts = {
      temperature: temperature !== '' && temperature != null
        ? parseFloat(temperature)
        : null
    };

    // For multi-page: transcribe each page separately then combine
    const results = [];
    for (const tf of tempFiles) {
      const filePath = path.join(tempDir, tf.replace(/[^a-zA-Z0-9_.-]/g, ''));
      if (!fs.existsSync(filePath)) continue;
      const imageBuffer = fs.readFileSync(filePath);
      const result = await provider.transcribeDocument(imageBuffer, 'image/png', opts);
      results.push(result);
    }

    if (results.length === 0) {
      return res.status(400).json({ error: 'No valid pages found' });
    }

    // Combine transcriptions
    const combined = {
      transcription: results.map((r, i) =>
        results.length > 1 ? `[Page ${i + 1}]\n${r.transcription}` : r.transcription
      ).join('\n\n'),
      metadata: results[0].metadata,
      notes: results.map(r => r.notes).filter(Boolean).join(' | ') || null,
      paradata: results[0].paradata
    };

    // Update paradata to reflect all pages
    if (combined.paradata) {
      combined.paradata.run_duration_ms = results.reduce(
        (sum, r) => sum + (r.paradata?.run_duration_ms || 0), 0
      );
    }

    res.json({ success: true, ...combined });
  } catch (err) {
    console.error('Group transcription error:', err);
    res.status(500).json({ error: err.message });
  }
});

// API: Save document (after review)
// Supports single tempFile or array of tempFiles (multi-page)
// transcriptionMode: 'manual' (save transcript now) | 'ai' (queue background job)
router.post('/api/save-document', express.json(), async (req, res) => {
  const {
    tempFile, tempFiles, originalName, mimeType,
    title, dateCreated, description, metadata,
    transcription, notes, transcriber,
    initiatedBy, paradata,
    collectionIds,
    transcriptionMode,
    provider,
    temperature
  } = req.body;

  const isAiMode = transcriptionMode === 'ai';
  const files = tempFiles || (tempFile ? [tempFile] : []);
  if (files.length === 0) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!isAiMode && !transcription) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    // Move first page image as the primary document image
    const firstFile = files[0];
    const tempPath = path.join(tempDir, firstFile);
    if (!fs.existsSync(tempPath)) {
      return res.status(400).json({ error: 'Temporary file not found. Please upload again.' });
    }

    const baseName = originalName || 'document';
    const ext = path.extname(baseName) === '.pdf' ? '.png' : (path.extname(baseName) || '.jpg');
    const stem = path.basename(baseName, path.extname(baseName)).replace(/[^a-zA-Z0-9_-]/g, '_');
    let filename = stem + ext;
    let destPath = path.join(uploadsDir, filename);
    let counter = 1;
    while (fs.existsSync(destPath)) {
      filename = `${stem}_${counter}${ext}`;
      destPath = path.join(uploadsDir, filename);
      counter++;
    }

    fs.copyFileSync(tempPath, destPath);

    // Store additional page image paths in metadata
    const additionalPages = [];
    if (files.length > 1) {
      for (let i = 1; i < files.length; i++) {
        const pTempPath = path.join(tempDir, files[i]);
        if (!fs.existsSync(pTempPath)) continue;
        const pageFilename = `${stem}_page${i + 1}_${counter > 1 ? counter - 1 : ''}${ext}`.replace(/__/g, '_');
        const pageDest = path.join(uploadsDir, pageFilename);
        fs.copyFileSync(pTempPath, pageDest);
        additionalPages.push(`/uploads/${pageFilename}`);
      }
    }

    // Clean up all temp files
    for (const f of files) {
      try { fs.unlinkSync(path.join(tempDir, f)); } catch (e) {}
    }

    const docMetadata = { ...(metadata || {}) };
    if (additionalPages.length > 0) {
      docMetadata.additional_pages = additionalPages;
    }

    const docId = documents.create({
      title: title || 'Untitled Document',
      date_created: dateCreated || null,
      description: description || null,
      image_path: `/uploads/${filename}`,
      metadata: docMetadata
    });

    // Assign to collections
    if (Array.isArray(collectionIds) && collectionIds.length > 0) {
      documentCollections.setForDocument(docId, collectionIds.map(Number));
    }

    let transcriptId = null;
    let jobId = null;

    if (isAiMode) {
      // Queue background transcription job
      const additionalImagePaths = additionalPages.length > 0 ? additionalPages : null;
      const tempVal = temperature !== '' && temperature != null ? parseFloat(temperature) : null;
      jobId = transcriptionJobs.create({
        document_id: docId,
        provider: provider || null,
        model: null,
        temperature: !isNaN(tempVal) ? tempVal : null,
        initiated_by: initiatedBy || null,
        image_path: `/uploads/${filename}`,
        additional_image_paths: additionalImagePaths
      });
    } else {
      // Save transcript immediately (manual mode)
      const pd = paradata || {};
      transcriptId = transcripts.create({
        document_id: docId,
        content: transcription,
        transcriber: transcriber || 'Manual Transcription',
        version: 1,
        notes: notes || null,
        provider: pd.provider || null,
        model: pd.model || null,
        prompt: pd.prompt || null,
        temperature: pd.temperature != null ? pd.temperature : null,
        initiated_by: initiatedBy || pd.initiated_by || null,
        run_duration_ms: pd.run_duration_ms || null
      });
    }

    saveDatabase();

    res.json({
      success: true,
      documentId: docId,
      transcriptId,
      jobId,
      message: isAiMode ? 'Document saved. Transcription queued.' : 'Document imported successfully'
    });
  } catch (err) {
    console.error('Save document error:', err);
    res.status(500).json({ error: err.message });
  }
});

// API: Bulk submit pages (groups + ungrouped) — creates documents & queues transcription
router.post('/api/submit-pages', express.json(), async (req, res) => {
  const { groups, originalName, provider, temperature, initiatedBy, collectionIds, importJobId } = req.body;

  if (!Array.isArray(groups) || groups.length === 0) {
    return res.status(400).json({ error: 'No documents to submit' });
  }

  try {
    const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    const savedDocs = [];
    const tempVal = temperature !== '' && temperature != null ? parseFloat(temperature) : null;

    for (const group of groups) {
      const files = group.tempFiles;
      if (!files || files.length === 0) continue;

      // Move first page as primary image
      const firstFile = files[0];
      const tempPath = path.join(tempDir, firstFile);
      if (!fs.existsSync(tempPath)) continue;

      const baseName = originalName || 'document';
      const ext = '.png';
      const stem = path.basename(baseName, path.extname(baseName)).replace(/[^a-zA-Z0-9_-]/g, '_');
      let filename = stem + ext;
      let destPath = path.join(uploadsDir, filename);
      let counter = 1;
      while (fs.existsSync(destPath)) {
        filename = `${stem}_${counter}${ext}`;
        destPath = path.join(uploadsDir, filename);
        counter++;
      }

      fs.copyFileSync(tempPath, destPath);

      // Additional pages
      const additionalPages = [];
      for (let i = 1; i < files.length; i++) {
        const pTempPath = path.join(tempDir, files[i]);
        if (!fs.existsSync(pTempPath)) continue;
        const pageFilename = `${stem}_page${i + 1}_${counter > 1 ? counter - 1 : ''}${ext}`.replace(/__/g, '_');
        const pageDest = path.join(uploadsDir, pageFilename);
        fs.copyFileSync(pTempPath, pageDest);
        additionalPages.push(`/uploads/${pageFilename}`);
      }

      // Clean up temp files for this group
      for (const f of files) {
        try { fs.unlinkSync(path.join(tempDir, f)); } catch (e) {}
      }

      const docMetadata = {};
      if (additionalPages.length > 0) {
        docMetadata.additional_pages = additionalPages;
      }

      const docId = documents.create({
        title: group.label || 'Untitled Document',
        date_created: null,
        description: null,
        image_path: `/uploads/${filename}`,
        metadata: docMetadata
      });

      // Assign to collections
      if (Array.isArray(collectionIds) && collectionIds.length > 0) {
        documentCollections.setForDocument(docId, collectionIds.map(Number));
      }

      // Queue transcription job
      const jobId = transcriptionJobs.create({
        document_id: docId,
        provider: provider || null,
        model: null,
        temperature: !isNaN(tempVal) ? tempVal : null,
        initiated_by: initiatedBy || null,
        image_path: `/uploads/${filename}`,
        additional_image_paths: additionalPages.length > 0 ? additionalPages : null
      });

      savedDocs.push({ documentId: docId, jobId });
    }

    saveDatabase();

    // Mark import job as submitted so Continue button disappears
    if (importJobId) {
      try { importJobs.markSubmitted(parseInt(importJobId)); } catch (e) {}
    }

    res.json({
      success: true,
      documents: savedDocs,
      count: savedDocs.length
    });
  } catch (err) {
    console.error('Bulk submit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// API: Cancel/cleanup temp files
router.post('/api/cancel-import', express.json(), (req, res) => {
  const { tempFile, tempFiles } = req.body;
  const files = tempFiles || (tempFile ? [tempFile] : []);
  for (const f of files) {
    try {
      const tempPath = path.join(tempDir, f);
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (e) {}
  }
  res.json({ success: true });
});

module.exports = router;
