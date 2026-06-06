#!/usr/bin/env node
'use strict';

/**
 * A1.1 diagnostic: load the embedding model the authority suggestion pipeline
 * uses and run a one-shot embed. Exits 0 on success, 1 on failure with the
 * full error printed. Intended to be run manually before deciding whether
 * the historical Protobuf parsing failure is a one-time cache issue or a
 * persistent native-binding / version problem.
 *
 * Citation: docs/reviews/2026-05-31-entity-extraction-historian-lens.md A1.1.
 */

async function main() {
  const startedAt = Date.now();
  console.log('[onnx-diagnostic] Loading @huggingface/transformers...');
  const { pipeline } = require('@huggingface/transformers');

  console.log('[onnx-diagnostic] Building pipeline (Xenova/all-MiniLM-L6-v2, q8)...');
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    dtype: 'q8'
  });

  console.log('[onnx-diagnostic] Running test embed...');
  const tensor = await embedder(['John Jessop'], { pooling: 'mean', normalize: true });
  const rows = typeof tensor.tolist === 'function'
    ? tensor.tolist()
    : Array.from(tensor).map((r) => Array.from(r.data || r));

  const dim = rows[0]?.length;
  const sample = rows[0]?.slice(0, 4);
  console.log(`[onnx-diagnostic] OK. Embedding dim=${dim}, first 4 values=[${sample?.join(', ')}]`);
  console.log(`[onnx-diagnostic] Elapsed: ${Date.now() - startedAt}ms`);
}

main().catch((err) => {
  console.error('[onnx-diagnostic] FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
