// PDF page rendering worker.
// Two modes:
//   1. IPC mode: forked by the web server, communicates via process.send()
//   2. Standalone mode: runs on an ephemeral Fly machine, reads/writes S3 + Turso directly
//
// Uses pdftoppm (poppler-utils) when available, falls back to pdfjs-dist + canvas.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const sharp = require('sharp');
const storage = require('./storage');
const { readTempAsset, deleteTempAssets } = require('./temp-assets');
const { processWithConcurrency } = require('./concurrency');

const isStandalone = process.env.PDF_WORKER_MODE === '1';
const PREVIEW_MAX_WIDTH = 960;
const PREVIEW_QUALITY = 72;
const PAGE_PROCESSING_CONCURRENCY = 4;
const RASTER_PROGRESS_INTERVAL_MS = 5000;

// ── Progress reporting ──────────────────────────────────────────────────

let _importJobsAsync = null;

async function getImportJobs() {
  if (!_importJobsAsync) {
    const { importJobsAsync } = require('../database/db');
    _importJobsAsync = importJobsAsync;
  }
  return _importJobsAsync;
}

async function reportProgress(dbJobId, pageCount, pagesRendered) {
  if (isStandalone) {
    const ij = await getImportJobs();
    await ij.updateProgress(dbJobId, { page_count: pageCount, pages_rendered: pagesRendered });
  } else {
    process.send({ type: 'progress', dbJobId, pageCount, pagesRendered });
  }
}

async function reportDone(dbJobId, pages, originalName) {
  if (isStandalone) {
    const ij = await getImportJobs();
    await ij.markDone(dbJobId, pages);
    console.log(`[import] PDF "${originalName}" processed: ${pages.length} pages`);
  } else {
    return new Promise(resolve => {
      process.send({ type: 'done', dbJobId, pages, originalName }, resolve);
    });
  }
}

async function reportFailed(dbJobId, error) {
  if (isStandalone) {
    const ij = await getImportJobs();
    await ij.markFailed(dbJobId, error);
  } else {
    return new Promise(resolve => {
      process.send({ type: 'failed', dbJobId, error }, resolve);
    });
  }
}

// ── Page storage ────────────────────────────────────────────────────────

async function storeTempAsset(filename, buffer) {
  if (isStandalone) {
    // Upload to S3 so the web server can serve previews
    await storage.putTempObject(filename, buffer);
  } else {
    // Write to local temp dir (web server can read directly)
    storage.writeTempFile(filename, buffer);
  }
}

// ── Renderers ───────────────────────────────────────────────────────────

