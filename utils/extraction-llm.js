'use strict';

const { generateText } = require('ai');
const { getUtilityModelInstance } = require('./llm');

const EXTRACTION_SYSTEM_PROMPT = `You are an expert in historical document analysis, named-entity recognition, and knowledge graph construction.
Extract structured entities, relationships, and date expressions from transcribed historical documents.

INPUT FORMAT:
- The transcript may span multiple pages separated by [Page N] markers.
- Illegible text is marked as [illegible].
- Uncertain words appear as [unclear: word?].
- Struck-through text appears as ~~text~~.
- Interlinear additions appear in {curly braces}.

ENTITY TYPES:
- person
- place
- event
- organization
- topic
- artifact
- claim

RELATIONSHIP TYPES:
authored, received, mentioned_in, sent_from, sent_to, references, responds_to, co_filed_with, concerns,
resided_at, traveled_to, born_in, died_in, located_in,
employed_by, member_of, holds_role_in, founded, affiliated_with,
parent_of, child_of, spouse_of, sibling_of, related_to,
participated_in, occurred_at, occurred_on, caused_by,
dated, active_during,
owns, created, associated_with,
makes_claim, supports_claim, opposes_claim, claim_concerns, related_to_topic

RULES:
1. Return character offsets into the raw transcript for every entity and date.
2. Do not extract entities wholly inside [illegible].
3. Normalize names where helpful, but keep the raw mention too.
4. Use lower confidence when the evidence is uncertain or damaged.
5. If none exist for a field, return an empty array.
6. Respond with valid JSON only.
7. Every date in "dates" must include "entity_mention" — the normalized name of the entity the date describes (e.g. the person born, the event that occurred, the organization that was active). Only extract a date if you can identify which entity it belongs to. Do not extract free-floating dates with no clear subject entity.
8. Use "qualifier" on dates to indicate the nature of the temporal relationship: born_in, died_in, active_during, created_on, occurred_on, dated, valid_from, valid_to, or similar.

Return this exact shape:
{
  "entities": [
    {
      "mention": "raw text",
      "normalized": "normalized text",
      "type": "person",
      "span_start": 0,
      "span_end": 10,
      "confidence": 0.9,
      "properties": {}
    }
  ],
  "relationships": [
    {
      "source_mention": "source normalized text",
      "target_mention": "target normalized text",
      "type": "related_to",
      "evidence_span_start": 0,
      "evidence_span_end": 10,
      "evidence_text": "supporting text",
      "confidence": 0.75,
      "start_date": null,
      "end_date": null,
      "date_precision": null,
      "date_qualifier": null
    }
  ],
  "dates": [
    {
      "entity_mention": "John Jessop",
      "mention": "March 1872",
      "span_start": 0,
      "span_end": 10,
      "label": "March 1872",
      "earliest": "1872-03-01",
      "latest": "1872-03-31",
      "precision": "month",
      "qualifier": "active_during"
    }
  ]
}`;

function buildExtractionPrompt(transcriptContent, documentMetadata = {}) {
  const meta = [];
  if (documentMetadata.title) meta.push(`Title: ${documentMetadata.title}`);
  if (documentMetadata.date_created) meta.push(`Date: ${documentMetadata.date_created}`);
  if (documentMetadata.document_type) meta.push(`Type: ${documentMetadata.document_type}`);
  if (documentMetadata.author) meta.push(`Author: ${documentMetadata.author}`);
  if (documentMetadata.location) meta.push(`Location: ${documentMetadata.location}`);

  let prompt = '';
  if (meta.length > 0) {
    prompt += `Document metadata:\n${meta.join('\n')}\n\n`;
  }
  prompt += `Transcript:\n${transcriptContent}`;
  return prompt;
}

function parseExtractionResponse(text) {
  const empty = { entities: [], relationships: [], dates: [], raw: text };
  if (!text || typeof text !== 'string') return empty;

  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return empty;

  try {
    const parsed = JSON.parse(match[0]);
    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
      dates: Array.isArray(parsed.dates) ? parsed.dates : [],
      raw: text
    };
  } catch {
    return empty;
  }
}

async function runExtraction(providerName, transcriptContent, documentMetadata = {}, runtimeConfig = {}, opts = {}) {
  const modelInstance = await getUtilityModelInstance(providerName, runtimeConfig);
  if (!modelInstance) {
    throw new Error(`Could not create extraction model for provider "${providerName}"`);
  }

  const startMs = Date.now();
  const { text, usage } = await generateText({
    model: modelInstance,
    system: EXTRACTION_SYSTEM_PROMPT,
    temperature: opts.temperature != null ? opts.temperature : 0.2,
    prompt: buildExtractionPrompt(transcriptContent, documentMetadata)
  });

  const parsed = parseExtractionResponse(text);
  return {
    ...parsed,
    paradata: {
      provider: providerName,
      model: opts.model || null,
      prompt: EXTRACTION_SYSTEM_PROMPT,
      temperature: opts.temperature != null ? opts.temperature : 0.2,
      run_duration_ms: Date.now() - startMs,
      input_tokens: usage?.inputTokens ?? null,
      output_tokens: usage?.outputTokens ?? null
    }
  };
}

module.exports = {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionPrompt,
  parseExtractionResponse,
  runExtraction
};
