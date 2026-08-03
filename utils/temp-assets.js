'use strict';

const config = require('../config');
const storage = require('./storage');

function normalizeTempAssets(files) {
  return (files || [])
    .map((file) => {
      if (typeof file === 'string') {
        const filename = storage.sanitizeTempName(file);
        return filename ? { filename, previewFilename: null } : null;
      }

      if (!file || typeof file !== 'object') return null;

      const filename = storage.sanitizeTempName(file.filename || file.tempFile || file.name || file.file);
      if (!filename) return null;

      const previewFilename = storage.sanitizeTempName(
        file.previewFilename || file.previewFileName || file.preview_file || ''
      );

      return {
        filename,
        previewFilename: previewFilename || null
      };
    })
    .filter(Boolean);
}

function sanitizeTempFiles(files) {
  return normalizeTempAssets(files).map((asset) => asset.filename);
}

function sanitizeTempPreviewFiles(files) {
  return normalizeTempAssets(files)
    .map((asset) => asset.previewFilename)
    .filter(Boolean);
}

function collectTempCleanupFiles(tempFiles, previewMap = new Map()) {
  const files = new Set();
  for (const asset of normalizeTempAssets(tempFiles)) {
    if (asset.filename) files.add(asset.filename);
    if (asset.previewFilename) files.add(asset.previewFilename);
    const mappedPreview = previewMap.get(asset.filename);
    if (mappedPreview) files.add(mappedPreview);
  }
  return [...files];
}

function attachTempPreview(page) {
  const { previewUrl: _previewUrl, ...rest } = page || {};
  return rest;
}

// ── Temp-asset ownership ────────────────────────────────────────────────────
//
// The temp-asset endpoints under /admin/api and /manage/api used to authorize
// by possession of a filename: anyone who could name a file could read it,
// copy it into a document of their own, or delete it. /manage/api is reachable
// by any manager of any single collection, so that was a cross-tenant gap
// bounded only by filename entropy — and PDF page names were derived from
// Math.random (#93), so that bound was weak.
//
// There is no ownership column on temp files, and adding one would mean a
// registry to keep in step with S3, the local temp dir and the PDF worker.
// Instead we lean on the fact that there are exactly three ways to legitimately
// learn a temp filename, and all three are already authorized:
//
//   1. the response to POST /api/upload (the caller uploaded it),
//   2. GET /api/import-job/:id (ownership-checked),
//   3. the import page's resume render (ownership-checked, admin-only on /admin).
//
// Each records what it disclosed onto the session, and every consumer asserts
// against that. A caller who never legitimately obtained a name cannot use it,
// whatever the entropy of the name itself.
//
// Direct image uploads are held as filenames; PDF page sets are held as job ids
// and resolved on demand, so a 600-page import costs one integer rather than
// 1,200 strings of session state.

const OWNED_ASSET_CAP = 500;
const OWNED_JOB_CAP = 50;

function sessionList(req, key, cap) {
  if (!req || !req.session) return null;
  if (!Array.isArray(req.session[key])) req.session[key] = [];
  const list = req.session[key];
  if (list.length > cap) list.splice(0, list.length - cap);
  return list;
}

/** Records temp filenames this request just disclosed to the caller. */
function rememberTempAssets(req, names) {
  const list = sessionList(req, 'ownedTempAssets', OWNED_ASSET_CAP);
  if (!list) return;
  for (const name of sanitizeTempFiles(Array.isArray(names) ? names : [names])) {
    if (!list.includes(name)) list.push(name);
  }
  if (list.length > OWNED_ASSET_CAP) list.splice(0, list.length - OWNED_ASSET_CAP);
}

/** Records an import job whose page assets this caller is authorized to use. */
function rememberImportJob(req, importJobId) {
  const id = parseInt(importJobId, 10);
  if (!Number.isInteger(id)) return;
  const list = sessionList(req, 'ownedImportJobs', OWNED_JOB_CAP);
  if (!list) return;
  if (!list.includes(id)) list.push(id);
  if (list.length > OWNED_JOB_CAP) list.splice(0, list.length - OWNED_JOB_CAP);
}

/**
 * Every temp filename recorded on an import job's rendered pages.
 *
 * Deliberately reads ONLY `pages`, which the PDF worker writes. It does not
 * read `submit_payload`, and must not: `POST /submit-pages` and
 * `POST /suggest-groups` copy a caller-supplied `tempFiles` array straight into
 * that column, so trusting it would let a caller mint a job of their own naming
 * someone else's files and have the ledger accept them right back. The ledger
 * may only ever be seeded from names the server produced.
 */
async function getImportJobAssetNames(importJobId) {
  const id = parseInt(importJobId, 10);
  if (!Number.isInteger(id)) return new Set();

  const { importJobsAsync } = require('../database/db');
  const job = await importJobsAsync.getById(id);
  if (!job) return new Set();

  const names = new Set();
  const add = (value) => {
    const safe = storage.sanitizeTempName(value);
    if (safe) names.add(safe);
  };

  try {
    for (const page of JSON.parse(job.pages || '[]') || []) {
      add(page && page.filename);
      add(page && (page.previewFilename || page.previewFileName || page.preview_file));
    }
  } catch (err) { /* a malformed pages blob owns nothing */ }

  return names;
}

/** Job asset sets are resolved once per request, not once per name. */
async function jobAssetNamesForRequest(req, jobId) {
  if (!req) return getImportJobAssetNames(jobId);
  if (!req._tempAssetJobNames) req._tempAssetJobNames = new Map();
  const key = Number(jobId);
  if (!req._tempAssetJobNames.has(key)) {
    req._tempAssetJobNames.set(key, await getImportJobAssetNames(key));
  }
  return req._tempAssetJobNames.get(key);
}

