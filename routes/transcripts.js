const express = require('express');
const router = express.Router();
const { transcripts, annotations } = require('../database/db');

// Get transcript with annotations (for AJAX loading)
router.get('/:id', (req, res) => {
  const transcript = transcripts.getById(req.params.id);

  if (!transcript) {
    return res.status(404).json({ error: 'Transcript not found' });
  }

  const transcriptAnnotations = annotations.getByTranscriptId(transcript.id);

  res.json({
    transcript,
    annotations: transcriptAnnotations
  });
});

module.exports = router;
