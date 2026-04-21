'use strict';

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');

const OUTPUT_DIR = __dirname;

// Two "documents": pages 1-3, then pages 1-2
const pages = [
  { docNum: 1, pageNum: 1 },
  { docNum: 1, pageNum: 2 },
  { docNum: 1, pageNum: 3 },
  { docNum: 2, pageNum: 1 },
  { docNum: 2, pageNum: 2 },
  // An unnumbered page between documents (should be ungrouped)
  { docNum: null, pageNum: null }
];

pages.forEach((page, index) => {
  const width = 400;
  const height = 600;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // White background
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);

  // Body text area (gray)
  ctx.fillStyle = '#eee';
  ctx.fillRect(20, 100, width - 40, height - 120);

  // Stamped page number in top-right corner (like an archival stamp)
  if (page.pageNum !== null) {
    ctx.fillStyle = '#333';
    ctx.font = 'bold 36px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(String(page.pageNum), width - 20, 50);
  }

  const filename = `page-${String(index + 1).padStart(2, '0')}.png`;
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), canvas.toBuffer('image/png'));
  console.log(`Generated ${filename} (doc ${page.docNum}, page ${page.pageNum})`);
});
