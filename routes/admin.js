const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { canEncryptSecrets } = require('../utils/secrets');
const config = require('../config');
const storage = require('../utils/storage');
const { documentsAsync, transcriptsAsync, settingsAsync, collectionsAsync, documentCollectionsAsync, usersAsync, transcriptionJobsAsync, importJobsAsync, saveDatabase, userApiKeysAsync } = require('../database/db');
const { createProvider, listProviders } = require('../utils/llm');
const { buildProviderAccessOptionsAsync, resolveProviderSelectionAsync } = require('../utils/provider-access');

// ── In-memory job store for background PDF processing ──────────────────────
const jobs = new Map(); // jobId → { status, progress, pageCount, pages, error, createdAt }
const JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes

function createJob() {
  const id = crypto.randomBytes(16).toString('hex');
  jobs.set(id, { status: 'processing', progress: 0, pageCount: null, pages: [], error: null, createdAt: Date.now() });
  // Periodically clean up stale jobs
  if (jobs.size > 50) {
    const now = Date.now();
    for (const [key, job] of jobs) {
      if (now - job.createdAt > JOB_TTL_MS) jobs.delete(key);
    }
  }
  return id;
}

function sanitizeTempFiles(files) {
  return (files || [])
    .map(file => storage.sanitizeTempName(file))
    .filter(Boolean);
}

function attachTempPreview(page) {
  return {
    ...page,
    previewUrl: page.previewUrl || storage.getTempPreviewUrl(page.filename)
  };
}

// Configure multer for temporary file uploads (images + PDFs)
const upload = multer({
  dest: config.app.tempDir,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff',
      'application/pdf'
    ];
    if (allowedTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type. Images and PDFs are allowed.'));
  }
});

storage.init();

// Admin dashboard
router.get('/', async (req, res) => {
  const docCount        = await documentsAsync.getCount();
  const pendingCount    = (await usersAsync.getPending()).length;
  const collectionCount = (await collectionsAsync.getAll()).length;
  const allUsers        = await usersAsync.getAll();
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
router.get('/settings', async (req, res) => {
  res.render('admin/settings', {
    pageTitle: 'LLM Settings',
    cfg: await settingsAsync.getAll(),
    providers: listProviders(),
    saved: req.query.saved === '1',
    error: req.query.error || null,
    hasEncryptionKey: canEncryptSecrets()
  });
});

// Save settings
router.post('/settings', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    // Non-secret fields: always save (even if empty)
    const plainFields = [
      'default_provider',
      'openai_model',
      'anthropic_model',
      'ollama_base_url', 'ollama_model',
      'lmstudio_base_url', 'lmstudio_model'
    ];
    for (const field of plainFields) {
      if (req.body[field] !== undefined) await settingsAsync.set(field, req.body[field]);
    }
    // Secret fields: only overwrite if a new non-empty value was submitted
    const secretFields = ['openai_api_key', 'anthropic_api_key'];
    const hasSecretUpdates = secretFields.some(field => req.body[field] && req.body[field].trim() !== '');
    if (hasSecretUpdates && !canEncryptSecrets()) {
      throw new Error('DATA_ENCRYPTION_KEY is not configured. Add it to .env before saving API keys.');
    }
    for (const field of secretFields) {
      if (req.body[field] && req.body[field].trim() !== '') {
        await settingsAsync.set(field, req.body[field].trim());
      }
    }
    res.redirect('/admin/settings?saved=1');
  } catch (err) {
    res.redirect('/admin/settings?error=' + encodeURIComponent(err.message));
  }
});

// Import page
router.get('/import', async (req, res) => {
  const providerOptions = await buildProviderAccessOptionsAsync(req.user);

  // If resuming from a completed import job, pass the job data
  let resumeJob = null;
  if (req.query.importJobId) {
    const job = await importJobsAsync.getById(parseInt(req.query.importJobId));
    if (job && job.status === 'done' && job.pages && !job.submitted) {
      resumeJob = {
        id: job.id,
        originalName: job.original_name,
        pages: JSON.parse(job.pages).map(attachTempPreview)
      };
    }
  }

  res.render('admin/import', {
    pageTitle: 'Import Document',
    providerOptions,
    hasNoProviders: providerOptions.length === 0,
    allCollections: await collectionsAsync.getAll(),
    resumeJob
  });
});

