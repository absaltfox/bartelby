'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const storage = require('../utils/storage');
const { extensionFromMimeType, mimeTypeFromFilename } = require('../utils/mime-types');
const {
  getTempImageContentType,
  parseGroupingState,
  buildTranscriptPageSegments,
  getAuthorizedCollectionIds,
  spawnLocalPdfWorker,
  stripPageMarkers,
  buildGroupsFromAnnotations
} = require('../utils/import-workflow');
const { supportsBatchProvider } = require('../utils/transcription-batches');
const {
  sanitizeTempFiles,
  collectTempCleanupFiles,
  attachTempPreview,
  getImportJobPreviewMap,
  tempAssetExists,
  readTempAsset,
  copyTempAssetToUpload,
  deleteTempAssets
} = require('../utils/temp-assets');
const {
  documentsAsync, transcriptsAsync, settingsAsync, collectionsAsync,
  documentCollectionsAsync, transcriptionJobsAsync, importJobsAsync,
  saveDatabase, userApiKeysAsync, userCollectionAccessAsync
} = require('../database/db');

// Initialize storage (temp dirs, etc.)
storage.init();

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

  const tempName = storage.sanitizeTempName(req.file.filename);
  const tempPath = storage.getTempFilePath(tempName);
  const extFromName = path.extname(req.file.originalname || '').toLowerCase();
  const extFromMime = extensionFromMimeType(req.file.mimetype, '');
  const uploadExt = extFromName || extFromMime || (req.file.mimetype === 'application/pdf' ? '.pdf' : '');

  if (tempPath && uploadExt && !tempName.toLowerCase().endsWith(uploadExt)) {
    // Keep the temp filename extension aligned with the source MIME so later
    // transcribe/save paths can infer the real type without extra schema state.
    const renamed = `${tempName}${uploadExt}`;
    fs.renameSync(tempPath, storage.getTempFilePath(renamed));
    req.file.filename = renamed;
    if (req.file.path) req.file.path = storage.getTempFilePath(renamed);
  }

  if (req.file.mimetype === 'application/pdf') {
    const pdfTempFile = storage.sanitizeTempName(req.file.filename);
    const fileSize = req.file.size || 0;

    const FILE_SIZE_THRESHOLD = 5 * 1024 * 1024;
    const isLargePdf = fileSize >= FILE_SIZE_THRESHOLD;

    if (isLargePdf) {
      const useEphemeralMachine = config.flyMachines.enabled && config.storage.driver === 's3';
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
          const pdfBuffer = await readTempAsset(pdfTempFile);
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
  const contentType = getTempImageContentType(filename);

  const filePath = storage.getTempFilePath(filename);
  if (filePath && await tempAssetExists(filename)) {
    return res.type(contentType).sendFile(filePath);
  }

  try {
    const buffer = await readTempAsset(filename);
    res.set('Cache-Control', 'private, max-age=3600');
    return res.type(contentType).send(buffer);
  } catch (err) {
    // fall through
  }

  res.status(404).send('Not found');
});

