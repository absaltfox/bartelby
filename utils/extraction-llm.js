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
- person — a named individual (e.g., "John Jessop", "Mary Sturgess")
- place — a named geographic location (e.g., "Victoria", "Nanaimo")
- event — a named or describable occurrence (e.g., "the school board meeting of 1872")
- organization — a named collective entity (e.g., "Board of Education", "Victoria High School")
- topic — a subject or theme being discussed (e.g., "school attendance", "teacher salaries")
- artifact — a named document, object, or physical thing (e.g., "the Report on Schools, 1872", "the Common School Act")
- claim — a compound assertion made in the text, including causal or explanatory ones (e.g., "low attendance was due to widespread illness", "the trustees failed in their duty")
- role — a named office, position, or formal capacity that a person holds within an organization (e.g., "Superintendent of Education", "Schoolteacher", "Trustee"). Distinct from the person who holds it.

ENTITY TYPE DISAMBIGUATION (E1.3):
A challenge with "role" is distinguishing:
1. The role title itself ("Superintendent of Education" → role)
2. A person identified by their role ("the Superintendent ordered…" → person, with a holds_position relationship to a Role entity if the role is named or inferable)
3. An office as an institution ("the office of the Superintendent published…" → organization OR role + organization depending on context)

Default rule: when the text names the role (e.g., "Superintendent of Education", "Inspector of Schools"), emit a role entity. When the text refers to a specific person performing the role and the person is named, emit a person entity AND a role entity AND a holds_position relationship.

RELATIONSHIP TYPES (canonical vocabulary — use these exact strings):
authored, received, mentioned_in, sent_from, sent_to, references, responds_to, co_filed_with, concerns,
resided_at, traveled_to, born_in, died_in, located_in,
employed_by, member_of, holds_position, position_in, founded, affiliated_with,
parent_of, child_of, spouse_of, sibling_of, related_to,
participated_in, occurred_at, occurred_on, caused_by,
dated, active_during,
owns, created, associated_with,
makes_claim, supports_claim, opposes_claim, claim_concerns, related_to_topic

RELATIONSHIP VOCABULARY GUIDANCE (E2.3):
Common deviations that should NOT happen — use the canonical forms instead:
- "mentions" / "mentions_in" / "mentioned" → use mentioned_in
- "received_at" → use occurred_at (for events)
- "contracted_with" → use related_to (with a description of the contract)
- "holds_role_in" → use holds_position (the new tripartite Person → Role → Organization model; see TRIPARTITE ROLE MODELING below)

TRIPARTITE ROLE MODELING (E1.2):
When a person holds a named role within an organization, prefer:
- Person —holds_position→ Role
- Role —position_in→ Organization
rather than the single Person —holds_role_in→ Organization. The Role entity may exist independently of any specific holder, which is useful for queries like "every Superintendent of Education across the decade."

Worked example:
"John Jessop, Superintendent of Education, addressed the Board."
→ entities: [
    person "John Jessop",
    role "Superintendent of Education",
    organization "Board of Education"  (only if "the Board" is contextually identifiable)
  ]
→ relationships: [
    {source: "John Jessop", target: "Superintendent of Education", type: "holds_position"},
    {source: "Superintendent of Education", target: "Board of Education", type: "position_in"}
  ]

VOICE ATTRIBUTION ON RELATIONSHIPS (E5.3):
For each relationship, attribute the assertion to a voice:
- voice_role: "author" — the writer of the document asserts this directly (default)
- voice_role: "speaker" — the writer is QUOTING someone who asserts this; voice_attribution_mention is the quoted speaker's name
- voice_role: "described_subject" — the writer is reporting what someone else claims/feels/does; voice_attribution_mention is that subject's name

Worked examples:
- "Mr. Jessop wrote to Miss Mary." → voice_role: "author"
- "'I shall write to Mary,' said Mr. Jessop." → voice_role: "speaker", voice_attribution_mention: "Mr. Jessop"
- "Mrs. Smith reports that her son struck the teacher." → voice_role: "described_subject", voice_attribution_mention: "Mrs. Smith" (because the writer is reporting Mrs. Smith's claim, not asserting it directly)

Emit non-author voice ONLY when grammatically clear. When in doubt, use "author".

RELATIONSHIP TEMPORAL SCOPE (E6.1):
When the text supports it, emit start_date / end_date on relationships. Worked examples:
- "Jessop served as Superintendent from 1872 to 1878." → holds_position with start_date: "1872", end_date: "1878"
- "Married in 1865." → spouse_of with start_date: "1865"
- "He resigned in 1879." → relationship with end_date: "1879"
Do NOT invent dates; only emit them when the text actually contains the temporal anchor.

CLAIM ENTITY USAGE (E7.1):
Emit a claim entity for compound assertions, including causal/explanatory ones, not only opinion statements.

Worked example A (opinion):
"I am of the opinion that the trustees have not fulfilled their duties."
→ entities: [person "the writer" (probably the document author), claim "the trustees have not fulfilled their duties", organization "trustees"]
→ relationships: [
    {writer, claim, makes_claim},
    {claim, trustees, claim_concerns}
  ]

Worked example B (causal):
"Attendance has fallen on account of the prevailing illness in the district."
→ entities: [
    topic "attendance",
    event "the prevailing illness",
    claim "attendance has fallen because of the illness"
  ]
→ relationships: [
    {claim, attendance, claim_concerns},
    {claim, the prevailing illness, claim_concerns}
  ]

RULES:
1. Return character offsets into the raw transcript for every entity and date.
2. Do not extract entities wholly inside [illegible].
3. Normalize names where helpful, but keep the raw mention too.
4. Use lower confidence when the evidence is uncertain or damaged.
5. If none exist for a field, return an empty array.
6. Respond with valid JSON only.
7. Every date in "dates" must include "entity_mention" — the normalized name of the entity the date describes (e.g. the person born, the event that occurred, the organization that was active). Only extract a date if you can identify which entity it belongs to. Do not extract free-floating dates with no clear subject entity.
8. Use "qualifier" on dates to indicate the nature of the temporal relationship: born_in, died_in, active_during, created_on, occurred_on, dated, valid_from, valid_to, or similar.
9. For each entity, include "genericity": "specific", "generic", or "unknown". Use "generic" only when the mention is a class-like reference rather than a particular person, place, organization, event, topic, artifact, role, or claim. For example, "High School" by itself may be generic; "Victoria High School" is specific. For roles, "Schoolteacher" by itself may be generic; "Superintendent of Education for British Columbia" is specific.

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
      "genericity": "specific",
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
      "date_qualifier": null,
      "voice_role": "author",
      "voice_attribution_mention": null
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
  // `malformed: true` means the provider response could not be parsed as
  // JSON at all — callers must fail the job/item rather than treat this as
  // an empty extraction. Per docs/reviews/2026-07-06-application-reliability-review.md R1.
  const malformed = { entities: [], relationships: [], dates: [], raw: text, malformed: true };
  if (!text || typeof text !== 'string') return malformed;

  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return malformed;

  try {
    const parsed = JSON.parse(match[0]);
    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
      dates: Array.isArray(parsed.dates) ? parsed.dates : [],
      raw: text,
      malformed: false
    };
  } catch {
    return malformed;
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
