'use strict';

const EMBED_CHUNK_SIZE = 64;
const EMBED_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

let embedderPromise = null;

async function getEmbedder() {
  if (embedderPromise) return embedderPromise;
  embedderPromise = (async () => {
    const { pipeline } = require('@huggingface/transformers');
    return pipeline('feature-extraction', EMBED_MODEL_ID, { dtype: 'q8' });
  })();
  return embedderPromise;
}

async function embedTexts(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const embedder = await getEmbedder();
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_CHUNK_SIZE) {
    const chunk = texts.slice(i, i + EMBED_CHUNK_SIZE);
    const tensor = await embedder(chunk, { pooling: 'mean', normalize: true });
    const rows = typeof tensor.tolist === 'function'
      ? tensor.tolist()
      : Array.from(tensor).map((r) => Array.from(r.data || r));
    for (const row of rows) out.push(row);
  }
  return out;
}

module.exports = { embedTexts, EMBED_MODEL_ID };