// API: Upload file (image or PDF)
// Images: returns temp file info immediately.
// PDFs: starts background rendering job, returns jobId immediately.
router.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  if (req.file.mimetype === 'application/pdf') {
    const pdfTempFile = storage.sanitizeTempName(req.file.filename);
    const fileSize = req.file.size || 0;

    // Decide inline vs. background: use file size as fast heuristic first,
    // only count pages for small files
    const LARGE_PDF_THRESHOLD = 5;
    const FILE_SIZE_THRESHOLD = 5 * 1024 * 1024; // 5MB — skip page count for large files

    let numPages = 0;
    if (fileSize < FILE_SIZE_THRESHOLD) {
      try {
        const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
        const pdfBuffer = storage.readTempFile(pdfTempFile);
        const pdf = await pdfjsLib.getDocument({
          data: new Uint8Array(pdfBuffer)
        }).promise;
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
      const useEphemeralMachine = config.flyMachines.enabled;
      const s3TempKey = useEphemeralMachine ? `import_${Date.now()}.pdf` : null;

      const dbJobId = await importJobsAsync.create({
        original_name: req.file.originalname,
        file_path: useEphemeralMachine ? s3TempKey : pdfTempFile
      });
      if (numPages > LARGE_PDF_THRESHOLD + 1) {
        await importJobsAsync.updateProgress(dbJobId, { page_count: numPages });
      }

      res.json({
        success: true,
        type: 'pdf_queued',
        importJobId: dbJobId,
        pageCount: numPages > LARGE_PDF_THRESHOLD + 1 ? numPages : null,
        originalName: req.file.originalname
      });

      if (useEphemeralMachine) {
        // Upload PDF to S3 and launch an ephemeral Fly machine
        try {
          const pdfBuffer = storage.readTempFile(pdfTempFile);
          try { storage.deleteTempFile(pdfTempFile); } catch (e) {}
          await storage.putTempObject(s3TempKey, pdfBuffer);

          const flyMachines = require('../utils/fly-machines');
          const machineId = await flyMachines.runEphemeralWorker(dbJobId);
          await importJobsAsync.updateMachineId(dbJobId, machineId);
        } catch (err) {
          console.error('[import] Failed to launch ephemeral worker:', err);
          importJobsAsync.markFailed(dbJobId, `Failed to launch worker: ${err.message}`).catch(() => {});
        }
      } else {
        // Fallback: process in a local child process (for local dev)
        const { fork } = require('child_process');
        const child = fork(path.join(__dirname, '..', 'utils', 'pdf-worker.js'), [], {
          stdio: ['pipe', 'inherit', 'inherit', 'ipc']
        });
        let childDone = false;
        child.send({ pdfTempFile, dbJobId, originalName: req.file.originalname });
        child.on('message', (msg) => {
          if (msg.type === 'progress') {
            importJobsAsync.updateProgress(msg.dbJobId, { page_count: msg.pageCount, pages_rendered: msg.pagesRendered }).catch(err => {
              console.error('Failed to update import job progress:', err);
            });
          } else if (msg.type === 'done') {
            childDone = true;
            importJobsAsync.markDone(msg.dbJobId, msg.pages).catch(err => {
              console.error('Failed to mark import job done:', err);
            });
            console.log(`[import] PDF "${msg.originalName}" processed: ${msg.pages.length} pages`);
          } else if (msg.type === 'failed') {
            childDone = true;
            importJobsAsync.markFailed(msg.dbJobId, msg.error).catch(err => {
              console.error('Failed to mark import job failed:', err);
            });
          }
        });
        child.on('error', (err) => {
          console.error('PDF worker process error:', err);
          if (!childDone) {
            importJobsAsync.markFailed(dbJobId, err.message).catch(markErr => {
              console.error('Failed to persist import worker error:', markErr);
            });
          }
        });
        child.on('exit', (code) => {
          if (!childDone) {
            console.error(`PDF worker exited unexpectedly with code ${code}`);
            importJobsAsync.markFailed(dbJobId, `Worker process exited with code ${code}`).catch(err => {
              console.error('Failed to persist import worker exit error:', err);
            });
          }
        });
      }

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
          const pdfBuffer = storage.readTempFile(pdfTempFile);
          try { storage.deleteTempFile(pdfTempFile); } catch (e) {}

          const { execFileSync } = require('child_process');
          const prefix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

          // Try pdftoppm first (reliable on Linux), fall back to pdfjs+canvas
          let usePdftoppm = false;
          try { execFileSync('pdftoppm', ['-v'], { stdio: 'pipe' }); usePdftoppm = true; } catch {}

          if (usePdftoppm) {
            const pdfTmpName = `inline_${Date.now()}.pdf`;
            storage.writeTempFile(pdfTmpName, pdfBuffer);
            const pdfPath = storage.getTempFilePath(pdfTmpName);
            const outDir = require('path').dirname(pdfPath);
            const outPrefix = require('path').join(outDir, prefix);

            try {
              execFileSync('pdftoppm', ['-png', '-r', '200', pdfPath, outPrefix], {
                stdio: 'pipe', maxBuffer: 50 * 1024 * 1024, timeout: 30 * 60 * 1000
              });
            } finally {
              try { require('fs').unlinkSync(pdfPath); } catch {}
            }

            const outputFiles = require('fs').readdirSync(outDir)
              .filter(f => f.startsWith(prefix) && f.endsWith('.png'))
              .sort();
            job.pageCount = outputFiles.length;

            for (let i = 0; i < outputFiles.length; i++) {
              const srcPath = require('path').join(outDir, outputFiles[i]);
              const filename = `${prefix}_page${i + 1}.png`;
              const pngBuf = require('fs').readFileSync(srcPath);
              require('fs').unlinkSync(srcPath);
              storage.writeTempFile(filename, pngBuf);
              job.pages.push({
                pageNumber: i + 1,
                filename,
                previewUrl: storage.getTempPreviewUrl(filename)
              });
              job.progress = Math.round(((i + 1) / outputFiles.length) * 100);
            }
          } else {
            const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
            const { createCanvas } = require('canvas');
            const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
            job.pageCount = pdf.numPages;

            for (let i = 1; i <= pdf.numPages; i++) {
              const page = await pdf.getPage(i);
              const viewport = page.getViewport({ scale: 2.0 });
              const canvas = createCanvas(viewport.width, viewport.height);
              await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
              page.cleanup();
              const filename = `${prefix}_page${i}.png`;
              storage.writeTempFile(filename, canvas.toBuffer('image/png'));
              job.pages.push({
                pageNumber: i,
                filename,
                previewUrl: storage.getTempPreviewUrl(filename)
              });
              job.progress = Math.round((i / pdf.numPages) * 100);
            }
            pdf.destroy();
          }

          job.status = 'done';
          job.progress = 100;
        } catch (err) {
          console.error('PDF background processing error:', err);
          job.status = 'error';
          job.error = err.message;
          try { storage.deleteTempFile(pdfTempFile); } catch (e) {}
        }
      });
    }

  } else {
    // Image: return temp file info immediately
    res.json({
      success: true,
      type: 'image',
      tempFile: req.file.filename,
      previewUrl: storage.getTempPreviewUrl(req.file.filename),
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
    pages: job.status === 'done' ? job.pages.map(attachTempPreview) : [],
    error: job.error || null
  });
});

