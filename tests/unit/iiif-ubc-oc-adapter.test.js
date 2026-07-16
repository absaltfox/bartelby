'use strict';

const {
  enumerateManifestRefs, itemIdToManifestUrl, buildItemImageUrl, buildItemImageServiceBase,
  cleanFullText, parseItemsPage, firstText, fetchItemFullText
} = require('../../utils/iiif/sources/ubc-oc');

describe('ubc-oc: buildItemImageServiceBase', () => {
  it('returns the derived image-service base (no /full suffix) for URL rebuild', () => {
    expect(buildItemImageServiceBase('royalfisk', '1.0040134', 2)).toBe(
      'https://iiif.library.ubc.ca/image/cdm.royalfisk.1-0040134.0002'
    );
  });
});

describe('ubc-oc: fetchItemFullText (item-detail endpoint)', () => {
  it('extracts and cleans FullText from the injected detail record', async () => {
    const fetchDetail = jest.fn(async () => ({
      data: { FullText: 'Dear Sir,<br>I write in <sup>2</sup> haste.&nbsp;[sic]' }
    }));
    const text = await fetchItemFullText(
      { collection_identifier: 'royalfisk' }, '1.0040134', { fetchDetail }
    );
    expect(fetchDetail).toHaveBeenCalledWith(expect.anything(), '1.0040134');
    expect(text).toBe('Dear Sir,\nI write in 2 haste. [sic]');
  });

  it('returns null when the detail record has no FullText', async () => {
    const fetchDetail = jest.fn(async () => ({ data: { Title: 'Untranscribed' } }));
    const text = await fetchItemFullText({ collection_identifier: 'x' }, '1.1', { fetchDetail });
    expect(text).toBeNull();
  });
});

describe('ubc-oc: buildItemImageUrl (verified working pattern, not the manifest service)', () => {
  it('derives the working per-page Image API URL (single .NNNN, not the broken .0000.NNNN)', () => {
    // Verified live: royalfisk 1.0040134 pages .0000/.0001/.0002 all resolve.
    expect(buildItemImageUrl('royalfisk', '1.0040134', 0, '2000,')).toBe(
      'https://iiif.library.ubc.ca/image/cdm.royalfisk.1-0040134.0000/full/2000,/0/default.jpg'
    );
    expect(buildItemImageUrl('royalfisk', '1.0040134', 2, '2000,')).toBe(
      'https://iiif.library.ubc.ca/image/cdm.royalfisk.1-0040134.0002/full/2000,/0/default.jpg'
    );
  });
  it('zero-pads the canvas index to 4 digits', () => {
    expect(buildItemImageUrl('c', '1.5', 12, 'full')).toContain('.1-5.0012/full/full/0/default.jpg');
  });
});

describe('ubc-oc: cleanFullText', () => {
  it('converts <br> to newlines and strips tags, keeping [sic] and sup contents', () => {
    const raw = 'Victoria V.I. 23. 1862<br>\nDear Sir <br>Rice 6&frac12; to 8<sup>c </sup><br>';
    const out = cleanFullText(raw);
    expect(out).toContain('Victoria V.I. 23. 1862');
    expect(out).toMatch(/Dear Sir\s*\nRice/);
    expect(out).toContain('8c'); // <sup> stripped, content kept
    expect(out).not.toContain('<br>');
    expect(out).not.toContain('<sup>');
  });
  it('decodes common entities and trims', () => {
    expect(cleanFullText('A &amp; B &nbsp;')).toBe('A & B');
  });
  it('returns null for empty/nullish input', () => {
    expect(cleanFullText(null)).toBeNull();
    expect(cleanFullText('   ')).toBeNull();
  });
});

describe('ubc-oc: itemIdToManifestUrl (dot→dash transform)', () => {
  it('maps a UBC item id to the per-item IIIF manifest URL', () => {
    expect(itemIdToManifestUrl('bcedu', '1.0362307')).toBe(
      'https://iiif.library.ubc.ca/presentation/cdm.bcedu.1-0362307.0000/manifest'
    );
  });
  it('replaces every dot in the id', () => {
    expect(itemIdToManifestUrl('wwposters', '1.2.3')).toBe(
      'https://iiif.library.ubc.ca/presentation/cdm.wwposters.1-2-3.0000/manifest'
    );
  });
});

describe('ubc-oc: parseItemsPage (defensive wrapper handling)', () => {
  it('reads a { data: [...] } wrapper and extracts _id / Title / FullText', () => {
    const items = parseItemsPage({ data: [{ _id: '1.0001', Title: 'Letter A', FullText: 'transcribed text' }] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ itemId: '1.0001', title: 'Letter A', fullText: 'transcribed text' });
  });
  it('reads a bare array and an { items: [...] } wrapper', () => {
    expect(parseItemsPage([{ _id: '1.1' }])).toHaveLength(1);
    expect(parseItemsPage({ items: [{ id: '1.2' }] })[0].itemId).toBe('1.2');
  });
  it('skips records with no id', () => {
    expect(parseItemsPage({ data: [{ Title: 'no id' }, { _id: '1.3' }] })).toHaveLength(1);
  });
  it('firstText normalizes strings, arrays, and {value} objects', () => {
    expect(firstText(['  a  '])).toBe('a');
    expect(firstText({ value: 'b' })).toBe('b');
    expect(firstText('')).toBeNull();
  });
});

describe('ubc-oc: enumerateManifestRefs (paginated, injectable fetch)', () => {
  it('walks pages until a short page and yields manifest URLs in order', async () => {
    // page_size 2: page@0 → 2 items (full), page@2 → 1 item (short → stop).
    const pages = {
      0: { data: [{ _id: '1.0001' }, { _id: '1.0002' }] },
      2: { data: [{ _id: '1.0003' }] }
    };
    const fetchPage = jest.fn(async (_source, offset) => pages[offset] || { data: [] });

    const refs = [];
    for await (const ref of enumerateManifestRefs(
      { collection_identifier: 'bcedu', page_size: 2 },
      { fetchPage }
    )) {
      refs.push(ref);
    }

    expect(fetchPage).toHaveBeenCalledTimes(2); // stopped on the short page, no extra call
    expect(refs.map((r) => r.itemId)).toEqual(['1.0001', '1.0002', '1.0003']);
    expect(refs[0].manifestUrl).toBe('https://iiif.library.ubc.ca/presentation/cdm.bcedu.1-0001.0000/manifest');
    expect(refs[2].offset).toBe(2); // resume cursor for the last item is its page offset
  });

  it('resumes from a starting cursor offset', async () => {
    const fetchPage = jest.fn(async (_s, offset) => (offset === 10 ? { data: [{ _id: '1.9' }] } : { data: [] }));
    const refs = [];
    for await (const ref of enumerateManifestRefs(
      { collection_identifier: 'bcedu', page_size: 5, cursor_offset: 10 },
      { fetchPage }
    )) { refs.push(ref); }
    expect(fetchPage).toHaveBeenCalledWith(expect.anything(), 10, 5);
    expect(refs.map((r) => r.itemId)).toEqual(['1.9']);
  });
});
