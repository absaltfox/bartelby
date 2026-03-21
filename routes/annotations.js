const express = require('express');
const router = express.Router();
const { annotations } = require('../database/db');

// Create annotation
router.post('/', (req, res) => {
  const { transcript_id, user_name, content, position_start, position_end } = req.body;

  if (!transcript_id || !user_name || !content) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const id = annotations.create({
      transcript_id: parseInt(transcript_id),
      user_name,
      content,
      position_start: position_start ? parseInt(position_start) : null,
      position_end: position_end ? parseInt(position_end) : null
    });

    res.status(201).json({ id, message: 'Annotation created successfully' });
  } catch (err) {
    console.error('Error creating annotation:', err);
    res.status(500).json({ error: 'Failed to create annotation' });
  }
});

// Delete annotation
router.delete('/:id', (req, res) => {
  try {
    const result = annotations.delete(parseInt(req.params.id));

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Annotation not found' });
    }

    res.json({ message: 'Annotation deleted successfully' });
  } catch (err) {
    console.error('Error deleting annotation:', err);
    res.status(500).json({ error: 'Failed to delete annotation' });
  }
});

module.exports = router;
