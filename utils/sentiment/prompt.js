'use strict';

const REQUIRED_PLACEHOLDERS = ['{{transcript_content}}', '{{known_entities}}'];

function formatKnownEntities(entities) {
  if (!Array.isArray(entities) || entities.length === 0) return '(none)';
  return entities
    .map((e) => `- id=${e.id} | ${e.name} | ${e.entity_type || 'unknown'}`)
    .join('\n');
}

function buildPrompt({ template, documentMetadata, knownEntities, transcriptContent }) {
  if (typeof template !== 'string' || !template.trim()) {
    throw new Error('Sentiment prompt template is empty. Configure sentiment.prompt.default.');
  }
  return template
    .replace(/\{\{document_metadata\}\}/g, String(documentMetadata || '(none)'))
    .replace(/\{\{known_entities\}\}/g, formatKnownEntities(knownEntities))
    .replace(/\{\{transcript_content\}\}/g, String(transcriptContent || ''));
}

function validatePromptTemplate(template) {
  if (typeof template !== 'string' || !template.trim()) {
    throw new Error('Prompt template must be a non-empty string.');
  }
  for (const placeholder of REQUIRED_PLACEHOLDERS) {
    if (!template.includes(placeholder)) {
      throw new Error(`Prompt template is missing required placeholder ${placeholder}.`);
    }
  }
  if (!/JSON/i.test(template) || !/annotations/i.test(template)) {
    throw new Error('Prompt template must instruct a JSON response containing an "annotations" array.');
  }
  return true;
}

module.exports = { buildPrompt, validatePromptTemplate, REQUIRED_PLACEHOLDERS };
