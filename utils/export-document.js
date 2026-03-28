'use strict';

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// ── PDF Export ──────────────────────────────────────────────────────────────

async function generatePDF(document, transcript) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdf.embedFont(StandardFonts.HelveticaOblique);

  const PAGE_W = 612; // US Letter
  const PAGE_H = 792;
  const MARGIN = 54;  // 0.75 inch
  const CONTENT_W = PAGE_W - MARGIN * 2;
  const LINE_HEIGHT = 14;
  const FONT_SIZE = 10;
  const HEADING_SIZE = 16;
  const META_SIZE = 9;

  const darkGray = rgb(0.2, 0.2, 0.2);
  const midGray = rgb(0.45, 0.45, 0.45);
  const lightGray = rgb(0.75, 0.75, 0.75);

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  function ensureSpace(needed) {
    if (y - needed < MARGIN) {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  }

  function drawText(text, opts = {}) {
    const f = opts.font || font;
    const size = opts.size || FONT_SIZE;
    const color = opts.color || darkGray;
    ensureSpace(size + 4);
    page.drawText(text, { x: opts.x || MARGIN, y, font: f, size, color });
    y -= (opts.lineHeight || LINE_HEIGHT);
  }

  // Wrap text to fit within content width, returns array of lines
  function wrapText(text, f, size) {
    const words = text.split(/\s+/);
    const lines = [];
    let currentLine = '';
    for (const word of words) {
      const test = currentLine ? currentLine + ' ' + word : word;
      const width = f.widthOfTextAtSize(test, size);
      if (width > CONTENT_W && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = test;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
  }

  // ── Title ──
  const titleLines = wrapText(document.title || 'Untitled Document', fontBold, HEADING_SIZE);
  for (const line of titleLines) {
    drawText(line, { font: fontBold, size: HEADING_SIZE, lineHeight: HEADING_SIZE + 4 });
  }
  y -= 8;

  // ── Metadata ──
  const metadata = parseMetadata(document.metadata);
  const metaFields = [];

  if (document.date_created) metaFields.push(['Date', document.date_created]);
  if (document.description) metaFields.push(['Description', document.description]);
  if (metadata.author) metaFields.push(['Author', metadata.author]);
  if (metadata.location) metaFields.push(['Location', metadata.location]);
  if (metadata.document_type) metaFields.push(['Type', metadata.document_type]);
  if (metadata.language) metaFields.push(['Language', metadata.language]);
  if (metadata.source) metaFields.push(['Source', metadata.source]);

  // Include any remaining metadata keys not already shown
  const knownKeys = new Set(['author', 'location', 'document_type', 'language', 'source', 'additional_pages']);
  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      if (!knownKeys.has(key) && value && typeof value === 'string') {
        metaFields.push([formatKey(key), value]);
      }
    }
  }

  if (metaFields.length > 0) {
    for (const [label, value] of metaFields) {
      const labelWidth = fontBold.widthOfTextAtSize(label + ': ', META_SIZE);
      ensureSpace(META_SIZE + 4);
      page.drawText(label + ': ', { x: MARGIN, y, font: fontBold, size: META_SIZE, color: midGray });
      const valLines = wrapText(value, font, META_SIZE);
      for (let i = 0; i < valLines.length; i++) {
        page.drawText(valLines[i], {
          x: i === 0 ? MARGIN + labelWidth : MARGIN,
          y, font, size: META_SIZE, color: darkGray
        });
        y -= (META_SIZE + 3);
      }
    }
    y -= 6;
  }

  // ── Separator ──
  ensureSpace(12);
  page.drawLine({
    start: { x: MARGIN, y: y + 4 },
    end: { x: PAGE_W - MARGIN, y: y + 4 },
    thickness: 0.5,
    color: lightGray
  });
  y -= 12;

  // ── Transcript header ──
  if (transcript) {
    drawText('Transcript', { font: fontBold, size: 12, lineHeight: 18 });
    if (transcript.transcriber) {
      drawText('Transcribed by: ' + transcript.transcriber, { font: fontItalic, size: META_SIZE, color: midGray, lineHeight: META_SIZE + 6 });
    }
    y -= 4;

    // ── Transcript content ──
    const paragraphs = (transcript.content || '').split(/\n\n+/);
    for (const para of paragraphs) {
      const lines = para.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const wrapped = wrapText(line, font, FONT_SIZE);
        for (const wl of wrapped) {
          ensureSpace(LINE_HEIGHT);
          page.drawText(wl, { x: MARGIN, y, font, size: FONT_SIZE, color: darkGray });
          y -= LINE_HEIGHT;
        }
      }
      y -= 6; // paragraph spacing
    }
  } else {
    drawText('No transcript available.', { font: fontItalic, size: FONT_SIZE, color: midGray });
  }

  // ── Footer on each page ──
  const pages = pdf.getPages();
  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const footerText = `Exported ${now}`;
    const pageNum = `Page ${i + 1} of ${pages.length}`;
    p.drawText(footerText, { x: MARGIN, y: 30, font, size: 8, color: lightGray });
    const pageNumWidth = font.widthOfTextAtSize(pageNum, 8);
    p.drawText(pageNum, { x: PAGE_W - MARGIN - pageNumWidth, y: 30, font, size: 8, color: lightGray });
  }

  return await pdf.save();
}

