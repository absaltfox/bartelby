const express = require('express');
const router = express.Router();
const {
  annotationsAsync,
  transcriptsAsync,
  documentEventsAsync,
  documentsAsync
} = require('../database/db');
const { asyncHandler } = require('../utils/async-handler');

async function loadAccessibleTranscript(req, transcriptId) {
  const transcript = await transcriptsAsync.getById(transcriptId);
  if (!transcript) return { transcript: null, accessDenied: false };

  const canAccess = await documentsAsync.canAccess(
    transcript.document_id,
    req.user?.id || null,
    req.user?.role === 'admin',
    !!req.user?.access_all
  );

  return {
    transcript,
    accessDenied: !canAccess
  };
}

// Create annotation
router.post('/', asyncHandler(async (req, res) => {
  const { transcript_id, content, position_start, position_end } = req.body;

  if (!transcript_id || !content) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const tid = parseInt(transcript_id, 10);
  if (!Number.isInteger(tid)) {
    return res.status(400).json({ error: 'Invalid transcript id.' });
  }

  const { transcript, accessDenied } = await loadAccessibleTranscript(req, tid);
  if (!transcript) {
    return res.status(404).json({ error: 'Transcript not found' });
  }
  if (accessDenied) {
    return res.status(403).json({ error: 'You do not have access to that transcript.' });
  }

  const id = await annotationsAsync.create({
    transcript_id: tid,
    user_name: req.user.username,
    content,
    position_start: position_start ? parseInt(position_start, 10) : null,
    position_end: position_end ? parseInt(position_end, 10) : null
  });

  await documentEventsAsync.log(transcript.document_id, req.user.id, req.user.username, 'annotation_added', {
    annotation_id: id,
    transcript_id: tid,
    transcript_version: transcript.version
  });

  res.status(201).json({ id, message: 'Annotation created successfully' });
}));
// Delete annotation — only the author or an admin can delete
router.delete('/:id', asyncHandler(async (req, res) => {
  const annotation = await annotationsAsync.getById(parseInt(req.params.id, 10));
  if (!annotation) {
    return res.status(404).json({ error: 'Annotation not found' });
  }

  const { transcript, accessDenied } = await loadAccessibleTranscript(req, annotation.transcript_id);
  if (!transcript) {
    return res.status(404).json({ error: 'Annotation not found' });
  }
  if (accessDenied) {
    return res.status(403).json({ error: 'You do not have access to that annotation.' });
  }

  if (annotation.user_name !== req.user.username && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You can only delete your own annotations' });
  }

  await documentEventsAsync.log(transcript.document_id, req.user.id, req.user.username, 'annotation_deleted', {
    annotation_id: annotation.id,
    transcript_id: annotation.transcript_id,
    transcript_version: transcript.version
  });

  await annotationsAsync.delete(annotation.id);
  res.json({ message: 'Annotation deleted successfully' });
}));

module.exports = router;
