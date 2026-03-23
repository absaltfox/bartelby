// PDF page rendering worker.
// Two modes:
//   1. IPC mode: forked by the web server, communicates via process.send()
//   2. Standalone mode: runs on an ephemeral Fly machine, reads/writes S3 + Turso directly
//
// Uses pdftoppm (poppler-utils) when available, falls back to pdfjs-dist + canvas.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const storage = require('./storage');

const isStandalone = process.env.PDF_WORKER_MODE === '1';

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

async function storePage(filename, pngBuffer) {
  if (isStandalone) {
    // Upload to S3 so the web server can serve previews
    await storage.putTempObject(filename, pngBuffer);
  } else {
    // Write to local temp dir (web server can read directly)
    storage.writeTempFile(filename, pngBuffer);
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

async function renderWithPdftoppm(pdfBuffer, dbJobId) {
  // Write PDF to a temp file for pdftoppm
  const pdfTmpName = `pdftoppm_${Date.now()}.pdf`;
  storage.writeTempFile(pdfTmpName, pdfBuffer);
  const pdfPath = storage.getTempFilePath(pdfTmpName);

  const prefix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const outDir = path.dirname(pdfPath);
  const outPrefix = path.join(outDir, prefix);

  try {
    // Render all pages at 200 DPI as PNG
    // Ephemeral machines get 180 min; local fork gets 30 min
    const timeoutMs = isStandalone ? 180 * 60 * 1000 : 30 * 60 * 1000;
    execFileSync('pdftoppm', ['-png', '-r', '200', pdfPath, outPrefix], {
      stdio: 'pipe',
      maxBuffer: 50 * 1024 * 1024,
      timeout: timeoutMs
    });
  } finally {
    try { fs.unlinkSync(pdfPath); } catch {}
  }

  // Collect output files (pdftoppm names them prefix-01.png, prefix-02.png, etc.)
  const outputFiles = fs.readdirSync(outDir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.png'))
    .sort();

  const pageCount = outputFiles.length;
  await reportProgress(dbJobId, pageCount, 0);

  const pages = [];
  for (let i = 0; i < outputFiles.length; i++) {
    const srcPath = path.join(outDir, outputFiles[i]);
    const filename = `${prefix}_page${i + 1}.png`;
    const pngBuffer = fs.readFileSync(srcPath);
    fs.unlinkSync(srcPath);

    await storePage(filename, pngBuffer);
    pages.push({
      pageNumber: i + 1,
      filename,
      previewUrl: storage.getTempPreviewUrl(filename)
    });

    if ((i + 1) % 10 === 0 || i + 1 === pageCount) {
      await reportProgress(dbJobId, pageCount, i + 1);
    }
  }

  return pages;
}

async function renderWithPdfjs(pdfBuffer, dbJobId) {
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const { createCanvas } = require('canvas');

  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer)
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

    const filename = `${prefix}_page${i}.png`;
    await storePage(filename, canvas.toBuffer('image/png'));
    pages.push({
      pageNumber: i,
      filename,
      previewUrl: storage.getTempPreviewUrl(filename)
    });

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

  // Initialize database connection
  const { initializeSchema, importJobsAsync } = require('../database/db');
  await initializeSchema();
  _importJobsAsync = importJobsAsync;

  const job = await importJobsAsync.getById(jobId);
  if (!job) {
    console.error(`[standalone] Import job ${jobId} not found`);
    process.exit(1);
  }

  const s3TempKey = job.file_path; // e.g. "import_42.pdf"

  try {
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
    process.exit(1);
  }
}

// ── IPC mode (forked by web server) ─────────────────────────────────────

if (isStandalone) {
  runStandalone();
} else {
  process.on('message', async (msg) => {
    const { pdfTempFile, dbJobId, originalName } = msg;

    try {
      const pdfBuffer = storage.readTempFile(pdfTempFile);
      try { storage.deleteTempFile(pdfTempFile); } catch (e) {}

      const pages = await renderPdf(pdfBuffer, dbJobId);

      await reportDone(dbJobId, pages, originalName);
      process.exit(0);
    } catch (err) {
      console.error('PDF worker error:', err);
      await reportFailed(dbJobId, err.message);
      try { storage.deleteTempFile(pdfTempFile); } catch (e) {}
      process.exit(1);
    }
  });
}
