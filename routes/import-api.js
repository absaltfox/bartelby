'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const config = require('../config');
const storage = require('../utils/storage');
const {
  documentsAsync, transcriptsAsync, settingsAsync, collectionsAsync,
  documentCollectionsAsync, transcriptionJobsAsync, importJobsAsync,
  saveDatabase, userApiKeysAsync, userCollectionAccessAsync
} = require('../database/db');
const { createProvider } = require('../utils/llm');
const { resolveProviderSelectionAsync } = require('../utils/provider-access');

// Initialize storage (temp dirs, etc.)
storage.init();

function sanitizeTempFiles(files) {
  return (files || [])
    .map(file => storage.sanitizeTempName(file))
    .filter(Boolean);
}

function attachTempPreview(page) {
  // Strip previewUrl so the client computes it using its context-aware apiBase.
  // storage.getTempPreviewUrl() is hardcoded to /admin/api/... which breaks managers.
  const { previewUrl: _, ...rest } = page;
  return rest;
}

function parseGroupingState(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || !Array.isArray(parsed.groups)) return null;
    return {
      collectionIds: Array.isArray(parsed.collectionIds)
        ? parsed.collectionIds.map((id) => parseInt(id, 10)).filter(Number.isInteger)
        : [],
      groups: parsed.groups
        .map((group) => ({
          label: String(group.label || '').trim() || null,
          source: group.source === 'ai' ? 'ai' : 'manual',
          pages: Array.isArray(group.pages) ? sanitizeTempFiles(group.pages) : []
        }))
        .filter((group) => group.pages.length >= 2)
    };
  } catch (err) {
    return null;
  }
}

function buildTranscriptPageSegments(results) {
  return results.map((result, index) => ({
    pageNumber: index + 1,
    charLength: String(result.transcription || '').trim().length
  }));
}

function normalizeCollectionIds(collectionIds) {
  if (!Array.isArray(collectionIds)) return [];
  return [...new Set(collectionIds
    .map((id) => parseInt(id, 10))
    .filter(Number.isInteger))];
}

async function getAuthorizedCollectionIds(req, collectionIds) {
  const normalized = normalizeCollectionIds(collectionIds);
  if (normalized.length === 0) return [];

  if (req.user?.role === 'admin') {
    return normalized;
  }

  const managedIds = req.managedCollectionIds || await userCollectionAccessAsync.getManagerCollectionIds(req.user.id);
  if (!normalized.every((id) => managedIds.includes(id))) {
    const err = new Error('You do not have permission to import into one or more selected collections.');
    err.statusCode = 403;
    throw err;
  }

  return normalized;
}

function spawnLocalPdfWorker({ pdfTempFile, jobRef, originalName, onProgress, onDone, onFailed }) {
  const { fork } = require('child_process');
  const child = fork(path.join(__dirname, '..', 'utils', 'pdf-worker.js'), [], {
    stdio: ['pipe', 'inherit', 'inherit', 'ipc']
  });

  let childDone = false;

  child.send({ pdfTempFile, dbJobId: jobRef, originalName });

  child.on('message', (msg) => {
    if (msg.type === 'progress') {
      onProgress && onProgress(msg);
      return;
    }

    if (msg.type === 'done') {
      childDone = true;
      onDone && onDone(msg);
      return;
    }

    if (msg.type === 'failed') {
      childDone = true;
      onFailed && onFailed(msg.error || 'PDF processing failed');
    }
  });

  child.on('error', (err) => {
    if (childDone) return;
    childDone = true;
    onFailed && onFailed(err.message);
  });

  child.on('exit', (code) => {
    if (childDone) return;
    childDone = true;
    onFailed && onFailed(`Worker process exited with code ${code}`);
  });

  return child;
}

