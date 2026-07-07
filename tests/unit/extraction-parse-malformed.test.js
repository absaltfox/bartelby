'use strict';

const { parseExtractionResponse } = require('../../utils/extraction-llm');
const { materializeExtractionResult } = require('../../utils/worker-extraction');

describe('parseExtractionResponse malformed detection', () => {
  it('flags non-JSON prose as malformed', () => {
    const out = parseExtractionResponse('I cannot process this document.');
    expect(out.malformed).toBe(true);
    expect(out.entities).toEqual([]);
  });

  it('flags truncated JSON as malformed', () => {
    const out = parseExtractionResponse('{"entities": [{"mention": "Jo');
    expect(out.malformed).toBe(true);
  });

  it('flags empty/undefined input as malformed', () => {
    expect(parseExtractionResponse('').malformed).toBe(true);
    expect(parseExtractionResponse(undefined).malformed).toBe(true);
  });

  it('does NOT flag valid JSON with zero artifacts', () => {
    const out = parseExtractionResponse('{"entities": [], "relationships": [], "dates": []}');
    expect(out.malformed).toBe(false);
    expect(out.entities).toEqual([]);
  });

  it('does NOT flag valid fenced JSON', () => {
    const out = parseExtractionResponse('```json\n{"entities": [{"mention": "John"}], "relationships": [], "dates": []}\n```');
    expect(out.malformed).toBe(false);
    expect(out.entities).toHaveLength(1);
  });
});

describe('materializeExtractionResult refuses malformed output', () => {
  it('throws before touching reset staging or marking done', async () => {
    const graphMaintenance = {
      getPreExistingCitationIds: jest.fn(),
      resetCitationsById: jest.fn()
    };
    const extractionJobs = { markDone: jest.fn() };

    await expect(materializeExtractionResult({
      job: { id: 1, job_kind: null },
      transcript: { id: 1, content: 'some transcript text' },
      doc: { id: 1 },
      extractionResult: { entities: [], relationships: [], dates: [], malformed: true },
      providerName: 'openai',
      logLine: async () => {},
      resetExisting: true,
      extractionJobs,
      entities: {}, entityAliases: {}, dateExpressions: {},
      relationships: {}, citations: {},
      relationshipTypes: null, relationshipTypeAliasesAsync: null,
      graphMaintenance
    })).rejects.toThrow(/could not be parsed/i);

    expect(graphMaintenance.getPreExistingCitationIds).not.toHaveBeenCalled();
    expect(graphMaintenance.resetCitationsById).not.toHaveBeenCalled();
    expect(extractionJobs.markDone).not.toHaveBeenCalled();
  });
});