// API: Serve temp page image (for previews)
// Checks local temp dir first, falls back to S3 for images rendered by ephemeral workers.
router.get('/api/temp-image/:filename', async (req, res) => {
  const filename = storage.sanitizeTempName(req.params.filename);

  // Try local first (small PDFs or local dev)
  const filePath = storage.getTempFilePath(filename);
  if (filePath && storage.tempFileExists(filename)) {
    return res.type('image/png').sendFile(filePath);
  }

  // Fall back to S3 (pages rendered by ephemeral worker)
  if (config.storage.driver === 's3' && storage.tempObjectExists) {
    try {
      const buffer = await storage.getTempObject(filename);
      res.set('Cache-Control', 'private, max-age=3600');
      return res.type('image/png').send(buffer);
    } catch (err) {
      // Not in S3 either
    }
  }

  res.status(404).send('Not found');
});

// API: Transcribe a single image (by temp filename)
router.post('/api/transcribe', express.json(), async (req, res) => {
  const { tempFile, provider: providerName = 'openai', credentialSource = 'system', temperature } = req.body;
  if (!tempFile) return res.status(400).json({ error: 'No temp file specified' });

  const safeTempFile = storage.sanitizeTempName(tempFile);
  if (!storage.tempFileExists(safeTempFile)) return res.status(400).json({ error: 'Temp file not found' });

  try {
    const selection = await resolveProviderSelectionAsync(req.user, providerName, credentialSource);
    const provider = await createProvider(providerName, selection.runtimeConfig);
    const imageBuffer = storage.readTempFile(safeTempFile);
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
    if (selection.providerKeyScope === 'user' && selection.userApiKeyId) {
      await userApiKeysAsync.markUsed(selection.userApiKeyId, req.user.id);
    }
  } catch (err) {
    console.error('Transcription error:', err);
    res.status(500).json({ error: err.message });
  }
});