// ── TEI XML Export ──────────────────────────────────────────────────────────

function generateTEI(document, transcript) {
  const metadata = parseMetadata(document.metadata);

  const esc = (s) => s ? String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;') : '';

  const title = esc(document.title || 'Untitled Document');
  const author = esc(metadata.author || '');
  const dateCreated = esc(document.date_created || '');
  const description = esc(document.description || '');
  const language = esc(metadata.language || 'en');
  const location = esc(metadata.location || '');
  const docType = esc(metadata.document_type || '');
  const source = esc(metadata.source || '');
  const transcriber = transcript ? esc(transcript.transcriber || '') : '';
  const exportDate = new Date().toISOString().split('T')[0];

  // Build source description
  let sourceDescParts = [];
  if (description) sourceDescParts.push(`<p>${description}</p>`);
  if (docType) sourceDescParts.push(`<p>Document type: ${docType}</p>`);
  if (location) sourceDescParts.push(`<p>Location: ${location}</p>`);
  if (source) sourceDescParts.push(`<p>Source: ${source}</p>`);
  if (sourceDescParts.length === 0) sourceDescParts.push('<p>Transcribed document</p>');

  // Build body paragraphs from transcript content
  let bodyContent = '';
  if (transcript && transcript.content) {
    const paragraphs = transcript.content.split(/\n\n+/);
    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;

      // Check for page markers like [Page 1]
      const pageMatch = trimmed.match(/^\[Page\s+(\d+)\]$/);
      if (pageMatch) {
        bodyContent += `        <pb n="${esc(pageMatch[1])}"/>\n`;
        continue;
      }

      // Handle line breaks within a paragraph
      const lines = trimmed.split('\n').map(l => esc(l.trim())).filter(Boolean);
      if (lines.length === 1) {
        bodyContent += `        <p>${lines[0]}</p>\n`;
      } else {
        bodyContent += `        <p>\n`;
        bodyContent += lines.map((l, i) => {
          return i < lines.length - 1
            ? `          ${l}<lb/>\n`
            : `          ${l}\n`;
        }).join('');
        bodyContent += `        </p>\n`;
      }
    }
  } else {
    bodyContent = '        <p>[No transcript available]</p>\n';
  }

  // Include any additional metadata as <note> elements
  let notesXml = '';
  if (transcript && transcript.notes) {
    notesXml += `\n          <note type="transcription">${esc(transcript.notes)}</note>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<?xml-model href="http://www.tei-c.org/release/xml/tei/custom/schema/relaxng/tei_all.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>${title}</title>${author ? `\n        <author>${author}</author>` : ''}
      </titleStmt>
      <publicationStmt>
        <publisher>Bartelby Document Transcription</publisher>
        <date when="${exportDate}">${exportDate}</date>
        <availability>
          <p>Exported from Bartelby</p>
        </availability>
      </publicationStmt>
      <sourceDesc>
        ${sourceDescParts.join('\n        ')}
      </sourceDesc>
    </fileDesc>
    <profileDesc>${dateCreated ? `\n      <creation><date>${dateCreated}</date></creation>` : ''}
      <langUsage>
        <language ident="${language}">${language}</language>
      </langUsage>
    </profileDesc>
    <revisionDesc>
      <change when="${exportDate}">Exported from Bartelby${transcriber ? ` (transcribed by ${transcriber})` : ''}</change>
    </revisionDesc>${notesXml ? `\n    <notesStmt>${notesXml}\n    </notesStmt>` : ''}
  </teiHeader>
  <text>
    <body>
      <div>
${bodyContent}      </div>
    </body>
  </text>
</TEI>
`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function formatKey(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

module.exports = { generatePDF, generateTEI };
