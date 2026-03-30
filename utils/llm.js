'use strict';

require('./secrets').loadEnv();

const { generateText } = require('ai');
const { createOpenAI } = require('@ai-sdk/openai');
const { createAnthropic } = require('@ai-sdk/anthropic');
const { createOllama } = require('ollama-ai-provider');

const DEFAULT_SYSTEM_PROMPT = `You are an expert in historical document transcription and paleography. \
Transcribe all handwritten and printed text from the document image with high accuracy.

Rules:
- Transcribe ALL visible text verbatim, preserving original spelling, punctuation, and capitalization
- Use [illegible] for text that cannot be read with confidence
- Use [unclear: word?] when a word is uncertain
- Mark struck-through text as ~~text~~
- Mark interlinear additions in {curly braces}

Respond ONLY with a valid JSON object — no markdown fences, no commentary — in this exact shape:
{
  "transcription": "<full verbatim text>",
  "metadata": {
    "title": "<document title or null>",
    "date_created": "<date as written, e.g. March 15 1847, or null>",
    "document_type": "<letter|ledger|deed|diary|legal|receipt|other or null>",
    "author": "<author/signer or null>",
    "location": "<place of origin or null>",
    "condition": "<good|fair|poor or null>"
  },
  "notes": "<observations about illegible sections or difficulties, or null>"
}`;

function getSystemPrompt(cfg = {}) {
  const prompt = cfg.transcription_prompt;
  return (typeof prompt === 'string' && prompt.trim()) ? prompt : DEFAULT_SYSTEM_PROMPT;
}

function buildMessages(imageBuffer, mimeType) {
  return [
    {
      role: 'user',
      content: [
        { type: 'image', image: imageBuffer, mimeType },
        { type: 'text', text: 'Please transcribe this document.' }
      ]
    }
  ];
}

function parseResponse(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    return { transcription: text, metadata: {}, notes: 'Could not parse structured response.' };
  }
  try {
    const parsed = JSON.parse(match[0]);
    return {
      transcription: parsed.transcription || text,
      metadata: parsed.metadata || {},
      notes: parsed.notes || null
    };
  } catch {
    return { transcription: text, metadata: {}, notes: 'JSON parse error.' };
  }
}

// Load config from DB settings, falling back to env vars
async function loadConfig() {
  try {
    const { settingsAsync } = require('../database/db');
    return await settingsAsync.getAll();
  } catch {
    return {};
  }
}

async function mergeConfig(overrides = {}) {
  return { ...(await loadConfig()), ...overrides };
}

async function runTranscription(modelInstance, providerName, modelName, temperature, imageBuffer, mimeType, cfg = {}) {
  const startMs = Date.now();
  const systemPrompt = getSystemPrompt(cfg);
  const { text } = await generateText({
    model: modelInstance,
    system: systemPrompt,
    temperature: temperature != null ? temperature : undefined,
    messages: buildMessages(imageBuffer, mimeType)
  });
  const durationMs = Date.now() - startMs;
  const parsed = parseResponse(text);
  return {
    ...parsed,
    paradata: {
      provider: providerName,
      model: modelName,
      prompt: systemPrompt,
      temperature: temperature != null ? temperature : null,
      run_duration_ms: durationMs
    }
  };
}

const PROVIDERS = {
  openai: {
    name: 'openai',
    async transcribeDocument(imageBuffer, mimeType, opts = {}, runtimeConfig = {}) {
      const cfg = await mergeConfig(runtimeConfig);
      const apiKey = runtimeConfig.apiKey || cfg.openai_api_key || process.env.OPENAI_API_KEY;
      const model = opts.model || runtimeConfig.model || cfg.openai_model || 'gpt-4o';
      const temperature = opts.temperature != null ? opts.temperature : null;
      const client = createOpenAI({ apiKey });
      return runTranscription(client(model), 'openai', model, temperature, imageBuffer, mimeType, cfg);
    }
  },

  claude: {
    name: 'claude',
    async transcribeDocument(imageBuffer, mimeType, opts = {}, runtimeConfig = {}) {
      const cfg = await mergeConfig(runtimeConfig);
      const apiKey = runtimeConfig.apiKey || cfg.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
      const model = opts.model || runtimeConfig.model || cfg.anthropic_model || 'claude-3-5-sonnet-20241022';
      const temperature = opts.temperature != null ? opts.temperature : null;
      const client = createAnthropic({ apiKey });
      return runTranscription(client(model), 'claude', model, temperature, imageBuffer, mimeType, cfg);
    }
  },

  ollama: {
    name: 'ollama',
    async transcribeDocument(imageBuffer, mimeType, opts = {}, runtimeConfig = {}) {
      const cfg = await mergeConfig(runtimeConfig);
      const baseURL = runtimeConfig.baseURL || cfg.ollama_base_url || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
      const model = opts.model || runtimeConfig.model || cfg.ollama_model || 'llava';
      const temperature = opts.temperature != null ? opts.temperature : null;
      const client = createOllama({ baseURL });
      return runTranscription(client(model), 'ollama', model, temperature, imageBuffer, mimeType, cfg);
    }
  },

  lmstudio: {
    name: 'lmstudio',
    async transcribeDocument(imageBuffer, mimeType, opts = {}, runtimeConfig = {}) {
      const cfg = await mergeConfig(runtimeConfig);
      const baseURL = runtimeConfig.baseURL || cfg.lmstudio_base_url || process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1';
      const model = opts.model || runtimeConfig.model || cfg.lmstudio_model || 'local-model';
      const temperature = opts.temperature != null ? opts.temperature : null;
      // LM Studio is OpenAI-compatible; no API key required for local use
      const client = createOpenAI({ baseURL, apiKey: 'lmstudio' });
      return runTranscription(client(model), 'lmstudio', model, temperature, imageBuffer, mimeType, cfg);
    }
  }
};

