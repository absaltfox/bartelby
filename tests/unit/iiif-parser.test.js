'use strict';

const {
  detectVersion, firstString, parseManifest, buildImageUrl
} = require('../../utils/iiif/parser');

// Captured from a real UBC Open Collections manifest shape (Presentation 2.0):
// plain-string label/metadata, `attribution`, sequences→canvases→images→
// resource.service['@id']. Extended to two canvases to model a multi-page letter.
const UBC_V2 = {
  '@context': 'http://iiif.io/api/presentation/2/context.json',
  '@type': 'sc:Manifest',
  '@id': 'https://iiif.library.ubc.ca/presentation/cdm.bcedu.1-0355678.0000/manifest',
  label: 'Letter to the Superintendent of Education',
  description: '[No description]',
  attribution: 'Images provided for research and reference use only.',
  metadata: [
    { label: 'Date', value: '1885-04-15' },
    { label: 'Extent', value: '2 pages' },
    { label: 'Creator', value: 'John Jessop' }
  ],
  sequences: [
    {
      '@type': 'sc:Sequence',
      canvases: [
        {
          '@id': 'https://iiif.library.ubc.ca/presentation/cdm.bcedu.1-0355678.0000/canvas/p0',
          label: 'Page 1', width: 800, height: 1100,
          images: [{ resource: {
            '@id': 'https://iiif.library.ubc.ca/image/cdm.bcedu.1-0355678.0000',
            '@type': 'dctypes:Image', format: 'image/jpeg',
            service: {
              '@context': 'http://iiif.io/api/image/2/context.json',
              '@id': 'https://iiif.library.ubc.ca/image/cdm.bcedu.1-0355678.0000',
              profile: 'http://iiif.io/api/image/2/level2.json'
            }
          } }]
        },
        {
          '@id': 'https://iiif.library.ubc.ca/presentation/cdm.bcedu.1-0355678.0000/canvas/p1',
          label: 'Page 2', width: 800, height: 1100,
          images: [{ resource: {
            '@id': 'https://iiif.library.ubc.ca/image/cdm.bcedu.1-0355678.0001',
            format: 'image/jpeg',
            service: {
              '@id': 'https://iiif.library.ubc.ca/image/cdm.bcedu.1-0355678.0001',
              profile: 'http://iiif.io/api/image/2/level2.json'
            }
          } }]
        }
      ]
    }
  ]
};

// Minimal Presentation 3.0 manifest (language-map label, items→AnnotationPage→
// Annotation→body.service). v3 is Phase 2, but the branch is guarded here.
const V3 = {
  '@context': 'http://iiif.io/api/presentation/3/context.json',
  type: 'Manifest',
  id: 'https://example.org/iiif/manifest',
  label: { en: ['A v3 letter'] },
  requiredStatement: { label: { en: ['Attribution'] }, value: { en: ['Held by Example Archive'] } },
  items: [
    {
      id: 'https://example.org/iiif/canvas/1', type: 'Canvas',
      items: [{ type: 'AnnotationPage', items: [{ type: 'Annotation', body: {
        id: 'https://example.org/iiif/img/full/max/0/default.jpg', type: 'Image',
        service: [{ id: 'https://example.org/iiif/img', type: 'ImageService2' }]
      } }] }]
    }
  ]
};

describe('IIIF parser — version detection', () => {
  it('detects Presentation API 2.0 (UBC)', () => { expect(detectVersion(UBC_V2)).toBe(2); });
  it('detects Presentation API 3.0', () => { expect(detectVersion(V3)).toBe(3); });
});

describe('IIIF parser — firstString normalization', () => {
  it('passes a plain string through', () => { expect(firstString('x')).toBe('x'); });
  it('reads a v3 language map', () => { expect(firstString({ en: ['hi'] })).toBe('hi'); });
  it('reads a v2 @value object and arrays', () => {
    expect(firstString([{ '@value': 'v' }])).toBe('v');
  });
  it('returns null for empty', () => { expect(firstString(null)).toBeNull(); });
});

describe('IIIF parser — parseManifest (UBC v2)', () => {
  const m = parseManifest(UBC_V2);
  it('extracts id, label, and version', () => {
    expect(m.version).toBe(2);
    expect(m.label).toBe('Letter to the Superintendent of Education');
    expect(m.id).toBe('https://iiif.library.ubc.ca/presentation/cdm.bcedu.1-0355678.0000/manifest');
  });
  it('flattens metadata to a label→value map', () => {
    expect(m.metadata.Date).toBe('1885-04-15');
    expect(m.metadata.Creator).toBe('John Jessop');
  });
  it('captures attribution', () => {
    expect(m.attribution).toMatch(/research and reference/);
  });
  it('extracts both canvases with their Image API service bases', () => {
    expect(m.canvases).toHaveLength(2);
    expect(m.canvases[0].serviceBase).toBe('https://iiif.library.ubc.ca/image/cdm.bcedu.1-0355678.0000');
    expect(m.canvases[1].serviceBase).toBe('https://iiif.library.ubc.ca/image/cdm.bcedu.1-0355678.0001');
  });
  it('builds Image API 2.0 derivative URLs at the requested size', () => {
    expect(buildImageUrl(m.canvases[0], '2000,')).toBe(
      'https://iiif.library.ubc.ca/image/cdm.bcedu.1-0355678.0000/full/2000,/0/default.jpg'
    );
    expect(buildImageUrl(m.canvases[1], '2000,')).toBe(
      'https://iiif.library.ubc.ca/image/cdm.bcedu.1-0355678.0001/full/2000,/0/default.jpg'
    );
  });
});

describe('IIIF parser — parseManifest (v3)', () => {
  const m = parseManifest(V3);
  it('reads label, attribution, and canvas service', () => {
    expect(m.version).toBe(3);
    expect(m.label).toBe('A v3 letter');
    expect(m.attribution).toBe('Held by Example Archive');
    expect(m.canvases).toHaveLength(1);
    expect(buildImageUrl(m.canvases[0], '2000,')).toBe('https://example.org/iiif/img/full/2000,/0/default.jpg');
  });
});

describe('IIIF parser — defensive', () => {
  it('skips a malformed canvas (no images) without throwing', () => {
    const doc = JSON.parse(JSON.stringify(UBC_V2));
    doc.sequences[0].canvases.push({ '@id': 'x/canvas/p2', label: 'Blank' }); // no images
    const m = parseManifest(doc);
    expect(m.canvases).toHaveLength(2); // the blank canvas is dropped
  });
  it('falls back to a direct image URL when no service is present', () => {
    const doc = JSON.parse(JSON.stringify(UBC_V2));
    delete doc.sequences[0].canvases[0].images[0].resource.service;
    const m = parseManifest(doc);
    expect(buildImageUrl(m.canvases[0], '2000,')).toBe('https://iiif.library.ubc.ca/image/cdm.bcedu.1-0355678.0000');
  });
});
