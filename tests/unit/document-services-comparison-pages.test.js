'use strict';

const {
  buildComparisonPages,
  stripPageMarkers
} = require('../../utils/document-services');

describe('buildComparisonPages', () => {
  test('returns one text-only page when document has no images', () => {
    const document = {
      id: 1,
      title: 'Letter from S. Smith',
      image_path: null,
      metadata: {}
    };
    const transcript = {
      id: 11,
      content: 'Dear friend, I write to you from Boston this October.'
    };

    const pages = buildComparisonPages(document, transcript);

    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      pageNumber: 1,
      imagePath: null,
      transcriptText: 'Dear friend, I write to you from Boston this October.',
      startOffset: 0
    });
    expect(pages[0].endOffset).toBe(pages[0].transcriptText.length);
  });

  test('returns one text-only page when transcript is empty', () => {
    const document = { id: 2, image_path: null, metadata: {} };
    const transcript = { id: 22, content: '' };

    const pages = buildComparisonPages(document, transcript);

    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      pageNumber: 1,
      imagePath: null,
      transcriptText: '',
      startOffset: 0,
      endOffset: 0
    });
  });

  test('strips page markers from text-only transcript content', () => {
    const document = { id: 3, image_path: null, metadata: {} };
    const markedContent = '<<<PAGE 1>>>\nHello world<<<PAGE 2>>>\nMore content';
    const transcript = { id: 33, content: markedContent };

    const pages = buildComparisonPages(document, transcript);
    const cleaned = stripPageMarkers(markedContent);

    expect(pages).toHaveLength(1);
    expect(pages[0].transcriptText).toBe(cleaned);
    expect(pages[0].imagePath).toBeNull();
  });

  test('preserves multi-image behavior unchanged', () => {
    const document = {
      id: 4,
      image_path: '/uploads/page1.jpg',
      metadata: { additional_pages: ['/uploads/page2.jpg'] }
    };
    const transcript = {
      id: 44,
      content: '<<<PAGE 1>>>\nFirst page text\n<<<PAGE 2>>>\nSecond page text'
    };

    const pages = buildComparisonPages(document, transcript);

    expect(pages).toHaveLength(2);
    expect(pages[0].imagePath).toBe('/uploads/page1.jpg');
    expect(pages[1].imagePath).toBe('/uploads/page2.jpg');
    expect(pages[0].pageNumber).toBe(1);
    expect(pages[1].pageNumber).toBe(2);
  });
});
