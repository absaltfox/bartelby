const express = require('express');
const router = express.Router();
const { transcriptsAsync, annotationsAsync, documentsAsync } = require('../database/db');
const { requireAuth } = require('../middleware/auth');

// All transcript routes require authentication
router.use(requireAuth);

// Get transcript with annotations (for AJAX loading)
router.get('/:id', async (req, res) => {
  const transcript = await transcriptsAsync.getById(req.params.id);

  if (!transcript) {
    return res.status(404).json({ error: 'Transcript not found' });
  }

  // Verify document-level access
  const isAdmin = req.user.role === 'admin';
  const accessAll = !!req.user.access_all;
  if (!(await documentsAsync.canAccess(transcript.document_id, req.user.id, isAdmin, accessAll))) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const transcriptAnnotations = await annotationsAsync.getByTranscriptId(transcript.id);

  res.json({
    transcript,
    annotations: transcriptAnnotations
  });
});

module.exports = router;
