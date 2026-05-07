'use strict';

const { buildPrompt, validatePromptTemplate } = require('../../utils/sentiment/prompt');

const VALID_TEMPLATE = `You extract aspect-based sentiment from 19th-century archival text.
Return JSON: {"annotations":[...]}.

Document metadata: {{document_metadata}}
Known entities (id, name, type):
{{known_entities}}

Transcript:
{{transcript_content}}`;

describe('sentiment prompt', () => {
  test('buildPrompt substitutes all placeholders', () => {
    const out = buildPrompt({
      template: VALID_TEMPLATE,
      documentMetadata: 'Title: Annual Report (1872)',
      knownEntities: [{ id: 1, name: 'School District 4', entity_type: 'organization' }],
      transcriptContent: 'The schoolhouse was in deplorable condition.'
    });
    expect(out).toContain('Annual Report (1872)');
    expect(out).toContain('School District 4');
    expect(out).toContain('organization');
    expect(out).toContain('schoolhouse was in deplorable');
    expect(out).not.toContain('{{');
  });

  test('validatePromptTemplate accepts a template with required placeholders and JSON instruction', () => {
    expect(() => validatePromptTemplate(VALID_TEMPLATE)).not.toThrow();
  });

  test('validatePromptTemplate rejects template missing {{transcript_content}}', () => {
    const bad = VALID_TEMPLATE.replace('{{transcript_content}}', '[transcript here]');
    expect(() => validatePromptTemplate(bad)).toThrow(/transcript_content/);
  });

  test('validatePromptTemplate rejects template missing {{known_entities}}', () => {
    const bad = VALID_TEMPLATE.replace('{{known_entities}}', '[entities here]');
    expect(() => validatePromptTemplate(bad)).toThrow(/known_entities/);
  });

  test('validatePromptTemplate rejects template missing JSON instruction', () => {
    const bad = `Document metadata: {{document_metadata}}
Known entities: {{known_entities}}
Transcript: {{transcript_content}}`;
    expect(() => validatePromptTemplate(bad)).toThrow(/JSON|annotations/);
  });
});
