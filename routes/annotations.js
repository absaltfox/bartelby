const express = require('express');
const router = express.Router();
const { annotationsAsync, transcriptsAsync, documentEventsAsync } = require('../database/db');

// Create annotation
router.post('/', async (req, res) => {
  const { transcript_id, content, position_start, position_end } = req.body;

  if (!transcript_id || !content) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const tid = parseInt(transcript_id, 10);
    // Use authenticated user's username, not client-supplied value
    const id = await annotationsAsync.create({
      transcript_id: tid,
      user_name: req.user.username,
      content,
      position_start: position_start ? parseInt(position_start, 10) : null,
      position_end: position_end ? parseInt(position_end, 10) : null
    });

    // Log event
    const transcript = await transcriptsAsync.getById(tid);
    if (transcript) {
      await documentEventsAsync.log(transcript.document_id, req.user.id, req.user.username, 'annotation_added', {
        annotation_id: id,
        transcript_id: tid,
        transcript_version: transcript.version
      });
    }

    res.status(201).json({ id, message: 'Annotation created successfully' });
  } catch (err) {
    console.error('Error creating annotation:', err);
    res.status(500).json({ error: 'Failed to create annotation' });
  }
});

// Delete annotation — only the author or an admin can delete
router.delete('/:id', async (req, res) => {
  try {
    const annotation = await annotationsAsync.getById(parseInt(req.params.id, 10));
    if (!annotation) {
      return res.status(404).json({ error: 'Annotation not found' });
    }

    // Authorization: only the author or an admin can delete
    if (annotation.user_name !== req.user.username && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only delete your own annotations' });
    }

    // Log event before deleting
    const transcript = await transcriptsAsync.getById(annotation.transcript_id);
    if (transcript) {
      await documentEventsAsync.log(transcript.document_id, req.user.id, req.user.username, 'annotation_deleted', {
        annotation_id: annotation.id,
        transcript_id: annotation.transcript_id,
        transcript_version: transcript.version
      });
    }

    await annotationsAsync.delete(annotation.id);
    res.json({ message: 'Annotation deleted successfully' });
  } catch (err) {
    console.error('Error deleting annotation:', err);
    res.status(500).json({ error: 'Failed to delete annotation' });
  }
});

module.exports = router;