// ── API: Transcribe a single image ─────────────────────────────────────────
router.post('/transcribe', express.json(), async (req, res) => {
  const { tempFile, provider: providerName = 'openai', credentialSource = 'system', temperature } = req.body;
  if (!tempFile) return res.status(400).json({ error: 'No temp file specified' });

  const safeTempFile = storage.sanitizeTempName(tempFile);
  if (!(await tempAssetExists(safeTempFile))) return res.status(400).json({ error: 'Temp file not found' });

  try {
    const { resolveProviderSelectionAsync } = require('../utils/provider-access');
    const { createProvider } = require('../utils/llm');
    const selection = await resolveProviderSelectionAsync(req.user, providerName, credentialSource);
    const provider = await createProvider(providerName, selection.runtimeConfig);
    const imageBuffer = await readTempAsset(safeTempFile);
    const mimeType = mimeTypeFromFilename(safeTempFile, req.body.mimeType || 'image/png');
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
  const { tempFiles, provider: providerName = 'openai', credentialSource = 'system', temperature, mimeTypes } = req.body;
  if (!Array.isArray(tempFiles) || tempFiles.length === 0) {
    return res.status(400).json({ error: 'No files specified' });
  }

  try {
    const { resolveProviderSelectionAsync } = require('../utils/provider-access');
    const { createProvider } = require('../utils/llm');
    const selection = await resolveProviderSelectionAsync(req.user, providerName, credentialSource);
    const provider = await createProvider(providerName, selection.runtimeConfig);
    const opts = {
      temperature: temperature !== '' && temperature != null
        ? parseFloat(temperature)
        : null
    };

    const results = [];
    for (let index = 0; index < tempFiles.length; index++) {
      const tf = tempFiles[index];
      const safeTempFile = storage.sanitizeTempName(tf);
      if (!(await tempAssetExists(safeTempFile))) continue;
      const imageBuffer = await readTempAsset(safeTempFile);
      const mimeType = Array.isArray(mimeTypes) ? mimeTypes[index] : null;
      const result = await provider.transcribeDocument(
        imageBuffer,
        mimeTypeFromFilename(safeTempFile, mimeType || 'image/png'),
        opts
      );
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
    temperature,
    importJobId
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
    const importJobPreviewMap = Number.isInteger(parseInt(importJobId, 10))
      ? await getImportJobPreviewMap(parseInt(importJobId, 10))
      : new Map();
    const firstFile = files[0];
    if (!(await tempAssetExists(firstFile))) {
      return res.status(400).json({ error: 'Temporary file not found. Please upload again.' });
    }

    const baseName = originalName || 'document';
    const ext = path.extname(baseName) === '.pdf'
      ? '.png'
      : (path.extname(baseName) || path.extname(firstFile) || '.jpg');
    const primaryUpload = await copyTempAssetToUpload(firstFile, baseName, ext);

    const additionalPages = [];
    if (files.length > 1) {
      for (let i = 1; i < files.length; i++) {
        if (!(await tempAssetExists(files[i]))) continue;
        const pageUpload = await copyTempAssetToUpload(
          files[i],
          `${path.basename(baseName, path.extname(baseName))}_page${i + 1}${ext}`,
          ext
        );
        additionalPages.push(pageUpload.url);
      }
    }

    await deleteTempAssets(collectTempCleanupFiles(files, importJobPreviewMap));

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
      const { resolveProviderSelectionAsync } = require('../utils/provider-access');
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
// Submit grouped pages as a durable background import job. The HTTP request
// returns immediately, but the actual document creation/transcription queueing
// is handled by the worker so it survives restarts and deploys.
router.post('/submit-pages', express.json(), async (req, res) => {
  const {
    groups,
    originalName,
    provider,
    credentialSource,
    temperature,
    initiatedBy,
    collectionIds,
    importJobId,
    useBatchTranscription
  } = req.body;

  if (!Array.isArray(groups) || groups.length === 0) {
    return res.status(400).json({ error: 'No documents to submit' });
  }

  try {
    const authorizedCollectionIds = await getAuthorizedCollectionIds(req, collectionIds);
    const { resolveProviderSelectionAsync } = require('../utils/provider-access');
    const defaultProvider = await settingsAsync.get('default_provider');
    const selection = await resolveProviderSelectionAsync(req.user, provider || defaultProvider || 'openai', credentialSource || 'system');
    const tempVal = temperature !== '' && temperature != null ? parseFloat(temperature) : null;
    const userId = req.user.id;
    const requestedBatchMode = !!useBatchTranscription
      && groups.length > 10
      && supportsBatchProvider(selection.provider || provider || defaultProvider || 'openai');
    const submissionJobId = await importJobsAsync.createSubmissionJob({
      original_name: originalName || `${groups.length} grouped documents`,
      user_id: userId,
      total_count: groups.length,
      payload: {
        sourceImportJobId: Number.isInteger(parseInt(importJobId, 10)) ? parseInt(importJobId, 10) : null,
        originalName: originalName || null,
        authorizedCollectionIds,
        provider: selection.provider || provider || null,
        providerKeyScope: selection.providerKeyScope,
        userApiKeyId: selection.userApiKeyId,
        requestedByUserId: userId,
        initiatedBy: initiatedBy || null,
        temperature: !isNaN(tempVal) ? tempVal : null,
        requestedBatchMode,
        remainingGroups: groups.map((group) => ({
          label: group.label || 'Untitled Document',
          tempFiles: Array.isArray(group.tempFiles) ? group.tempFiles : []
        })),
        createdDocs: [],
        batchManifest: [],
        batchJobCreated: false,
        processedCount: 0
      }
    });

    if (Number.isInteger(parseInt(importJobId, 10))) {
      await importJobsAsync.markSubmitted(parseInt(importJobId, 10));
    }

    res.json({
      success: true,
      documents: [],
      count: groups.length,
      background: true,
      mode: requestedBatchMode ? 'batch' : 'queue',
      importJobId: submissionJobId
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
    const { resolveProviderSelectionAsync } = require('../utils/provider-access');
    const { createProvider } = require('../utils/llm');
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
          if (await tempAssetExists(safeName)) {
            buffer = await readTempAsset(safeName);
          }
        } catch (e) { continue; }
        if (!buffer) continue;

        // Crop the top strip of the page
        try {
          const img = await loadImage(buffer);
          const cropHeight = Math.round(img.height * CROP_RATIO);
          // Anthropic's many-image API limit: each dimension must be ≤ 1999px
          const MAX_DIM = 1999;
          const scale = Math.min(1, MAX_DIM / img.width, MAX_DIM / cropHeight);
          const outW = Math.round(img.width * scale);
          const outH = Math.round(cropHeight * scale);
          const canvas = createCanvas(outW, outH);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, img.width, cropHeight, 0, 0, outW, outH);
          buffer = canvas.toBuffer('image/png');
        } catch (e) {
          // If cropping fails, skip this page rather than sending the full image
          continue;
        }

        imageContents.push(
          { type: 'text', text: `Image ${i + j + 1}:` },
          { type: 'image', image: buffer, mimeType: mimeTypeFromFilename(safeName, 'image/png') }
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

// ── API: Cancel/cleanup temp files ─────────────────────────────────────────
router.post('/cancel-import', express.json(), async (req, res) => {
  const { tempFile, tempFiles, importJobId } = req.body;
  const parsedImportJobId = parseInt(importJobId, 10);
  const files = tempFiles || (tempFile ? [tempFile] : []);

  try {
    const previewMap = Number.isInteger(parsedImportJobId)
      ? await getImportJobPreviewMap(parsedImportJobId)
      : new Map();
    await deleteTempAssets(collectTempCleanupFiles(files, previewMap));
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to clean up temp files:', err);
    res.status(500).json({ error: 'Failed to clean up temporary files' });
  }
});

// Export router and the attachTempPreview helper (used by import page routes)
router.attachTempPreview = attachTempPreview;
module.exports = router;