// API: Transcribe a group of pages (multi-page document)
router.post('/api/transcribe-group', express.json(), async (req, res) => {
  const { tempFiles, provider: providerName = 'openai', credentialSource = 'system', temperature } = req.body;
  if (!Array.isArray(tempFiles) || tempFiles.length === 0) {
    return res.status(400).json({ error: 'No files specified' });
  }

  try {
    const selection = await resolveProviderSelectionAsync(req.user, providerName, credentialSource);
    const provider = await createProvider(providerName, selection.runtimeConfig);
    const opts = {
      temperature: temperature !== '' && temperature != null
        ? parseFloat(temperature)
        : null
    };

    // For multi-page: transcribe each page separately then combine
    const results = [];
    for (const tf of tempFiles) {
      const safeTempFile = storage.sanitizeTempName(tf);
      if (!storage.tempFileExists(safeTempFile)) continue;
      const imageBuffer = storage.readTempFile(safeTempFile);
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
    if (selection.providerKeyScope === 'user' && selection.userApiKeyId) {
      await userApiKeysAsync.markUsed(selection.userApiKeyId, req.user.id);
    }
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
    credentialSource,
    temperature
  } = req.body;

  const isAiMode = transcriptionMode === 'ai';
  const rawFiles = tempFiles || (tempFile ? [tempFile] : []);
  const files = sanitizeTempFiles(rawFiles);
  if (files.length === 0) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!isAiMode && !transcription) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Move first page image as the primary document image
    const firstFile = files[0];
    if (!storage.tempFileExists(firstFile)) {
      return res.status(400).json({ error: 'Temporary file not found. Please upload again.' });
    }

    const baseName = originalName || 'document';
    const ext = path.extname(baseName) === '.pdf' ? '.png' : (path.extname(baseName) || '.jpg');
    const primaryUpload = await storage.copyTempFileToUpload(firstFile, baseName, ext);

    // Store additional page image paths in metadata
    const additionalPages = [];
    if (files.length > 1) {
      for (let i = 1; i < files.length; i++) {
        if (!storage.tempFileExists(files[i])) continue;
        const pageUpload = await storage.copyTempFileToUpload(
          files[i],
          `${path.basename(baseName, path.extname(baseName))}_page${i + 1}${ext}`,
          ext
        );
        additionalPages.push(pageUpload.url);
      }
    }

    // Clean up all temp files
    storage.deleteTempFiles(files);

    const docMetadata = { ...(metadata || {}) };
    if (additionalPages.length > 0) {
      docMetadata.additional_pages = additionalPages;
    }

    const docId = await documentsAsync.create({
      title: title || 'Untitled Document',
      date_created: dateCreated || null,
      description: description || null,
      image_path: primaryUpload.url,
      metadata: docMetadata
    });

    // Assign to collections
    if (Array.isArray(collectionIds) && collectionIds.length > 0) {
      await documentCollectionsAsync.setForDocument(docId, collectionIds.map(Number));
    }

    let transcriptId = null;
    let jobId = null;

    if (isAiMode) {
      const defaultProvider = await settingsAsync.get('default_provider');
      const selection = await resolveProviderSelectionAsync(req.user, provider || defaultProvider || 'openai', credentialSource || 'system');
      // Queue background transcription job
      const additionalImagePaths = additionalPages.length > 0 ? additionalPages : null;
      const tempVal = temperature !== '' && temperature != null ? parseFloat(temperature) : null;
      jobId = await transcriptionJobsAsync.create({
        document_id: docId,
        provider: selection.provider || provider || null,
        model: null,
        temperature: !isNaN(tempVal) ? tempVal : null,
        initiated_by: initiatedBy || null,
        image_path: primaryUpload.url,
        additional_image_paths: additionalImagePaths,
        provider_key_scope: selection.providerKeyScope,
        user_api_key_id: selection.userApiKeyId,
        requested_by_user_id: req.user.id
      });
      if (selection.providerKeyScope === 'user' && selection.userApiKeyId) {
        await userApiKeysAsync.markUsed(selection.userApiKeyId, req.user.id);
      }
    } else {
      // Save transcript immediately (manual mode)
      const pd = paradata || {};
      transcriptId = await transcriptsAsync.create({
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

    await saveDatabase();

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
  const { groups, originalName, provider, credentialSource, temperature, initiatedBy, collectionIds, importJobId } = req.body;

  if (!Array.isArray(groups) || groups.length === 0) {
    return res.status(400).json({ error: 'No documents to submit' });
  }

  try {
    const defaultProvider = await settingsAsync.get('default_provider');
    const selection = await resolveProviderSelectionAsync(req.user, provider || defaultProvider || 'openai', credentialSource || 'system');

    const savedDocs = [];
    const tempVal = temperature !== '' && temperature != null ? parseFloat(temperature) : null;

    for (const group of groups) {
      const rawGroupFiles = group.tempFiles;
      if (!rawGroupFiles || rawGroupFiles.length === 0) continue;
      const files = sanitizeTempFiles(rawGroupFiles);
      if (files.length === 0) continue;

      // Move first page as primary image
      const firstFile = files[0];
      const existsAsync = storage.tempFileExistsAsync || storage.tempFileExists;
      if (!(await existsAsync(firstFile))) continue;

      const baseName = originalName || 'document';
      const ext = '.png';
      const primaryUpload = await storage.copyTempFileToUpload(firstFile, baseName, ext);

      // Additional pages
      const additionalPages = [];
      for (let i = 1; i < files.length; i++) {
        if (!(await existsAsync(files[i]))) continue;
        const pageUpload = await storage.copyTempFileToUpload(
          files[i],
          `${path.basename(baseName, path.extname(baseName))}_page${i + 1}${ext}`,
          ext
        );
        additionalPages.push(pageUpload.url);
      }

      // Clean up temp files for this group (local + S3)
      storage.deleteTempFiles(files);
      if (storage.deleteTempObject) {
        for (const f of files) {
          try { await storage.deleteTempObject(f); } catch (e) {}
        }
      }

      const docMetadata = {};
      if (additionalPages.length > 0) {
        docMetadata.additional_pages = additionalPages;
      }

      const docId = await documentsAsync.create({
        title: group.label || 'Untitled Document',
        date_created: null,
        description: null,
        image_path: primaryUpload.url,
        metadata: docMetadata
      });

      // Assign to collections
      if (Array.isArray(collectionIds) && collectionIds.length > 0) {
        await documentCollectionsAsync.setForDocument(docId, collectionIds.map(Number));
      }

      // Queue transcription job
      const jobId = await transcriptionJobsAsync.create({
        document_id: docId,
        provider: selection.provider || provider || null,
        model: null,
        temperature: !isNaN(tempVal) ? tempVal : null,
        initiated_by: initiatedBy || null,
        image_path: primaryUpload.url,
        additional_image_paths: additionalPages.length > 0 ? additionalPages : null,
        provider_key_scope: selection.providerKeyScope,
        user_api_key_id: selection.userApiKeyId,
        requested_by_user_id: req.user.id
      });

      savedDocs.push({ documentId: docId, jobId });
    }

    await saveDatabase();

    // Mark import job as submitted so Continue button disappears
    if (importJobId) {
      try { await importJobsAsync.markSubmitted(parseInt(importJobId)); } catch (e) {}
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
  storage.deleteTempFiles(files);
  res.json({ success: true });
});

module.exports = router;
