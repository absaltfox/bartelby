const express = require('express');
const router = express.Router();
const { annotations } = require('../database/db');

// Create annotation
router.post('/', (req, res) => {
  const { transcript_id, content, position_start, position_end } = req.body;

  if (!transcript_id || !content) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Use authenticated user's username, not client-supplied value
    const id = annotations.create({
      transcript_id: parseInt(transcript_id, 10),
      user_name: req.user.username,
      content,
      position_start: position_start ? parseInt(position_start, 10) : null,
      position_end: position_end ? parseInt(position_end, 10) : null
    });

    res.status(201).json({ id, message: 'Annotation created successfully' });
  } catch (err) {
    console.error('Error creating annotation:', err);
    res.status(500).json({ error: 'Failed to create annotation' });
  }
});

// Delete annotation — only the author or an admin can delete
router.delete('/:id', (req, res) => {
  try {
    const annotation = annotations.getById(parseInt(req.params.id, 10));
    if (!annotation) {
      return res.status(404).json({ error: 'Annotation not found' });
    }

    // Authorization: only the author or an admin can delete
    if (annotation.user_name !== req.user.username && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only delete your own annotations' });
    }

    annotations.delete(annotation.id);
    res.json({ message: 'Annotation deleted successfully' });
  } catch (err) {
    console.error('Error deleting annotation:', err);
    res.status(500).json({ error: 'Failed to delete annotation' });
  }
});

module.exports = router;
