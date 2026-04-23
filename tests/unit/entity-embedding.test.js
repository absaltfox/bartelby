'use strict';

const { buildEntityText } = require('../../utils/entity-embedding');

describe('buildEntityText', () => {
  it('builds text with name, type, aliases, and citation', () => {
    const entity = { entity_type: 'person', canonical_name: 'Alice Reed' };
    const aliases = ['Mrs. Reed', 'A. Reed'];
    const citation = 'Alice Reed wrote to Bob Grant about harbour plans in 1842.';
    const text = buildEntityText(entity, aliases, citation);
    expect(text).toBe(
      'person: Alice Reed. Also known as: Mrs. Reed, A. Reed.\n' +
      'Evidence: "Alice Reed wrote to Bob Grant about harbour plans in 1842."'
    );
  });

  it('omits the Also known as line when there are no aliases', () => {
    const entity = { entity_type: 'place', canonical_name: 'Halifax' };
    const text = buildEntityText(entity, [], null);
    expect(text).toBe('place: Halifax.');
  });

  it('omits the Evidence line when citation is null', () => {
    const entity = { entity_type: 'person', canonical_name: 'Bob Grant' };
    const text = buildEntityText(entity, ['B. Grant'], null);
    expect(text).toBe('person: Bob Grant. Also known as: B. Grant.');
  });

  it('truncates citation passages longer than 120 chars', () => {
    const entity = { entity_type: 'person', canonical_name: 'Alice Reed' };
    const longCitation = 'A'.repeat(200);
    const text = buildEntityText(entity, [], longCitation);
    expect(text).toContain('Evidence: "' + 'A'.repeat(120) + '"');
    expect(text.length).toBeLessThan(200);
  });

  it('deduplicates aliases that match the canonical name', () => {
    const entity = { entity_type: 'person', canonical_name: 'Alice Reed' };
    const text = buildEntityText(entity, ['Alice Reed', 'Mrs. Reed'], null);
    expect(text).toBe('person: Alice Reed. Also known as: Mrs. Reed.');
  });
});
