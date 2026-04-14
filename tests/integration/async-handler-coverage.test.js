'use strict';

const fs = require('fs');
const path = require('path');

// Every async route handler must be wrapped with asyncHandler.
// A bare `router.METHOD('...', async (req, res) =>` will crash the process
// on unhandled rejection in Express 4.

const routesDir = path.join(__dirname, '../../routes');
const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));

describe('async handler coverage in routes', () => {
  for (const file of files) {
    it(`${file} has no bare async route handlers`, () => {
      const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
      // Match: router.VERB( ... , async (req  — where "asyncHandler" does NOT appear
      // on the same logical line group. Simple heuristic: find all router.VERB lines
      // with async that are not preceded by asyncHandler on the same line.
      const lines = src.split('\n');
      const bare = lines.filter(line =>
        /router\.(get|post|put|delete|patch)\s*\(/.test(line) &&
        /\basync\s*\(/.test(line) &&
        !/asyncHandler/.test(line)
      );
      expect(bare).toEqual([]);
    });
  }
});
