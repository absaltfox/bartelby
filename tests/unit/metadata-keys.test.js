'use strict';

const {
  METADATA_RESERVED_KEYS,
  stripReservedMetadataKeys
} = require('../../utils/metadata-keys');

describe('metadata-keys', () => {
  it('exposes additional_pages as a reserved key', () => {
    expect(METADATA_RESERVED_KEYS.has('additional_pages')).toBe(true);
  });

  it('exposes _upload_filename as a reserved key', () => {
    expect(METADATA_RESERVED_KEYS.has('_upload_filename')).toBe(true);
  });

  it('returns a new object without reserved keys', () => {
    const input = {
      author: 'Anon',
      additional_pages: ['/uploads/secret.png'],
      _upload_filename: 'evil.png',
      location: 'Boston'
    };
    const out = stripReservedMetadataKeys(input);
    expect(out).toEqual({ author: 'Anon', location: 'Boston' });
    // Does not mutate input
    expect(input).toHaveProperty('additional_pages');
  });

  it('returns an empty object when given null/undefined', () => {
    expect(stripReservedMetadataKeys(null)).toEqual({});
    expect(stripReservedMetadataKeys(undefined)).toEqual({});
  });

  it('returns an empty object when given a non-object value', () => {
    expect(stripReservedMetadataKeys('string')).toEqual({});
    expect(stripReservedMetadataKeys(42)).toEqual({});
    expect(stripReservedMetadataKeys(['a'])).toEqual({});
  });

  it('preserves non-reserved keys with falsy values', () => {
    const out = stripReservedMetadataKeys({ language: '', source: 0 });
    expect(out).toEqual({ language: '', source: 0 });
  });
});
