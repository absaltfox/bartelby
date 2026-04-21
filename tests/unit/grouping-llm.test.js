'use strict';

const { cropPageStrip } = require('../../utils/grouping-llm');

function makeTestImage(width, height) {
  const { createCanvas } = require('canvas');
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'red';
  ctx.fillRect(0, 0, width, height / 2);
  ctx.fillStyle = 'blue';
  ctx.fillRect(0, height / 2, width, height / 2);
  return canvas.toBuffer('image/png');
}

describe('cropPageStrip', () => {
  const testBuffer = makeTestImage(200, 400);

  it('crops the top 15% by default', async () => {
    const result = await cropPageStrip(testBuffer, { region: 'top' });
    expect(result).toBeInstanceOf(Buffer);
    const { loadImage } = require('canvas');
    const img = await loadImage(result);
    expect(img.width).toBe(200);
    expect(img.height).toBe(60);
  });

  it('crops the bottom 15%', async () => {
    const result = await cropPageStrip(testBuffer, { region: 'bottom' });
    const { loadImage } = require('canvas');
    const img = await loadImage(result);
    expect(img.width).toBe(200);
    expect(img.height).toBe(60);
  });

  it('returns two strips when region is both', async () => {
    const result = await cropPageStrip(testBuffer, { region: 'both' });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    const { loadImage } = require('canvas');
    const topImg = await loadImage(result[0]);
    const bottomImg = await loadImage(result[1]);
    expect(topImg.height).toBe(60);
    expect(bottomImg.height).toBe(60);
  });

  it('scales down images exceeding 1999px dimension limit', async () => {
    const largeBuffer = makeTestImage(2500, 4000);
    const result = await cropPageStrip(largeBuffer, { region: 'top' });
    const { loadImage } = require('canvas');
    const img = await loadImage(result);
    expect(img.width).toBeLessThanOrEqual(1999);
    expect(img.height).toBeLessThanOrEqual(1999);
  });

  it('defaults to top when region is omitted', async () => {
    const result = await cropPageStrip(testBuffer);
    expect(result).toBeInstanceOf(Buffer);
  });
});
