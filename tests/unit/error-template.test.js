'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

describe('error template rendering', () => {
  it('renders without application settings locals', () => {
    const templatePath = path.join(__dirname, '../../views/error.ejs');
    const template = fs.readFileSync(templatePath, 'utf8');

    const render = () => ejs.render(template, {
      message: 'Something went wrong!',
      error: {}
    }, {
      filename: templatePath
    });

    expect(render).not.toThrow();
    expect(render()).toContain('<title>Error — Bartelby</title>');
  });
});