function hasPdftoppm() {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Production guardrail: the pdfjs-dist fallback is for dev only. If a
// production worker lacks pdftoppm, fail at module load rather than silently
// rendering uploaded PDFs through a known-vulnerable path
// (GHSA-wgrm-67xf-hhpq). See docs/background-jobs.md and DEPLOY.md.
if (process.env.NODE_ENV === 'production' && !hasPdftoppm()) {
  throw new Error(
    'pdf-worker: pdftoppm (poppler-utils) is required in production. '
    + 'Install it in the worker image (Dockerfile) or unset NODE_ENV=production.'
  );
}

function hasPdfimages() {
  try {
    execFileSync('pdfimages', ['-v'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function getPdfPageCount(pdfPath) {
  try {
    const output = execFileSync('pdfinfo', [pdfPath], {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 10000
    });
    const match = output.match(/^Pages:\s+(\d+)/m);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function makePageAssetNames(prefix, pageNumber) {
  return {
    filename: `${prefix}_page${pageNumber}.png`,
    previewFilename: `${prefix}_page${pageNumber}_preview.jpg`
  };
}

function compareNumericFilename(a, b) {
  const aParts = path.basename(a).match(/\d+/g) || [];
  const bParts = path.basename(b).match(/\d+/g) || [];
  const count = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < count; i++) {
    const aValue = aParts[i] == null ? -1 : parseInt(aParts[i], 10);
    const bValue = bParts[i] == null ? -1 : parseInt(bParts[i], 10);
    if (aValue !== bValue) return aValue - bValue;
  }
  return path.basename(a).localeCompare(path.basename(b));
}

function collectGeneratedPngs(outDir, prefix) {
  return fs.readdirSync(outDir)
    .filter((filename) => filename.startsWith(prefix) && filename.endsWith('.png'))
    .sort(compareNumericFilename)
    .map((filename) => path.join(outDir, filename));
}

async function buildPageAssetsFromBuffer(sourceBuffer, pageNumber, prefix) {
  const { filename, previewFilename } = makePageAssetNames(prefix, pageNumber);
  const image = sharp(sourceBuffer, { failOn: 'none' }).rotate();
  const [masterBuffer, previewBuffer] = await Promise.all([
    image.clone().png().toBuffer(),
    image.clone()
      .resize({ width: PREVIEW_MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: PREVIEW_QUALITY, mozjpeg: true })
      .toBuffer()
  ]);

  await Promise.all([
    storeTempAsset(filename, masterBuffer),
    storeTempAsset(previewFilename, previewBuffer)
  ]);

  return {
    pageNumber,
    filename,
    previewFilename,
    previewUrl: storage.getTempPreviewUrl(previewFilename)
  };
}

function parsePdfImagesList(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('page') && !line.startsWith('-'))
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 16) return null;
      return {
        page: parseInt(parts[0], 10),
        num: parseInt(parts[1], 10),
        type: parts[2].toLowerCase(),
        width: parseInt(parts[3], 10),
        height: parseInt(parts[4], 10),
        color: parts[5].toLowerCase(),
        comp: parseInt(parts[6], 10),
        bpc: parseInt(parts[7], 10),
        enc: parts[8].toLowerCase(),
        interp: parts[9].toLowerCase()
      };
    })
    .filter(Boolean);
}

function canUseDirectExtraction(rows, pageCount) {
  if (!rows.length || !Number.isInteger(pageCount) || pageCount <= 0) return false;

  const counts = new Map();
  for (const row of rows) {
    if (!Number.isInteger(row.page) || row.page < 1 || row.page > pageCount) return false;
    if (row.type.includes('mask')) return false;
    counts.set(row.page, (counts.get(row.page) || 0) + 1);
  }

  for (let page = 1; page <= pageCount; page++) {
    if ((counts.get(page) || 0) !== 1) return false;
  }

  return true;
}

async function extractEmbeddedPageImages(pdfPath, dbJobId, prefix) {
  if (!hasPdfimages()) return null;

  let extractedFiles = [];

  try {
    const listOutput = execFileSync('pdfimages', ['-list', pdfPath], {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: isStandalone ? 15 * 60 * 1000 : 5 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024
    });
    const rows = parsePdfImagesList(listOutput);
    const pageCount = getPdfPageCount(pdfPath);
    if (!canUseDirectExtraction(rows, pageCount)) {
      return null;
    }

    console.log(`PDF worker: extraction-first path selected for ${pageCount} page(s)`);
    await reportProgress(dbJobId, pageCount, 0);

    const tempPrefix = path.join(path.dirname(pdfPath), `${prefix}_embedded`);
    const tempPrefixBase = path.basename(tempPrefix);

    await runPdfimagesWithProgress({
      pdfPath,
      tempPrefix,
      outDir: path.dirname(pdfPath),
      tempPrefixBase,
      dbJobId,
      pageCount,
      timeoutMs: isStandalone ? 30 * 60 * 1000 : 10 * 60 * 1000
    });

    extractedFiles = collectGeneratedPngs(path.dirname(pdfPath), tempPrefixBase);

    if (extractedFiles.length !== rows.length) {
      return null;
    }

    const progressState = { completed: 0 };
    const pages = await processWithConcurrency(
      rows.map((row, index) => ({
        pageNumber: row.page,
        srcPath: extractedFiles[index]
      })),
      PAGE_PROCESSING_CONCURRENCY,
      async ({ pageNumber, srcPath }) => {
        const sourceBuffer = fs.readFileSync(srcPath);
        const { filename, previewFilename } = makePageAssetNames(prefix, pageNumber);
        const previewBuffer = await sharp(sourceBuffer)
          .rotate()
          .resize({ width: PREVIEW_MAX_WIDTH, withoutEnlargement: true })
          .jpeg({ quality: PREVIEW_QUALITY, mozjpeg: true })
          .toBuffer();

        await Promise.all([
          storeTempAsset(filename, sourceBuffer),
          storeTempAsset(previewFilename, previewBuffer)
        ]);

        progressState.completed += 1;
        await reportProgress(dbJobId, pageCount, progressState.completed);
        return {
          pageNumber,
          filename,
          previewFilename,
          previewUrl: storage.getTempPreviewUrl(previewFilename)
        };
      }
    );

    return pages.sort((a, b) => a.pageNumber - b.pageNumber);
  } catch (err) {
    console.warn(`PDF worker: extraction-first path unavailable, falling back (${err.message})`);
    return null;
  } finally {
    for (const file of extractedFiles) {
      try { fs.unlinkSync(file); } catch {}
    }
  }
}

function runPdfimagesWithProgress({
  pdfPath,
  tempPrefix,
  outDir,
  tempPrefixBase,
  dbJobId,
  pageCount,
  timeoutMs,
  reportProgressImpl = reportProgress
}) {
  return new Promise((resolve, reject) => {
    const child = spawn('pdfimages', ['-png', '-p', pdfPath, tempPrefix], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const output = [];
    let settled = false;
    let lastReported = 0;
    let progressBusy = false;
    let progressTimer = null;
    let timeoutTimer = null;

    function appendOutput(chunk) {
      if (!chunk) return;
      output.push(String(chunk));
      if (output.length > 40) output.splice(0, output.length - 40);
    }

    async function pollProgress() {
      if (settled || progressBusy || !pageCount) return;
      progressBusy = true;
      try {
        const rendered = collectGeneratedPngs(outDir, tempPrefixBase).length;
        if (rendered !== lastReported) {
          lastReported = rendered;
          await reportProgressImpl(dbJobId, pageCount, Math.min(rendered, pageCount));
        }
      } catch (err) {
        console.warn(`PDF worker: failed to poll pdfimages progress (${err.message})`);
      } finally {
        progressBusy = false;
      }
    }

    function cleanupTimers() {
      if (progressTimer) clearInterval(progressTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      progressTimer = null;
      timeoutTimer = null;
    }

    progressTimer = setInterval(() => {
      pollProgress().catch(() => {});
    }, RASTER_PROGRESS_INTERVAL_MS);
    timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      child.kill('SIGTERM');
      reject(new Error(`pdfimages timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      reject(err);
    });
    child.on('close', async (code, signal) => {
      if (settled) return;
      cleanupTimers();
      try {
        await pollProgress();
      } catch {}
      settled = true;
      if (code === 0) {
        resolve();
        return;
      }
      const detail = output.join('').trim();
      reject(new Error(`pdfimages exited with ${signal || `code ${code}`}${detail ? `: ${detail}` : ''}`));
    });
  });
}

function runPdftoppmWithProgress({ pdfPath, outPrefix, outDir, prefix, dbJobId, pageCount, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn('pdftoppm', ['-png', '-r', '200', pdfPath, outPrefix], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const output = [];
    let settled = false;
    let lastReported = 0;
    let progressBusy = false;
    let progressTimer = null;
    let timeoutTimer = null;

    function appendOutput(chunk) {
      if (!chunk) return;
      output.push(String(chunk));
      if (output.length > 40) output.splice(0, output.length - 40);
    }

    async function pollProgress() {
      if (settled || progressBusy || !pageCount) return;
      progressBusy = true;
      try {
        const rendered = collectGeneratedPngs(outDir, prefix).length;
        if (rendered !== lastReported) {
          lastReported = rendered;
          await reportProgress(dbJobId, pageCount, Math.min(rendered, pageCount));
        }
      } catch (err) {
        console.warn(`PDF worker: failed to poll pdftoppm progress (${err.message})`);
      } finally {
        progressBusy = false;
      }
    }

    function cleanupTimers() {
      if (progressTimer) clearInterval(progressTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      progressTimer = null;
      timeoutTimer = null;
    }

    progressTimer = setInterval(() => {
      pollProgress().catch(() => {});
    }, RASTER_PROGRESS_INTERVAL_MS);
    timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      child.kill('SIGTERM');
      reject(new Error(`pdftoppm timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      reject(err);
    });
    child.on('close', async (code, signal) => {
      if (settled) return;
      cleanupTimers();
      try {
        await pollProgress();
      } catch {}
      settled = true;
      if (code === 0) {
        resolve();
        return;
      }
      const detail = output.join('').trim();
      reject(new Error(`pdftoppm exited with ${signal || `code ${code}`}${detail ? `: ${detail}` : ''}`));
    });
  });
}

async function renderRasterizedOutputs(outputFiles, dbJobId, prefix, { reportProgressUpdates = true } = {}) {
  const pageCount = outputFiles.length;
  if (reportProgressUpdates) {
    await reportProgress(dbJobId, pageCount, 0);
  }
  let completed = 0;

  const pages = await processWithConcurrency(
    outputFiles.map((srcPath, index) => ({
      srcPath,
      pageNumber: index + 1
    })),
    PAGE_PROCESSING_CONCURRENCY,
    async ({ srcPath, pageNumber }) => {
      const sourceBuffer = fs.readFileSync(srcPath);
      try { fs.unlinkSync(srcPath); } catch {}

      const page = await buildPageAssetsFromBuffer(sourceBuffer, pageNumber, prefix);
      completed += 1;
      if (reportProgressUpdates) {
        await reportProgress(dbJobId, pageCount, completed);
      }
      return page;
    }
  );

  if (!reportProgressUpdates && pageCount > 0) {
    await reportProgress(dbJobId, pageCount, pageCount);
  }

  return pages.sort((a, b) => a.pageNumber - b.pageNumber);
}

async function renderWithPdftoppm(pdfBuffer, dbJobId) {
  // Write PDF to a temp file for pdftoppm
  const pdfTmpName = `pdftoppm_${Date.now()}.pdf`;
  storage.writeTempFile(pdfTmpName, pdfBuffer);
  const pdfPath = storage.getTempFilePath(pdfTmpName);

  const prefix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const outDir = path.dirname(pdfPath);
  const outPrefix = path.join(outDir, prefix);

  try {
    const extractedPages = await extractEmbeddedPageImages(pdfPath, dbJobId, prefix);
    if (extractedPages && extractedPages.length > 0) {
      return extractedPages;
    }

    const pageCount = getPdfPageCount(pdfPath);
    if (pageCount) {
      await reportProgress(dbJobId, pageCount, 0);
    }

    // Render all pages at 200 DPI as PNG
    // Ephemeral machines get 180 min; local fork gets 30 min
    const timeoutMs = isStandalone ? 180 * 60 * 1000 : 30 * 60 * 1000;
    await runPdftoppmWithProgress({
      pdfPath,
      outPrefix,
      outDir,
      prefix,
      dbJobId,
      pageCount,
      timeoutMs
    });

    const outputFiles = collectGeneratedPngs(outDir, prefix);

    return renderRasterizedOutputs(outputFiles, dbJobId, prefix, { reportProgressUpdates: false });
  } finally {
    try { fs.unlinkSync(pdfPath); } catch {}
  }
}

async function renderWithPdfjs(pdfBuffer, dbJobId) {
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const { createCanvas } = require('canvas');

  // Defense-in-depth: pdfjs-dist 3.11.174 is vulnerable to malicious-PDF JS
  // execution (GHSA-wgrm-67xf-hhpq). Disabling eval, font-face, and system
  // fonts neutralises the documented exploitation path even before the
  // upgrade in Phase 4 lands. Production also requires pdftoppm (Phase 2),
  // so this fallback should only ever fire in dev.
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false
  }).promise;

  await reportProgress(dbJobId, pdf.numPages, 0);

  const prefix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const pages = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = createCanvas(viewport.width, viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    page.cleanup();

    pages.push(await buildPageAssetsFromBuffer(canvas.toBuffer('image/png'), i, prefix));

    if (i % 10 === 0 || i === pdf.numPages) {
      await reportProgress(dbJobId, pdf.numPages, i);
    }
  }

  pdf.destroy();
  return pages;
}

// ── Render entry point ──────────────────────────────────────────────────

async function renderPdf(pdfBuffer, dbJobId) {
  const usePdftoppm = hasPdftoppm();
  console.log(`PDF worker: using ${usePdftoppm ? 'pdftoppm' : 'pdfjs-dist'} renderer`);

  return usePdftoppm
    ? renderWithPdftoppm(pdfBuffer, dbJobId)
    : renderWithPdfjs(pdfBuffer, dbJobId);
}

// ── Standalone mode (ephemeral Fly machine) ─────────────────────────────

async function runStandalone() {
  const jobId = parseInt(process.env.IMPORT_JOB_ID, 10);
  if (!jobId) {
    console.error('IMPORT_JOB_ID not set');
    process.exit(1);
  }

  console.log(`[standalone] Starting PDF worker for import job ${jobId}`);

  // Initialize database connection. Skip stale-job recovery: this standalone
  // process only owns its single render job, and the main app's recovery
  // sweep racing other workers' in-flight jobs (e.g. grouping submissions
  // with batch_remote_id still NULL) marks them failed mid-flight. See
  // docs/background-jobs.md § Graceful Shutdown and Stale Job Recovery.
  const { initializeSchema, importJobsAsync } = require('../database/db');
  await initializeSchema({ runStaleJobRecovery: false });
  _importJobsAsync = importJobsAsync;

  const job = await importJobsAsync.getById(jobId);
  if (!job) {
    console.error(`[standalone] Import job ${jobId} not found`);
    process.exit(1);
  }

  const s3TempKey = job.file_path; // e.g. "import_42.pdf"
  const heartbeatInterval = setInterval(() => {
    importJobsAsync.updateHeartbeat(jobId).catch(() => {});
  }, 30000);

  try {
    await importJobsAsync.updateHeartbeat(jobId);
    // Read PDF from S3
    console.log(`[standalone] Reading PDF from S3: temp/${s3TempKey}`);
    const pdfBuffer = await storage.getTempObject(s3TempKey);

    // Render pages
    const pages = await renderPdf(pdfBuffer, jobId);

    // Mark done
    await importJobsAsync.markDone(jobId, pages);
    console.log(`[standalone] Import job ${jobId} complete: ${pages.length} pages`);

    // Clean up the source PDF from S3
    try { await storage.deleteTempObject(s3TempKey); } catch (e) {}

    clearInterval(heartbeatInterval);
    process.exit(0);
  } catch (err) {
    console.error(`[standalone] Import job ${jobId} failed:`, err);
    try {
      await importJobsAsync.markFailed(jobId, err.message);
    } catch (dbErr) {
      console.error('[standalone] Failed to update job status:', dbErr);
    }
    // Clean up source PDF
    try { await storage.deleteTempObject(s3TempKey); } catch (e) {}
    clearInterval(heartbeatInterval);
    process.exit(1);
  }
}

// ── IPC mode (forked by web server) ─────────────────────────────────────

if (isStandalone && require.main === module) {
  runStandalone();
} else if (require.main === module) {
  process.on('message', async (msg) => {
    const result = await processIpcJob(msg);
    process.exit(result.ok ? 0 : 1);
  });
}

async function processIpcJob(msg, options = {}) {
  const { pdfTempFile, dbJobId, originalName } = msg;
  const renderPdfImpl = typeof options.renderPdfImpl === 'function' ? options.renderPdfImpl : renderPdf;
  const reportDoneImpl = typeof options.reportDoneImpl === 'function' ? options.reportDoneImpl : reportDone;
  const reportFailedImpl = typeof options.reportFailedImpl === 'function' ? options.reportFailedImpl : reportFailed;
  const deleteTempAssetsImpl = typeof options.deleteTempAssetsImpl === 'function' ? options.deleteTempAssetsImpl : deleteTempAssets;

  try {
    const pdfBuffer = await readTempAsset(pdfTempFile);
    const pages = await renderPdfImpl(pdfBuffer, dbJobId);

    await reportDoneImpl(dbJobId, pages, originalName);
    await deleteTempAssetsImpl([pdfTempFile]);
    return { ok: true, pages };
  } catch (err) {
    console.error('PDF worker error:', err);
    await reportFailedImpl(dbJobId, err.message);
    await deleteTempAssetsImpl([pdfTempFile]);
    return { ok: false, error: err };
  }
}

module.exports = {
  __testables: {
    processIpcJob,
    renderWithPdfjs,
    runPdfimagesWithProgress,
    collectGeneratedPngs,
    compareNumericFilename
  }
};