// Cheapest vision-capable models per provider — used for lightweight tasks
// like detecting archival page numbers on cropped image strips.
const CHEAP_VISION_MODELS = {
  openai: 'gpt-4o-mini',
  claude: 'claude-3-5-haiku-20241022',
  ollama: null,   // use configured model (local, no cost)
  lmstudio: null  // use configured model (local, no cost)
};

// Resolve the vision model name for a provider.
// Priority: runtimeConfig.visionModel (user key) > system setting > hardcoded default.
async function getCheapVisionModelInstance(providerName, runtimeConfig = {}) {
  const cfg = await loadConfig();
  const userVisionModel = runtimeConfig.visionModel || null;

  switch (providerName) {
    case 'openai': {
      const apiKey = runtimeConfig.apiKey || cfg.openai_api_key || process.env.OPENAI_API_KEY;
      const model = userVisionModel || cfg.openai_vision_model || CHEAP_VISION_MODELS.openai;
      return createOpenAI({ apiKey })(model);
    }
    case 'claude': {
      const apiKey = runtimeConfig.apiKey || cfg.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
      const model = userVisionModel || cfg.anthropic_vision_model || CHEAP_VISION_MODELS.claude;
      return createAnthropic({ apiKey })(model);
    }
    case 'ollama': {
      const baseURL = runtimeConfig.baseURL || cfg.ollama_base_url || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
      const model = userVisionModel || cfg.ollama_model || 'llava';
      return createOllama({ baseURL })(model);
    }
    case 'lmstudio': {
      const baseURL = runtimeConfig.baseURL || cfg.lmstudio_base_url || process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1';
      const model = userVisionModel || cfg.lmstudio_model || 'local-model';
      return createOpenAI({ baseURL, apiKey: 'lmstudio' })(model);
    }
    default:
      return null;
  }
}

function providerNeedsApiKey(name) {
  return name === 'openai' || name === 'claude';
}

