'use strict';

// Prevent s3.js from trying to instantiate an S3Client during require
// by ensuring S3_ENDPOINT is unset and @aws-sdk is stubbed.
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({})),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
  DeleteObjectsCommand: jest.fn(),
  HeadObjectCommand: jest.fn(),
  CopyObjectCommand: jest.fn(),
}));

// Ensure no endpoint is configured during module load
delete process.env.S3_ENDPOINT;

const { validateS3Endpoint } = require('../../utils/storage/s3');

describe('validateS3Endpoint', () => {
  describe('valid endpoints — should not throw', () => {
    const valid = [
      'http://localhost:9000',
      'https://s3.amazonaws.com',
      'https://s3.us-east-1.amazonaws.com',
      'https://objects.example.com:9000',
      'http://10.0.0.5:9000',
    ];
    valid.forEach(url => {
      it(`accepts: ${url}`, () => {
        expect(() => validateS3Endpoint(url)).not.toThrow();
      });
    });

    it('does nothing for undefined', () => {
      expect(() => validateS3Endpoint(undefined)).not.toThrow();
    });
    it('does nothing for empty string', () => {
      expect(() => validateS3Endpoint('')).not.toThrow();
    });
  });

  describe('blocked hosts — must throw', () => {
    const blocked = [
      ['AWS metadata IP', 'http://169.254.169.254/'],
      ['link-local range', 'http://169.254.50.50/'],
      ['Alibaba metadata', 'http://100.100.100.200/'],
      ['GCP metadata hostname', 'http://metadata.google.internal/'],
    ];
    blocked.forEach(([label, url]) => {
      it(`blocks ${label}`, () => {
        expect(() => validateS3Endpoint(url)).toThrow(/blocked/i);
      });
    });
  });

  describe('invalid protocol — must throw', () => {
    it('rejects ftp://', () => {
      expect(() => validateS3Endpoint('ftp://bucket.example.com')).toThrow(/http/i);
    });
  });

  describe('malformed — must throw', () => {
    it('rejects non-URL strings', () => {
      expect(() => validateS3Endpoint('not-a-url')).toThrow();
    });
  });
});
