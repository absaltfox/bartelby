'use strict';

require('./secrets').loadEnv();

const { generateText } = require('ai');
const { createOpenAI } = require('@ai-sdk/openai');
const { createAnthropic } = require('@ai-sdk/anthropic');
const { createGoogleGenerativeAI } = require('@ai-sdk/google');
const { createOllama } = require('ollama-ai-provider');

// ── SSRF guard ─────────────────────────────────────────────────────────────
// Blocked IP ranges and hostnames that must never be used as LLM provider URLs.
const BLOCKED_HOSTS = [
  '169.254.169.254',  // AWS / Azure / GCP instance metadata
  '100.100.100.200',  // Alibaba Cloud metadata
  'metadata.google.internal',
  'metadata.goog',
];

function validateLlmBaseUrl(raw, providerLabel) {
  if (!raw || typeof raw !== 'string') return;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid base URL for ${providerLabel}: "${raw}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${providerLabel} base URL must use http or https.`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.includes(hostname)) {
    throw new Error(`${providerLabel} base URL points to a blocked host.`);
  }
  // Block link-local (169.254.x.x) and loopback-adjacent ranges used by cloud metadata
  if (/^169\.254\.\d+\.\d+$/.test(hostname)) {
    throw new Error(`${providerLabel} base URL points to a blocked address range.`);
  }
}

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
  "notes": "<observations about illegible sections or difficulties, or null>",
  "confidence": <integer 0-100 reflecting overall transcription confidence: 100 = fully legible, 0 = almost entirely illegible>
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
    return { transcription: text, metadata: {}, notes: 'Could not parse structured response.', confidence: null };
  }
  try {
    const parsed = JSON.parse(match[0]);
    const rawConfidence = parsed.confidence;
    const confidence = (typeof rawConfidence === 'number' && rawConfidence >= 0 && rawConfidence <= 100)
      ? Math.round(rawConfidence)
      : null;
    return {
      transcription: parsed.transcription || text,
      metadata: parsed.metadata || {},
      notes: parsed.notes || null,
      confidence
    };
  } catch {
    return { transcription: text, metadata: {}, notes: 'JSON parse error.', confidence: null };
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

async function getTranscriptionSystemPrompt(runtimeConfig = {}) {
  const cfg = await mergeConfig(runtimeConfig);
  return getSystemPrompt(cfg);
}

async function resolveTranscriptionRuntime(providerName, runtimeConfig = {}, opts = {}) {
  const cfg = await mergeConfig(runtimeConfig);
  const temperature = opts.temperature != null ? opts.temperature : null;

  if (providerName === 'openai') {
    return {
      apiKey: runtimeConfig.apiKey || cfg.openai_api_key || process.env.OPENAI_API_KEY,
      model: opts.model || runtimeConfig.model || cfg.openai_model || 'gpt-4o',
      temperature,
      cfg
    };
  }

  if (providerName === 'claude') {
    return {
      apiKey: runtimeConfig.apiKey || cfg.anthropic_api_key || process.env.ANTHROPIC_API_KEY,
      model: opts.model || runtimeConfig.model || cfg.anthropic_model || 'claude-3-5-sonnet-20241022',
      temperature,
      cfg
    };
  }

  if (providerName === 'gemini') {
    return {
      apiKey: runtimeConfig.apiKey || cfg.google_api_key || process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      model: opts.model || runtimeConfig.model || cfg.google_model || 'gemini-1.5-pro-latest',
      temperature,
      cfg
    };
  }

  return {
    apiKey: null,
    model: opts.model || runtimeConfig.model || null,
    temperature,
    cfg
  };
}

async function runTranscription(modelInstance, providerName, modelName, temperature, imageBuffer, mimeType, cfg = {}) {
  const startMs = Date.now();
  const systemPrompt = getSystemPrompt(cfg);
  const { text, usage } = await generateText({
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
      run_duration_ms: durationMs,
      input_tokens: usage?.inputTokens ?? null,
      output_tokens: usage?.outputTokens ?? null
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

  gemini: {
    name: 'gemini',
    async transcribeDocument(imageBuffer, mimeType, opts = {}, runtimeConfig = {}) {
      const cfg = await mergeConfig(runtimeConfig);
      const apiKey = runtimeConfig.apiKey || cfg.google_api_key || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      const model = opts.model || runtimeConfig.model || cfg.google_model || 'gemini-1.5-pro-latest';
      const temperature = opts.temperature != null ? opts.temperature : null;
      const client = createGoogleGenerativeAI({ apiKey });
      return runTranscription(client(model), 'gemini', model, temperature, imageBuffer, mimeType, cfg);
    }
  },

  ollama: {
    name: 'ollama',
    async transcribeDocument(imageBuffer, mimeType, opts = {}, runtimeConfig = {}) {
      const cfg = await mergeConfig(runtimeConfig);
      const baseURL = runtimeConfig.baseURL || cfg.ollama_base_url || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
      validateLlmBaseUrl(baseURL, 'Ollama');
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
      validateLlmBaseUrl(baseURL, 'LM Studio');
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
  claude: 'claude-haiku-4-5-20251001',
  gemini: 'gemini-1.5-flash-latest',
  ollama: null,   // use configured model (local, no cost)
  lmstudio: null  // use configured model (local, no cost)
};

// Cheapest text models per provider — used for title and summary generation
// (no image needed; these are fast, cheap text tasks).
const CHEAP_UTILITY_MODELS = {
  openai: 'gpt-4o-mini',
  claude: 'claude-haiku-4-5-20251001',
  gemini: 'gemini-1.5-flash-latest',
  ollama: null,
  lmstudio: null
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
    case 'gemini': {
      const apiKey = runtimeConfig.apiKey || cfg.google_api_key || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      const model = userVisionModel || cfg.google_vision_model || CHEAP_VISION_MODELS.gemini;
      return createGoogleGenerativeAI({ apiKey })(model);
    }
    case 'ollama': {
      const baseURL = runtimeConfig.baseURL || cfg.ollama_base_url || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
      validateLlmBaseUrl(baseURL, 'Ollama');
      const model = userVisionModel || cfg.ollama_model || 'llava';
      return createOllama({ baseURL })(model);
    }
    case 'lmstudio': {
      const baseURL = runtimeConfig.baseURL || cfg.lmstudio_base_url || process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1';
      validateLlmBaseUrl(baseURL, 'LM Studio');
      const model = userVisionModel || cfg.lmstudio_model || 'local-model';
      return createOpenAI({ baseURL, apiKey: 'lmstudio' })(model);
    }
    default:
      return null;
  }
}

function providerNeedsApiKey(name) {
  return name === 'openai' || name === 'claude' || name === 'gemini';
}

async function createProvider(name, runtimeConfig = {}) {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Unknown provider: "${name}". Available: ${listProviders().join(', ')}`);
  }
  const cfg = await mergeConfig(runtimeConfig);
  if (name === 'openai' && !runtimeConfig.apiKey && !cfg.openai_api_key && !process.env.OPENAI_API_KEY) {
    throw new Error('OpenAI API key is not configured. Set it in Admin → LLM Settings.');
  }
  if (name === 'claude' && !runtimeConfig.apiKey && !cfg.anthropic_api_key && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API key is not configured. Set it in Admin → LLM Settings.');
  }
  if (name === 'gemini' && !runtimeConfig.apiKey && !cfg.google_api_key && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new Error('Google AI API key is not configured. Set it in Admin → LLM Settings.');
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
    if (name === 'gemini')   return !!(cfg.google_api_key    || process.env.GOOGLE_GENERATIVE_AI_API_KEY);
    // ollama and lmstudio are local — always available
    return true;
  });
}

// Create a model instance for text-only utility calls (title/summary generation).
// Uses the cheapest configured model — no image capability required.
async function getUtilityModelInstance(providerName, runtimeConfig = {}) {
  const cfg = await mergeConfig(runtimeConfig);
  const userUtilityModel = runtimeConfig.utilityModel || null;

  switch (providerName) {
    case 'openai': {
      const apiKey = runtimeConfig.apiKey || cfg.openai_api_key || process.env.OPENAI_API_KEY;
      const model = userUtilityModel || cfg.openai_utility_model || CHEAP_UTILITY_MODELS.openai;
      return createOpenAI({ apiKey })(model);
    }
    case 'claude': {
      const apiKey = runtimeConfig.apiKey || cfg.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
      const model = userUtilityModel || cfg.anthropic_utility_model || CHEAP_UTILITY_MODELS.claude;
      return createAnthropic({ apiKey })(model);
    }
    case 'gemini': {
      const apiKey = runtimeConfig.apiKey || cfg.google_api_key || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      const model = userUtilityModel || cfg.google_utility_model || CHEAP_UTILITY_MODELS.gemini;
      return createGoogleGenerativeAI({ apiKey })(model);
    }
    case 'ollama': {
      const baseURL = runtimeConfig.baseURL || cfg.ollama_base_url || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
      validateLlmBaseUrl(baseURL, 'Ollama');
      const model = userUtilityModel || cfg.ollama_model || 'llava';
      return createOllama({ baseURL })(model);
    }
    case 'lmstudio': {
      const baseURL = runtimeConfig.baseURL || cfg.lmstudio_base_url || process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1';
      validateLlmBaseUrl(baseURL, 'LM Studio');
      const model = userUtilityModel || cfg.lmstudio_model || 'local-model';
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
  const modelInstance = await getUtilityModelInstance(providerName, runtimeConfig);
  if (!modelInstance) return { title: null, usage: null };

  const excerpt = transcription.substring(0, 3000);
  const { text, usage } = await generateText({
    model: modelInstance,
    system: TITLE_PROMPT,
    prompt: `Generate a short descriptive title (5-10 words) for this document:\n\n${excerpt}`,
    temperature: 0.3
  });

  let title = text.trim().replace(/^["']+|["']+$/g, '').replace(/[.!]+$/, '').trim();
  if (!title || title.length > 120) return { title: null, usage };
  return { title, usage };
}

const SUMMARY_PROMPT = `You summarize historical documents in 1-2 concise sentences based on their transcribed content.
The summary should capture the key subject matter, people involved, and purpose of the document.
Write in a neutral, informative tone suitable for a library catalog entry.
Respond with ONLY the summary — no quotes, no labels, no preamble.`;

async function generateDocumentSummary(providerName, transcription, runtimeConfig = {}) {
  const modelInstance = await getUtilityModelInstance(providerName, runtimeConfig);
  if (!modelInstance) return { summary: null, usage: null };

  const excerpt = transcription.substring(0, 3000);
  const { text, usage } = await generateText({
    model: modelInstance,
    system: SUMMARY_PROMPT,
    prompt: `Summarize this historical document in 1-2 sentences:\n\n${excerpt}`,
    temperature: 0.3
  });

  let summary = text.trim().replace(/^["']+|["']+$/g, '').trim();
  if (!summary || summary.length > 500) return { summary: null, usage };
  return { summary, usage };
}

const TOPIC_LABEL_PROMPT = `You name topics discovered in collections of historical documents.
Use the topic keywords and short representative document excerpts to infer the shared subject.

Rules:
- Return concise, human-readable labels in Title Case
- Prefer subject matter over generic document types
- Use 2-6 words when possible
- Do not include quotation marks, colons, underscores, or the word "Topic"
- Avoid vague labels like "Miscellaneous Correspondence" unless the evidence truly supports that
- If the topic is about a place, person, institution, event, or administrative matter, name that clearly

Respond ONLY with a valid JSON array in this format:
[
  { "topic_id": 0, "label": "School Funding Requests" },
  { "topic_id": 1, "label": "Teacher Appointment Records" }
]`;

function compactTopicText(value, maxLength = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}…` : text;
}

function sanitizeTopicLabel(value) {
  let label = String(value || '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/[_:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.!?;,:-]+$/g, '')
    .trim();

  if (!label || /^topic\b/i.test(label)) return null;
  if (label.length > 80) {
    label = label.slice(0, 80).trim();
  }
  return label || null;
}

async function generateTopicLabels(providerName, topics, assignments, documents, runtimeConfig = {}) {
  const candidateTopics = (topics || []).filter((topic) => topic && topic.topic_id !== -1);
  if (candidateTopics.length === 0) {
    return { labels: {}, usage: null, error: null };
  }

  let modelInstance;
  try {
    modelInstance = await getUtilityModelInstance(providerName, runtimeConfig);
  } catch (err) {
    return { labels: {}, usage: null, error: err };
  }
  if (!modelInstance) {
    return { labels: {}, usage: null, error: null };
  }

  const docById = new Map((documents || []).map((doc) => [Number(doc.id), doc]));
  const assignmentsByTopic = new Map();
  for (const assignment of assignments || []) {
    const topicId = Number(assignment.topic_id);
    if (!assignmentsByTopic.has(topicId)) {
      assignmentsByTopic.set(topicId, []);
    }
    assignmentsByTopic.get(topicId).push(assignment);
  }

  const payload = candidateTopics.map((topic) => {
    const representativeDocs = (assignmentsByTopic.get(Number(topic.topic_id)) || [])
      .slice()
      .sort((a, b) => (Number(b.probability) || 0) - (Number(a.probability) || 0))
      .map((assignment) => docById.get(Number(assignment.document_id)))
      .filter(Boolean)
      .slice(0, 2)
      .map((doc) => ({
        title: compactTopicText(doc.title || 'Untitled Document', 90),
        excerpt: compactTopicText(doc.content || doc.text || '', 180)
      }));

    return {
      topic_id: topic.topic_id,
      keywords: (topic.topic_words || []).slice(0, 8).map((word) => word.word),
      document_count: topic.document_count || 0,
      representative_documents: representativeDocs
    };
  });

  try {
    const { text, usage } = await generateText({
      model: modelInstance,
      system: TOPIC_LABEL_PROMPT,
      prompt: `Generate better labels for these discovered topics:\n\n${JSON.stringify(payload, null, 2)}`,
      temperature: 0.2
    });

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) {
      return { labels: {}, usage, error: new Error('Could not parse topic label response.') };
    }

    const parsed = JSON.parse(match[0]);
    const labels = {};
    for (const item of parsed) {
      const topicId = Number(item?.topic_id);
      const label = sanitizeTopicLabel(item?.label);
      if (Number.isInteger(topicId) && label) {
        labels[topicId] = label;
      }
    }

    return { labels, usage, error: null };
  } catch (err) {
    return { labels: {}, usage: null, error: err };
  }
}

module.exports = {
  createProvider,
  listProviders,
  listConfiguredProviders,
  providerNeedsApiKey,
  parseTranscriptionResponse: parseResponse,
  getTranscriptionSystemPrompt,
  resolveTranscriptionRuntime,
  generateDocumentTitle,
  generateDocumentSummary,
  generateTopicLabels,
  validateLlmBaseUrl
};
