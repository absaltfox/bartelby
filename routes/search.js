const express = require('express');
const router = express.Router();
const { transcriptsAsync } = require('../database/db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

router.get('/', async (req, res) => {
  const query = req.query.q || '';
  let results = [];

  if (query.trim()) {
    try {
      const opts = {
        userId: req.user.id,
        isAdmin: req.user.role === 'admin',
        accessAll: !!req.user.access_all
      };
      results = await transcriptsAsync.search(query, 50, opts);
    } catch (err) {
      console.error('Search error:', err);
    }
  }

  res.render('search', { query, results, resultCount: results.length });
});

module.exports = router;
