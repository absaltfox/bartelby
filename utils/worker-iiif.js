'use strict';

const config = require('../config');
const { isTransientError, sleep } = require('./worker-runtime');
const { describeError } = require('./error-detail');
const { parseManifest } = require('./iiif/parser');
const { fetchIiifJson } = require('./iiif/client');
const ubcOc = require('./iiif/sources/ubc-oc');

// Registry of source adapters, keyed by iiif_sources.source_type. Each adapter
// exposes enumerateManifestRefs + UBC-shaped image/full-text helpers behind a
// stable seam so this cycle stays source-agnostic (plan: source-adapter seam).
const DEFAULT_ADAPTERS = { ubc_oc: ubcOc };

const HEARTBEAT_INTERVAL_MS = 20000;

// One claim-and-crawl cycle for the IIIF sync worker (modeled on
// utils/worker-extraction.js runExtractionWorkerCycle). Claims one queued
// iiif_source, enumerates its manifests, and creates one PURE-REFERENCE
// document per not-yet-imported manifest: image URLs point at the remote IIIF
// Image API (never downloaded), canvases become pages, and UBC FullText — when
// present — is written as the is_best transcript. It does NOT enqueue LLM
// transcription; that is the separate admin-triggered batch button
// (docs/background-jobs.md, plan "Locked decision 2026-07-15b"). The ledger
// (iiif_imported_manifests) makes a re-sync create zero duplicates.
//
// `deps` are injectable for testing: { db, fetchJson, adapters, adapterDeps }.
async function runIiifSyncCycle(deps = {}) {
  const {
    iiifSourcesAsync,
    documentsAsync,
    documentCollectionsAsync,
    transcriptsAsync
  } = deps.db || require('../database/db');

  const fetchJson = deps.fetchJson || fetchIiifJson;
  const adapters = deps.adapters || DEFAULT_ADAPTERS;
  const adapterDeps = deps.adapterDeps || {};

  let source = null;
  try {
    source = await iiifSourcesAsync.claimNextQueued();
    if (!source) return;

    const log = (line) => iiifSourcesAsync.appendLog(source.id, line);
    await log(`Starting IIIF sync (source ${source.id}, ${source.source_type}, collection ${source.collection_id})`);

    const adapter = adapters[source.source_type];
    if (!adapter) throw new Error(`Unknown IIIF source_type: ${source.source_type}`);

    const size = source.image_size || config.iiif.transcriptionImageSize;
    let imported = source.manifests_imported || 0;
    let seen = 0; // manifests encountered this crawl → manifests_total (denominator)
    let lastHeartbeat = Date.now();

    for await (const ref of adapter.enumerateManifestRefs(source, adapterDeps)) {
      seen += 1;
      if (Date.now() - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
        await iiifSourcesAsync.updateHeartbeat(source.id);
        lastHeartbeat = Date.now();
      }

      // Ledger gate keyed on the (deterministic) manifest URL, which is known
      // BEFORE the manifest fetch — so an already-imported item costs no fetch.
      if (await iiifSourcesAsync.manifestImported(source.id, ref.manifestUrl)) continue;

      // Fetch the manifest only for canvas count + label/rights metadata. UBC's
      // declared per-canvas image services are broken, so image URLs are DERIVED
      // via the adapter (buildItemImageUrl), not read from the manifest.
      const manifestDoc = await fetchJson(ref.manifestUrl, { timeoutMs: config.iiif.requestTimeoutMs });
      const manifest = parseManifest(manifestDoc);
      const canvasCount = Math.max(manifest.canvases.length, 1);

      const imageUrls = [];
      for (let i = 0; i < canvasCount; i++) {
        imageUrls.push(adapter.buildItemImageUrl(source.collection_identifier, ref.itemId, i, size));
      }

      // FullText: prefer what the adapter surfaced during enumeration; otherwise
      // fetch the item-detail endpoint (UBC keeps FullText there, not in the list).
      let fullText = ref.fullText ? adapter.cleanFullText(ref.fullText) : null;
      if (!fullText && typeof adapter.fetchItemFullText === 'function') {
        try {
          fullText = await adapter.fetchItemFullText(source, ref.itemId, adapterDeps);
        } catch (detailErr) {
          if (isTransientError(detailErr)) throw detailErr; // let the cycle requeue
          await log(`FullText fetch failed for ${ref.itemId} (non-fatal): ${detailErr.message}`);
        }
      }

      const imageServiceBase = typeof adapter.buildItemImageServiceBase === 'function'
        ? adapter.buildItemImageServiceBase(source.collection_identifier, ref.itemId, 0)
        : null;

      const metadata = {
        document_type: 'letter',
        iiif_manifest_id: manifest.id || ref.manifestUrl,
        iiif_manifest_url: ref.manifestUrl,
        iiif_source_id: source.id,
        iiif_source_type: source.source_type,
        iiif_collection_identifier: source.collection_identifier,
        iiif_item_id: ref.itemId,
        iiif_image_service: imageServiceBase,
        // UBC (and many DC-based sources) expose the formal rights statement in
        // metadata[] under a "Rights" label, not the top-level v2 license/rights
        // field — fall back to it. The human-readable permission line is the
        // top-level `attribution`.
        iiif_rights: manifest.rights
          || (manifest.metadata && (manifest.metadata.Rights || manifest.metadata['Rights URI']))
          || null,
        iiif_attribution: manifest.attribution || null,
        iiif_canvas_count: canvasCount
      };
      if (imageUrls.length > 1) {
        metadata.additional_pages = imageUrls.slice(1);
      }

      const title = ref.title || manifest.label || `IIIF item ${ref.itemId}`;
      const docId = await documentsAsync.create({
        title,
        date_created: null,
        description: manifest.description || null,
        image_path: imageUrls[0],
        metadata
      });
      await documentCollectionsAsync.add(docId, source.collection_id);

      if (fullText) {
        await transcriptsAsync.create({
          document_id: docId,
          content: fullText,
          transcriber: 'UBC Open Collections FullText',
          is_best: 1,
          notes: 'Imported human transcription (UBC Open Collections FullText)'
        });
      }

      await iiifSourcesAsync.recordImportedManifest(source.id, ref.manifestUrl, docId);
      imported += 1;
      await iiifSourcesAsync.updateProgress(source.id, {
        manifests_imported: imported,
        manifests_total: seen,
        cursor: ref.offset != null ? String(ref.offset) : undefined
      });
      await log(`Imported ${ref.itemId} → document ${docId} (${canvasCount} page(s)${fullText ? ', +FullText' : ''})`);

      if (config.iiif.crawlDelayMs) await sleep(config.iiif.crawlDelayMs);
    }

    // Record the total seen even when this run imported nothing new (a re-sync
    // that skips everything via the ledger), so the UI denominator is correct.
    await iiifSourcesAsync.updateProgress(source.id, { manifests_total: seen });
    await iiifSourcesAsync.markDone(source.id);
    await log(`IIIF sync complete: ${imported} of ${seen} manifest(s) imported`);
  } catch (err) {
    if (!source) {
      console.error('[worker-iiif] cycle error before claim:', describeError(err));
      return;
    }
    // Transient (5xx/timeout/429) → requeue and resume from cursor next tick.
    // Permanent → fail (admin re-triggers a resync; no auto-retry per project
    // rule). The ledger keeps either path idempotent.
    if (isTransientError(err)) {
      await iiifSourcesAsync.appendLog(source.id, `Transient error, requeued: ${err.message}`);
      await iiifSourcesAsync.requeueForRetry(source.id, err.message);
    } else {
      await iiifSourcesAsync.appendLog(source.id, `Fatal error: ${err.message}`);
      await iiifSourcesAsync.markFailed(source.id, err.message);
    }
  }
}

module.exports = { runIiifSyncCycle };