/**
 * Throws a 403 unless every temp asset named in `input` was disclosed to this
 * caller. Admins bypass, consistent with the existing per-job ownership checks
 * — they can already read every document the assets would become.
 *
 * Takes the raw request value rather than a filename list, and checks BOTH
 * `filename` and `previewFilename` on object-shaped entries. `sanitizeTempFiles`
 * projects to `filename` alone while `collectTempCleanupFiles` acts on both, so
 * asserting on the projection would have let
 * `{ filename: <mine>, previewFilename: <yours> }` pass the guard and still
 * delete someone else's page.
 */
async function assertTempAssetsOwned(req, input) {
  const raw = Array.isArray(input) ? input : [input];
  const wanted = new Set();
  for (const asset of normalizeTempAssets(raw)) {
    if (asset.filename) wanted.add(asset.filename);
    if (asset.previewFilename) wanted.add(asset.previewFilename);
  }
  if (!wanted.size) return;
  if (req && req.user && req.user.role === 'admin') return;

  const owned = new Set((req && req.session && req.session.ownedTempAssets) || []);
  let missing = [...wanted].filter((name) => !owned.has(name));
  if (!missing.length) return;

  for (const jobId of (req && req.session && req.session.ownedImportJobs) || []) {
    const jobNames = await jobAssetNamesForRequest(req, jobId);
    missing = missing.filter((name) => !jobNames.has(name));
    if (!missing.length) return;
  }

  const err = new Error('You do not have access to one or more of those files.');
  err.statusCode = 403;
  throw err;
}

async function getImportJobPreviewMap(importJobId) {
  if (!Number.isInteger(importJobId)) return new Map();

  const { importJobsAsync } = require('../database/db');
  const job = await importJobsAsync.getById(importJobId);
  if (!job || !job.pages) return new Map();

  try {
    const pages = JSON.parse(job.pages);
    const previewMap = new Map();
    for (const page of pages || []) {
      const filename = storage.sanitizeTempName(page && page.filename);
      const previewFilename = storage.sanitizeTempName(
        page && (page.previewFilename || page.previewFileName || page.preview_file)
      );
      if (filename && previewFilename) {
        previewMap.set(filename, previewFilename);
      }
    }
    return previewMap;
  } catch (err) {
    return new Map();
  }
}

async function tempAssetExists(name) {
  const safeName = storage.sanitizeTempName(name);
  if (!safeName) return false;
  if (typeof storage.tempFileExistsAsync === 'function') {
    return !!(await storage.tempFileExistsAsync(safeName));
  }
  return !!storage.tempFileExists(safeName);
}

async function readTempAsset(name) {
  const safeName = storage.sanitizeTempName(name);
  if (!safeName) {
    throw new Error('Temp file not found.');
  }

  if (typeof storage.readTempFileAsync === 'function') {
    return storage.readTempFileAsync(safeName);
  }

  if (storage.tempFileExists(safeName)) {
    return storage.readTempFile(safeName);
  }

  if (typeof storage.getTempObject === 'function') {
    return storage.getTempObject(safeName);
  }

  throw new Error('Temp file not found.');
}

async function copyTempAssetToUpload(tempName, originalName, extOverride) {
  const safeName = storage.sanitizeTempName(tempName);
  if (!safeName) {
    throw new Error('Invalid temp filename.');
  }

  if (typeof storage.copyTempAssetToUpload === 'function') {
    return storage.copyTempAssetToUpload(safeName, originalName, extOverride);
  }

  return storage.copyTempFileToUpload(safeName, originalName, extOverride);
}

async function promoteQueuedTempAssets(tempNames) {
  const files = sanitizeTempFiles(Array.isArray(tempNames) ? tempNames : [tempNames]);
  if (files.length === 0) {
    const err = new Error('Temporary file not found. Please upload again.');
    err.statusCode = 400;
    throw err;
  }

  for (const file of files) {
    if (!(await tempAssetExists(file))) {
      const err = new Error('Temporary file not found. Please upload again.');
      err.statusCode = 400;
      throw err;
    }

    if (config.storage.driver !== 's3' || typeof storage.putTempObject !== 'function') {
      continue;
    }

    const localExists = typeof storage.tempFileExists === 'function'
      ? storage.tempFileExists(file)
      : false;

    if (!localExists) {
      continue;
    }

    const buffer = typeof storage.readTempFileAsync === 'function'
      ? await storage.readTempFileAsync(file)
      : storage.readTempFile(file);

    await storage.putTempObject(file, buffer);
  }

  return files;
}

async function deleteTempAssets(names) {
  if (!names || names.length === 0) return;

  if (typeof storage.deleteTempAssets === 'function') {
    await storage.deleteTempAssets(names);
    return;
  }

  if (typeof storage.deleteTempFiles === 'function') {
    storage.deleteTempFiles(names);
  }
}

module.exports = {
  normalizeTempAssets,
  sanitizeTempFiles,
  sanitizeTempPreviewFiles,
  collectTempCleanupFiles,
  attachTempPreview,
  rememberTempAssets,
  rememberImportJob,
  getImportJobAssetNames,
  assertTempAssetsOwned,
  getImportJobPreviewMap,
  tempAssetExists,
  readTempAsset,
  copyTempAssetToUpload,
  promoteQueuedTempAssets,
  deleteTempAssets
};