function stripPageMarkers(text) {
  return String(text || '')
    .replace(/^\[Page\s+\d+\]\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Configure multer for temporary file uploads (images + PDFs)
const upload = multer({
  dest: config.app.tempDir,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff',
      'application/pdf'
    ];
    if (allowedTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file type. Images and PDFs are allowed.'));
  }
});

// ── API: Upload file (image or PDF) ────────────────────────────────────────
router.post('/upload', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'File too large. Maximum upload size is 200MB.'
        : (err.message || 'Upload failed');
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, (req, res, next) => {
  // CSRF deferred for multipart — validate now that multer has parsed req.body
  req.app.locals.validateCsrf(req, res, next);
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  if (req.file.mimetype === 'application/pdf') {
    const pdfTempFile = storage.sanitizeTempName(req.file.filename);
    const fileSize = req.file.size || 0;

    const FILE_SIZE_THRESHOLD = 5 * 1024 * 1024;
    const isLargePdf = fileSize >= FILE_SIZE_THRESHOLD;

    if (isLargePdf) {
      const useEphemeralMachine = config.flyMachines.enabled;
      const s3TempKey = useEphemeralMachine ? `import_${Date.now()}.pdf` : null;

      const dbJobId = await importJobsAsync.create({
        original_name: req.file.originalname,
        file_path: useEphemeralMachine ? s3TempKey : pdfTempFile,
        user_id: req.user?.id || null
      });

      res.json({
        success: true,
        type: 'pdf_queued',
        importJobId: dbJobId,
        pageCount: null,
        originalName: req.file.originalname
      });

      if (useEphemeralMachine) {
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
        spawnLocalPdfWorker({
          pdfTempFile,
          jobRef: dbJobId,
          originalName: req.file.originalname,
          onProgress: (msg) => {
            importJobsAsync.updateProgress(dbJobId, {
              page_count: msg.pageCount,
              pages_rendered: msg.pagesRendered
            }).catch(err => {
              console.error('Failed to update import job progress:', err);
            });
          },
          onDone: (msg) => {
            importJobsAsync.markDone(dbJobId, msg.pages).catch(err => {
              console.error('Failed to mark import job done:', err);
            });
            console.log(`[import] PDF "${req.file.originalname}" processed: ${msg.pages.length} pages`);
          },
          onFailed: (error) => {
            console.error('PDF worker process error:', error);
            importJobsAsync.markFailed(dbJobId, error).catch(err => {
              console.error('Failed to persist import worker error:', err);
            });
          }
        });
      }

    } else {
      // Small PDF: process in a forked worker, track via DB job
      const dbJobId = await importJobsAsync.create({
        original_name: req.file.originalname,
        file_path: pdfTempFile,
        user_id: req.user?.id || null
      });

      res.json({
        success: true,
        type: 'pdf_queued',
        importJobId: dbJobId,
        pageCount: null,
        originalName: req.file.originalname
      });

      spawnLocalPdfWorker({
        pdfTempFile,
        jobRef: dbJobId,
        originalName: req.file.originalname,
        onProgress: (msg) => {
          importJobsAsync.updateProgress(dbJobId, {
            page_count: msg.pageCount,
            pages_rendered: msg.pagesRendered
          }).catch((err) => {
            console.error('Failed to update import job progress:', err);
          });
        },
        onDone: (msg) => {
          importJobsAsync.markDone(dbJobId, msg.pages).catch((err) => {
            console.error('Failed to mark import job done:', err);
          });
          console.log(`[import] PDF "${req.file.originalname}" processed: ${(msg.pages || []).length} pages`);
        },
        onFailed: (error) => {
          console.error('PDF background processing error:', error);
          importJobsAsync.markFailed(dbJobId, error).catch((err) => {
            console.error('Failed to mark import job failed:', err);
          });
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

// ── API: Poll import job status (DB-backed) ──────────────────────────────
router.get('/import-job/:id', async (req, res) => {
  const job = await importJobsAsync.getById(parseInt(req.params.id, 10));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (req.user?.role !== 'admin' && job.user_id !== req.user?.id) {
    return res.status(403).json({ error: 'You do not have access to that job.' });
  }

  let pages = [];
  if (job.status === 'done' && job.pages) {
    try {
      pages = JSON.parse(job.pages).map(attachTempPreview);
    } catch (e) {}
  }

  res.json({
    status: job.status,
    page_count: job.page_count || null,
    pages_rendered: job.pages_rendered || 0,
    pages,
    error: job.error || null
  });
});

// ── API: Serve temp page image ─────────────────────────────────────────────
router.get('/temp-image/:filename', async (req, res) => {
  const filename = storage.sanitizeTempName(req.params.filename);

  const filePath = storage.getTempFilePath(filename);
  if (filePath && storage.tempFileExists(filename)) {
    return res.type('image/png').sendFile(filePath);
  }

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

// ── API: Transcribe a single image ─────────────────────────────────────────
router.post('/transcribe', express.json(), async (req, res) => {
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
    res.status(500).json({ error: 'Transcription failed' });
  }
});

// ── API: Transcribe a group of pages ───────────────────────────────────────
router.post('/transcribe-group', express.json(), async (req, res) => {
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

    const combined = {
      transcription: results.map(r => String(r.transcription || '').trim()).join('\n\n'),
      pageSegments: results.length > 1 ? buildTranscriptPageSegments(results) : null,
      metadata: results[0].metadata,
      notes: results.map(r => r.notes).filter(Boolean).join(' | ') || null,
      paradata: results[0].paradata
    };

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
    res.status(500).json({ error: 'Group transcription failed' });
  }
});

// ── API: Save document ─────────────────────────────────────────────────────
router.post('/save-document', express.json(), async (req, res) => {
  const {
    tempFile, tempFiles, originalName, mimeType,
    title, dateCreated, description, metadata,
    transcription, notes, transcriber,
    initiatedBy, paradata,
    pageSegments,
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
    const authorizedCollectionIds = await getAuthorizedCollectionIds(req, collectionIds);
    const firstFile = files[0];
    if (!storage.tempFileExists(firstFile)) {
      return res.status(400).json({ error: 'Temporary file not found. Please upload again.' });
    }

    const baseName = originalName || 'document';
    const ext = path.extname(baseName) === '.pdf' ? '.png' : (path.extname(baseName) || '.jpg');
    const primaryUpload = await storage.copyTempFileToUpload(firstFile, baseName, ext);

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

    if (authorizedCollectionIds.length > 0) {
      await documentCollectionsAsync.setForDocument(docId, authorizedCollectionIds);
    }

    let transcriptId = null;
    let jobId = null;

    if (isAiMode) {
      const defaultProvider = await settingsAsync.get('default_provider');
      const selection = await resolveProviderSelectionAsync(req.user, provider || defaultProvider || 'openai', credentialSource || 'system');
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
      const pd = paradata || {};
      transcriptId = await transcriptsAsync.create({
        document_id: docId,
        content: stripPageMarkers(transcription),
        page_segments: Array.isArray(pageSegments) && pageSegments.length > 1 ? pageSegments : null,
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
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── API: Bulk submit pages ─────────────────────────────────────────────────
// For large PDFs (hundreds of pages), each group requires multiple S3 round-trips
// (existence check, copy temp→permanent, delete temp). Processing sequentially
// in a single request can take minutes for 600+ pages, causing the user to think
// the page is hung. Instead, we validate + resolve provider up front, respond
// immediately, and process groups in the background.
router.post('/submit-pages', express.json(), async (req, res) => {
  const { groups, originalName, provider, credentialSource, temperature, initiatedBy, collectionIds, importJobId } = req.body;

  if (!Array.isArray(groups) || groups.length === 0) {
    return res.status(400).json({ error: 'No documents to submit' });
  }

  try {
    const authorizedCollectionIds = await getAuthorizedCollectionIds(req, collectionIds);
    // Resolve provider selection up front (requires req.user, fast)
    const defaultProvider = await settingsAsync.get('default_provider');
    const selection = await resolveProviderSelectionAsync(req.user, provider || defaultProvider || 'openai', credentialSource || 'system');
    const tempVal = temperature !== '' && temperature != null ? parseFloat(temperature) : null;
    const userId = req.user.id;

    // Respond immediately — background processing follows
    res.json({
      success: true,
      documents: [],
      count: groups.length,
      background: true
    });

    // ── Background processing ──────────────────────────────────────
    // Use server-side S3 copy when available (avoids download+re-upload).
    // Collect all temp file names for a single batch delete at the end.
    const copyFn = storage.copyTempObjectToUpload || storage.copyTempFileToUpload;
    const allTempFiles = []; // accumulate for batch delete

    setImmediate(async () => {
      let processed = 0;
      try {
        for (const group of groups) {
          const rawGroupFiles = group.tempFiles;
          if (!rawGroupFiles || rawGroupFiles.length === 0) continue;
          const files = sanitizeTempFiles(rawGroupFiles);
          if (files.length === 0) continue;

          // Copy all pages to permanent storage in parallel (no existence check —
          // the worker already created these; if a copy fails we skip it)
          const baseName = originalName || 'document';
          const ext = '.png';

          const uploadPromises = files.map(async (file, i) => {
            const name = i === 0
              ? baseName
              : `${path.basename(baseName, path.extname(baseName))}_page${i + 1}${ext}`;
            try {
              return await copyFn(file, name, ext);
            } catch (err) {
              console.error(`[import] Failed to copy page ${file}:`, err.message);
              return null;
            }
          });
          const uploads = await Promise.all(uploadPromises);

          const primaryUpload = uploads[0];
          if (!primaryUpload) continue;
          const additionalPages = uploads.slice(1).filter(Boolean).map(u => u.url);

          // Queue temp files for batch cleanup at the end
          storage.deleteTempFiles(files); // local cleanup (free)
          allTempFiles.push(...files);

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

          if (authorizedCollectionIds.length > 0) {
            await documentCollectionsAsync.setForDocument(docId, authorizedCollectionIds);
          }

          await transcriptionJobsAsync.create({
            document_id: docId,
            provider: selection.provider || provider || null,
            model: null,
            temperature: !isNaN(tempVal) ? tempVal : null,
            initiated_by: initiatedBy || null,
            image_path: primaryUpload.url,
            additional_image_paths: additionalPages.length > 0 ? additionalPages : null,
            provider_key_scope: selection.providerKeyScope,
            user_api_key_id: selection.userApiKeyId,
            requested_by_user_id: userId
          });

          processed++;

          // Periodic DB save every 25 documents to avoid losing progress
          if (processed % 25 === 0) {
            await saveDatabase();
          }
        }

        await saveDatabase();

        // Batch-delete all temp objects from S3 in one request (instead of N individual deletes)
        if (storage.deleteTempObjectsBatch && allTempFiles.length > 0) {
          try {
            await storage.deleteTempObjectsBatch(allTempFiles);
          } catch (err) {
            console.error('[import] Batch temp cleanup error:', err.message);
          }
        } else if (storage.deleteTempObject) {
          // Fallback: parallel individual deletes
          await Promise.all(allTempFiles.map(f =>
            storage.deleteTempObject(f).catch(() => {})
          ));
        }

        if (importJobId) {
          try { await importJobsAsync.markSubmitted(parseInt(importJobId)); } catch (e) {}
        }

        console.log(`[import] Background submit complete: ${processed} documents created`);
      } catch (err) {
        console.error(`[import] Background submit error after ${processed} documents:`, err);
        // Save whatever progress we made
        try { await saveDatabase(); } catch (e) {}
      }
    });
  } catch (err) {
    console.error('Bulk submit error:', err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── API: Persist current grouping state for a resumable import job ─────────
router.post('/groupings', express.json(), async (req, res) => {
  const importJobId = parseInt(req.body.importJobId, 10);
  if (!Number.isInteger(importJobId)) {
    return res.status(400).json({ error: 'Missing import job ID.' });
  }

  const groupingState = parseGroupingState(req.body.groupingState);

  try {
    const job = await importJobsAsync.getById(importJobId);
    if (!job) {
      return res.status(404).json({ error: 'Import job not found.' });
    }

    if (req.user?.role !== 'admin' && job.user_id !== req.user?.id) {
      return res.status(403).json({ error: 'You do not have access to that import job.' });
    }

    await importJobsAsync.updateGroupingState(importJobId, groupingState);
    res.json({ success: true });
  } catch (err) {
    console.error('Persist grouping state error:', err);
    res.status(500).json({ error: 'Failed to save grouping state' });
  }
});

// ── API: AI-suggested page groupings ──────────────────────────────────────
// Crops the top ~15% of each page image (where archival numbers typically
// appear), then sends the tiny strips to the cheapest available vision model
// in batches. This keeps cost minimal — a 600-page PDF produces ~12 API calls
// with small image payloads instead of 600 full-image calls.
router.post('/suggest-groups', express.json(), async (req, res) => {
  const { tempFiles } = req.body;
  if (!Array.isArray(tempFiles) || tempFiles.length < 2) {
    return res.status(400).json({ error: 'Need at least 2 pages to suggest groupings' });
  }
  if (tempFiles.length > 2000) {
    return res.status(400).json({ error: 'Too many pages (max 2000) for grouping analysis' });
  }

  try {
    const defaultProvider = await settingsAsync.get('default_provider');
    const { provider: providerName = defaultProvider || 'openai', credentialSource = 'system' } = req.body;
    const selection = await resolveProviderSelectionAsync(req.user, providerName, credentialSource);
    const provider = await createProvider(providerName, selection.runtimeConfig);

    const { createCanvas, loadImage } = require('canvas');
    const CROP_RATIO = 0.15; // top 15% of page
    const BATCH_SIZE = 50;   // small strips → more per batch
    const pageAnnotations = [];

    for (let i = 0; i < tempFiles.length; i += BATCH_SIZE) {
      const batch = tempFiles.slice(i, i + BATCH_SIZE);
      const imageContents = [];

      for (let j = 0; j < batch.length; j++) {
        const safeName = storage.sanitizeTempName(batch[j]);
        let buffer;
        try {
          if (storage.tempFileExists(safeName)) {
            buffer = storage.readTempFile(safeName);
          } else if (storage.getTempObject) {
            buffer = await storage.getTempObject(safeName);
          }
        } catch (e) { continue; }
        if (!buffer) continue;

        // Crop the top strip of the page
        try {
          const img = await loadImage(buffer);
          const cropHeight = Math.round(img.height * CROP_RATIO);
          const canvas = createCanvas(img.width, cropHeight);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, img.width, cropHeight, 0, 0, img.width, cropHeight);
          buffer = canvas.toBuffer('image/png');
        } catch (e) {
          // If cropping fails, skip this page rather than sending the full image
          continue;
        }

        imageContents.push(
          { type: 'text', text: `Image ${i + j + 1}:` },
          { type: 'image', image: buffer, mimeType: 'image/png' }
        );
      }

      if (imageContents.length === 0) continue;

      const result = await provider.generateGroupingSuggestion(imageContents, i, batch.length);
      if (Array.isArray(result)) {
        pageAnnotations.push(...result);
      }
    }

    const groups = buildGroupsFromAnnotations(pageAnnotations, tempFiles);

    res.json({ success: true, groups });
  } catch (err) {
    console.error('Suggest groups error:', err);
    res.status(500).json({ error: 'Failed to generate grouping suggestions' });
  }
});

function buildGroupsFromAnnotations(annotations, tempFiles) {
  if (!annotations || annotations.length === 0) return [];

  const annotationMap = new Map();
  annotations.forEach((annotation) => {
    const page = parseInt(annotation.page, 10);
    if (!Number.isInteger(page) || page < 1 || page > tempFiles.length) return;
    const number = annotation.number != null ? parseInt(annotation.number, 10) : null;
    annotationMap.set(page, Number.isInteger(number) && number > 0 ? number : null);
  });

  const groups = [];
  let index = 0;

  function hasUpcomingExpectedNumber(startCursor, expectedNumber) {
    for (let lookahead = startCursor; lookahead < tempFiles.length; lookahead++) {
      const upcomingNumber = annotationMap.get(lookahead + 1);
      if (upcomingNumber === expectedNumber) return true;
      if (upcomingNumber === 1) return false;
    }
    return false;
  }

  while (index < tempFiles.length) {
    const startNumber = annotationMap.get(index + 1);
    if (startNumber !== 1) {
      index += 1;
      continue;
    }

    const pages = [index];
    let explicitMatches = 1;
    let expectedNumber = 2;
    let cursor = index + 1;

    while (cursor < tempFiles.length) {
      const detectedNumber = annotationMap.get(cursor + 1);

      if (detectedNumber === expectedNumber) {
        pages.push(cursor);
        explicitMatches += 1;
        expectedNumber += 1;
        cursor += 1;
        continue;
      }

      // Allow duplicate numbered pages within the same document run, such as
      // 1, 2, 2, 3. The duplicate page belongs with the surrounding sequence,
      // but it should not advance the expected next page number.
      if (
        explicitMatches >= 2 &&
        detectedNumber === expectedNumber - 1 &&
        hasUpcomingExpectedNumber(cursor + 1, expectedNumber)
      ) {
        pages.push(cursor);
        cursor += 1;
        continue;
      }

      // Once we've seen a credible numbered run, allow unlabeled trailing pages
      // until the next explicit start-of-document marker.
      if (
        detectedNumber == null &&
        explicitMatches >= 2 &&
        hasUpcomingExpectedNumber(cursor + 1, expectedNumber)
      ) {
        pages.push(cursor);
        cursor += 1;
        continue;
      }

      break;
    }

    if (explicitMatches >= 2) {
      groups.push({
        pageIndices: pages,
        label: `Document (pages ${pages.map(p => p + 1).join(', ')})`
      });
      index = cursor;
      continue;
    }

    index += 1;
  }

  return groups;
}

// ── API: Cancel/cleanup temp files ─────────────────────────────────────────
router.post('/cancel-import', express.json(), (req, res) => {
  const { tempFile, tempFiles } = req.body;
  const files = tempFiles || (tempFile ? [tempFile] : []);
  storage.deleteTempFiles(files);
  res.json({ success: true });
});

// Export router and the attachTempPreview helper (used by import page routes)
router.attachTempPreview = attachTempPreview;
module.exports = router;
