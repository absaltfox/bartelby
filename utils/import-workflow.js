'use strict';

const path = require('path');
const { fork } = require('child_process');
const { mimeTypeFromFilename } = require('./mime-types');
const { sanitizeTempFiles } = require('./temp-assets');

function getTempImageContentType(filename) {
  return mimeTypeFromFilename(filename, 'image/png');
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
          confidence: normalizeGroupingConfidence(group.confidence),
          pages: Array.isArray(group.pages) ? sanitizeTempFiles(group.pages) : []
        }))
        .filter((group) => group.pages.length >= 2)
    };
  } catch (err) {
    return null;
  }
}

function normalizeGroupingConfidence(value) {
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  return null;
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

async function getImportableCollectionIds(req, opts = {}) {
  if (!req?.user?.id) return [];
  const preloadedAll = normalizeCollectionIds(opts.allCollectionIds);
  const { userCollectionAccessAsync, collectionsAsync } = require('../database/db');

  // Admins can import into all collections by role.
  if (req.user.role === 'admin') {
    if (preloadedAll.length > 0) return preloadedAll;
    const allCollections = await collectionsAsync.getAll();
    return normalizeCollectionIds(allCollections.map((collection) => collection.id));
  }

  // Collection-level manager access is the canonical import permission.
  const managerIds = normalizeCollectionIds(
    req.managedCollectionIds || await userCollectionAccessAsync.getManagerCollectionIds(req.user.id)
  );

  // Users with global access can import to any collection.
  if (req.user.access_all) {
    if (preloadedAll.length > 0) return preloadedAll;
    const allCollections = await collectionsAsync.getAll();
    return normalizeCollectionIds(allCollections.map((collection) => collection.id));
  }

  return managerIds;
}

async function getAuthorizedCollectionIds(req, collectionIds) {
  const normalized = normalizeCollectionIds(collectionIds);
  if (normalized.length === 0) return [];
  const importableIds = await getImportableCollectionIds(req);
  if (!normalized.every((id) => importableIds.includes(id))) {
    const err = new Error('You do not have permission to import into one or more selected collections.');
    err.statusCode = 403;
    throw err;
  }

  return normalized;
}

function spawnLocalPdfWorker({ pdfTempFile, jobRef, originalName, onProgress, onDone, onFailed }) {
  const child = fork(path.join(__dirname, 'pdf-worker.js'), [], {
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

  function hasUpcomingPlausibleNumber(startCursor, expectedNumber) {
    return hasUpcomingExpectedNumber(startCursor, expectedNumber)
      || hasUpcomingExpectedNumber(startCursor, expectedNumber + 1);
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
    let unreadableGapPending = false;
    let unreadableGapCount = 0;
    let numberingRecoveryCount = 0;
    let repeatedNumberCount = 0;

    while (cursor < tempFiles.length) {
      const detectedNumber = annotationMap.get(cursor + 1);

      if (detectedNumber === expectedNumber) {
        pages.push(cursor);
        explicitMatches += 1;
        expectedNumber += 1;
        cursor += 1;
        unreadableGapPending = false;
        continue;
      }

      if (
        unreadableGapPending &&
        detectedNumber === expectedNumber + 1
      ) {
        pages.push(cursor);
        explicitMatches += 1;
        expectedNumber = detectedNumber + 1;
        cursor += 1;
        unreadableGapPending = false;
        numberingRecoveryCount += 1;
        continue;
      }

      if (
        explicitMatches >= 2 &&
        detectedNumber === expectedNumber - 1 &&
        hasUpcomingExpectedNumber(cursor + 1, expectedNumber)
      ) {
        pages.push(cursor);
        cursor += 1;
        repeatedNumberCount += 1;
        continue;
      }

      if (
        detectedNumber == null &&
        explicitMatches >= 2 &&
        hasUpcomingPlausibleNumber(cursor + 1, expectedNumber)
      ) {
        pages.push(cursor);
        cursor += 1;
        unreadableGapPending = true;
        unreadableGapCount += 1;
        continue;
      }

      break;
    }

    if (explicitMatches >= 2) {
      const anomalyCount = unreadableGapCount + numberingRecoveryCount + repeatedNumberCount;
      let confidence = 'low';
      if (anomalyCount === 0 && explicitMatches >= 3) {
        confidence = 'high';
      } else if (anomalyCount <= 1) {
        confidence = 'medium';
      }

      groups.push({
        pageIndices: pages,
        label: `Document (pages ${pages.map((page) => page + 1).join(', ')})`,
        confidence
      });
      index = cursor;
      continue;
    }

    index += 1;
  }

  return groups;
}

module.exports = {
  getTempImageContentType,
  parseGroupingState,
  buildTranscriptPageSegments,
  getImportableCollectionIds,
  getAuthorizedCollectionIds,
  spawnLocalPdfWorker,
  stripPageMarkers,
  buildGroupsFromAnnotations
};