async function createProvider(name, runtimeConfig = {}) {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Unknown provider: "${name}". Available: ${listProviders().join(', ')}`);
  }
  const cfg = await mergeConfig(runtimeConfig);
  if (name === 'openai' && !runtimeConfig.apiKey && !cfg.openai_api_key && !process.env.OPENAI_API_KEY) {
    throw new Error('OpenAI API key is not configured. Set it in Admin → Settings.');
  }
  if (name === 'claude' && !runtimeConfig.apiKey && !cfg.anthropic_api_key && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API key is not configured. Set it in Admin → Settings.');
  }
  return {
    ...provider,
    transcribeDocument(imageBuffer, mimeType, opts = {}) {
      return provider.transcribeDocument(imageBuffer, mimeType, opts, runtimeConfig);
    },
    async generateGroupingSuggestion(imageContents, startIndex, batchSize) {
      const cheapModel = await getCheapVisionModelInstance(name, runtimeConfig);
      if (!cheapModel) throw new Error('Could not create model instance for grouping suggestion');
      return generateGroupingSuggestion(cheapModel, imageContents, startIndex, batchSize);
    }
  };
}

function listProviders() {
  return Object.keys(PROVIDERS);
}

async function listConfiguredProviders() {
  const cfg = await loadConfig();
  return Object.keys(PROVIDERS).filter(name => {
    if (name === 'openai')   return !!(cfg.openai_api_key    || process.env.OPENAI_API_KEY);
    if (name === 'claude')   return !!(cfg.anthropic_api_key || process.env.ANTHROPIC_API_KEY);
    // ollama and lmstudio are local — always available
    return true;
  });
}

// Create a model instance for text-only calls (title/summary generation)
async function getModelInstance(providerName, runtimeConfig = {}) {
  const cfg = await mergeConfig(runtimeConfig);
  switch (providerName) {
    case 'openai': {
      const apiKey = runtimeConfig.apiKey || cfg.openai_api_key || process.env.OPENAI_API_KEY;
      const model = runtimeConfig.model || cfg.openai_model || 'gpt-4o';
      return createOpenAI({ apiKey })(model);
    }
    case 'claude': {
      const apiKey = runtimeConfig.apiKey || cfg.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
      const model = runtimeConfig.model || cfg.anthropic_model || 'claude-3-5-sonnet-20241022';
      return createAnthropic({ apiKey })(model);
    }
    case 'ollama': {
      const baseURL = runtimeConfig.baseURL || cfg.ollama_base_url || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
      const model = runtimeConfig.model || cfg.ollama_model || 'llava';
      return createOllama({ baseURL })(model);
    }
    case 'lmstudio': {
      const baseURL = runtimeConfig.baseURL || cfg.lmstudio_base_url || process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1';
      const model = runtimeConfig.model || cfg.lmstudio_model || 'local-model';
      return createOpenAI({ baseURL, apiKey: 'lmstudio' })(model);
    }
    default:
      return null;
  }
}

const GROUPING_PROMPT = `You are an expert at reading archival documents. You are examining scanned pages from a batch of historical documents.

For each image, look for any handwritten or stamped page number or folio number, typically found at the top-right, top-center, or top-left corner of the page. These are archival page numbers added by a clerk or archivist — NOT printed page numbers from a book.

Look for:
- Handwritten numbers like "1", "2", "3" at the top of pages
- Stamped sequential numbers
- Folio markings like "f.1", "f.2"
- Page markings like "p.1", "p.2" or "pg 1", "pg 2"

Respond ONLY with a valid JSON array — no markdown fences, no commentary — in this format:
[
  { "page": 1, "number": 1 },
  { "page": 2, "number": 2 },
  { "page": 3, "number": null },
  { "page": 4, "number": 1 }
]

Where "page" is the image number (starting from the offset I give you) and "number" is the archival page number you detected (as an integer), or null if no page number is visible.`;

async function generateGroupingSuggestion(modelInstance, imageContents, startIndex, batchSize) {
  const { text } = await generateText({
    model: modelInstance,
    system: GROUPING_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          ...imageContents,
          { type: 'text', text: `These are images ${startIndex + 1} through ${startIndex + batchSize}. For each image, detect any archival page number. Return a JSON array.` }
        ]
      }
    ],
    temperature: 0.1
  });

  // Parse JSON array from response
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    return arr.map(item => ({
      page: item.page,
      number: item.number != null ? parseInt(item.number, 10) || null : null
    }));
  } catch {
    return [];
  }
}

const TITLE_PROMPT = `You generate short, descriptive titles for historical documents based on their transcribed content.
The title should describe what the document is about — its subject matter and key details.
Do NOT just name the document type and date (e.g. "Letter dated January 1872").
Instead, capture the substance (e.g. "Request for Military Pension Disbursement" or "Sale of Land on Elm Street to J. Harper").
Respond with ONLY the title — no quotes, no explanation, no trailing punctuation.`;

async function generateDocumentTitle(providerName, transcription, runtimeConfig = {}) {
  const modelInstance = await getModelInstance(providerName, runtimeConfig);
  if (!modelInstance) return null;

  const excerpt = transcription.substring(0, 3000);
  const { text } = await generateText({
    model: modelInstance,
    system: TITLE_PROMPT,
    prompt: `Generate a short descriptive title (5-10 words) for this document:\n\n${excerpt}`,
    temperature: 0.3
  });

  let title = text.trim().replace(/^["']+|["']+$/g, '').replace(/[.!]+$/, '').trim();
  if (!title || title.length > 120) return null;
  return title;
}

const SUMMARY_PROMPT = `You summarize historical documents in 1-2 concise sentences based on their transcribed content.
The summary should capture the key subject matter, people involved, and purpose of the document.
Write in a neutral, informative tone suitable for a library catalog entry.
Respond with ONLY the summary — no quotes, no labels, no preamble.`;

async function generateDocumentSummary(providerName, transcription, runtimeConfig = {}) {
  const modelInstance = await getModelInstance(providerName, runtimeConfig);
  if (!modelInstance) return null;

  const excerpt = transcription.substring(0, 3000);
  const { text } = await generateText({
    model: modelInstance,
    system: SUMMARY_PROMPT,
    prompt: `Summarize this historical document in 1-2 sentences:\n\n${excerpt}`,
    temperature: 0.3
  });

  let summary = text.trim().replace(/^["']+|["']+$/g, '').trim();
  if (!summary || summary.length > 500) return null;
  return summary;
}

module.exports = {
  createProvider,
  listProviders,
  listConfiguredProviders,
  providerNeedsApiKey,
  generateDocumentTitle,
  generateDocumentSummary
};
