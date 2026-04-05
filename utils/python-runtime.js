'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

function resolvePythonBin() {
  if (process.env.PYTHON_BIN) {
    return process.env.PYTHON_BIN;
  }

  const candidates = [
    path.join(config.app.rootDir, '.venv', 'bin', 'python3'),
    path.join(config.app.rootDir, '.venv', 'bin', 'python')
  ];

  const localVenvPython = candidates.find((candidate) => fs.existsSync(candidate));
  return localVenvPython || 'python3';
}

module.exports = {
  resolvePythonBin
};
