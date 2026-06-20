'use strict';

function buildTextDiffSummary(oldText, newText) {
  const oldLines = String(oldText || '').split('\n');
  const newLines = String(newText || '').split('\n');
  const oldLen = oldLines.length;
  const newLen = newLines.length;

  const dp = Array.from({ length: oldLen + 1 }, () => Array(newLen + 1).fill(0));

  for (let i = oldLen - 1; i >= 0; i--) {
    for (let j = newLen - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const addedLines = [];
  const removedLines = [];

  let i = 0;
  let j = 0;

  while (i < oldLen && j < newLen) {
    if (oldLines[i] === newLines[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      if (oldLines[i].trim()) removedLines.push(oldLines[i]);
      i += 1;
    } else {
      if (newLines[j].trim()) addedLines.push(newLines[j]);
      j += 1;
    }
  }

  while (i < oldLen) {
    if (oldLines[i].trim()) removedLines.push(oldLines[i]);
    i += 1;
  }

  while (j < newLen) {
    if (newLines[j].trim()) addedLines.push(newLines[j]);
    j += 1;
  }

  const preview = (lines, max) => {
    if (lines.length === 0) return null;
    return {
      lines: lines.slice(0, max).map(line => line.trim().substring(0, 120)),
      more: Math.max(lines.length - max, 0)
    };
  };

  return {
    addedChars: addedLines.reduce((sum, line) => sum + line.trim().length, 0),
    removedChars: removedLines.reduce((sum, line) => sum + line.trim().length, 0),
    addedLines: addedLines.length,
    removedLines: removedLines.length,
    added: preview(addedLines, 3),
    removed: preview(removedLines, 3)
  };
}

function trimTranscriptSegment(rawText, rawStartOffset) {
  let startOffset = rawStartOffset;
  let text = rawText || '';

  const leadingMatch = text.match(/^\s*\n/);
  if (leadingMatch) {
    startOffset += leadingMatch[0].length;
    text = text.slice(leadingMatch[0].length);
  }

  text = text.replace(/\s+$/, '');

  return {
    text,
    startOffset,
    endOffset: startOffset + text.length
  };
}

function stripPageMarkers(text) {
  return String(text || '')
    .replace(/^\[Page\s+\d+\]\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseStoredPageSegments(pageSegments) {
  if (!pageSegments) return null;

  try {
    const parsed = typeof pageSegments === 'string' ? JSON.parse(pageSegments) : pageSegments;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    return parsed
      .map((segment, index) => ({
        pageNumber: parseInt(segment.pageNumber, 10) || index + 1,
        charLength: Math.max(parseInt(segment.charLength, 10) || 0, 0)
      }))
      .filter(segment => segment.pageNumber > 0);
  } catch (err) {
    return null;
  }
}

function extractPageSegmentsFromMarkedContent(content) {
  const rawContent = String(content || '');
  const markerRegex = /^\[Page\s+(\d+)\]\s*$/gm;
  const markers = [];
  let match;

  while ((match = markerRegex.exec(rawContent)) !== null) {
    markers.push({
      pageNumber: parseInt(match[1], 10),
      markerStart: match.index,
      markerEnd: markerRegex.lastIndex
    });
  }

  if (markers.length === 0) {
    return null;
  }

  return markers.map((marker, index) => {
    const nextMarkerStart = index + 1 < markers.length ? markers[index + 1].markerStart : rawContent.length;
    const rawSegment = rawContent.slice(marker.markerEnd, nextMarkerStart);
    const cleanText = trimTranscriptSegment(rawSegment, 0).text;
    return {
      pageNumber: marker.pageNumber,
      charLength: cleanText.length
    };
  });
}

function findBoundaryNear(text, target) {
  const maxDistance = 120;
  const safeTarget = Math.max(0, Math.min(target, text.length));

  for (let distance = 0; distance <= maxDistance; distance++) {
    const forward = safeTarget + distance;
    if (forward < text.length && text[forward] === '\n') {
      return forward + 1;
    }

    const backward = safeTarget - distance;
    if (backward > 0 && text[backward - 1] === '\n') {
      return backward;
    }
  }

  return safeTarget;
}

function splitTranscriptBySegments(content, segmentHints, pageCount) {
  const cleanContent = String(content || '');
  const pages = Math.max(pageCount || 0, segmentHints ? segmentHints.length : 0, 1);

  if (!segmentHints || segmentHints.length <= 1 || !cleanContent) {
    return [{
      pageNumber: 1,
      text: cleanContent,
      startOffset: 0,
      endOffset: cleanContent.length
    }];
  }

  const totalHintLength = segmentHints.reduce((sum, segment) => sum + Math.max(segment.charLength || 0, 0), 0);
  const effectiveTotal = totalHintLength > 0 ? totalHintLength : segmentHints.length;
  const boundaries = [];
  let runningHintLength = 0;

  for (let index = 0; index < segmentHints.length - 1; index++) {
    runningHintLength += Math.max(segmentHints[index].charLength || 0, 0);
    const proportionalTarget = Math.round((runningHintLength / effectiveTotal) * cleanContent.length);
    const snapped = findBoundaryNear(cleanContent, proportionalTarget);
    const previousBoundary = boundaries.length > 0 ? boundaries[boundaries.length - 1] : 0;
    boundaries.push(Math.max(previousBoundary, Math.min(snapped, cleanContent.length)));
  }

  const segments = [];
  let start = 0;

  for (let index = 0; index < pages; index++) {
    const end = index < boundaries.length ? boundaries[index] : cleanContent.length;
    const trimmed = trimTranscriptSegment(cleanContent.slice(start, end), start);
    segments.push({
      pageNumber: index + 1,
      text: trimmed.text,
      startOffset: trimmed.startOffset,
      endOffset: trimmed.endOffset
    });
    start = end;
  }

  return segments;
}

function getTranscriptPageSegments(transcript, pageCount) {
  const storedSegments = parseStoredPageSegments(transcript && transcript.page_segments);
  if (storedSegments && storedSegments.length > 0) {
    return storedSegments;
  }

  const markerSegments = extractPageSegmentsFromMarkedContent(transcript && transcript.content);
  if (markerSegments && markerSegments.length > 0) {
    return markerSegments;
  }

  if (pageCount > 1) {
    return Array.from({ length: pageCount }, function(_, index) {
      return { pageNumber: index + 1, charLength: 0 };
    });
  }

  return null;
}

function buildComparisonPages(document, transcript) {
  const metadata = document && document.metadata ? document.metadata : {};
  const imagePaths = [document && document.image_path]
    .concat(Array.isArray(metadata.additional_pages) ? metadata.additional_pages : [])
    .filter(Boolean);

  const cleanContent = stripPageMarkers((transcript && transcript.content) || '');

  if (imagePaths.length === 0) {
    return [{
      pageNumber: 1,
      imagePath: null,
      transcriptText: cleanContent,
      startOffset: 0,
      endOffset: cleanContent.length
    }];
  }

  const segments = splitTranscriptBySegments(
    cleanContent,
    getTranscriptPageSegments(transcript, imagePaths.length),
    imagePaths.length
  );
  const pageMap = new Map(segments.map((segment) => [segment.pageNumber, segment]));

  return imagePaths.map((imagePath, index) => {
    const pageNumber = index + 1;
    const segment = pageMap.get(pageNumber) || {
      text: '',
      startOffset: 0,
      endOffset: 0
    };

    return {
      pageNumber,
      imagePath,
      transcriptText: segment.text,
      startOffset: segment.startOffset,
      endOffset: segment.endOffset
    };
  });
}

module.exports = {
  buildTextDiffSummary,
  trimTranscriptSegment,
  stripPageMarkers,
  parseStoredPageSegments,
  extractPageSegmentsFromMarkedContent,
  findBoundaryNear,
  splitTranscriptBySegments,
  getTranscriptPageSegments,
  buildComparisonPages
};
