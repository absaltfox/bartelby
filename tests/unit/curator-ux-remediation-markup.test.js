'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('Curator UX remediation markup', () => {
  const templates = [
    'views/admin/entity-detail.ejs',
    'views/admin/entity-edit.ejs',
    'views/admin/entity-split.ejs',
    'views/admin/sentiment-phrase-targets.ejs',
    'views/admin/relationship-new.ejs',
    'views/partials/transcript-span-picker.ejs'
  ];

  it('does not introduce inline styles or inline event handlers', () => {
    templates.forEach((templatePath) => {
      const source = read(templatePath);
      expect(source).not.toMatch(/\sstyle="/);
      expect(source).not.toMatch(/\son[a-z]+="/);
    });
  });

  it('uses dedicated correction workspace templates for entity edit and split', () => {
    const edit = read('views/admin/entity-edit.ejs');
    const split = read('views/admin/entity-split.ejs');

    expect(edit).toContain('admin-page--workspace');
    expect(edit).toContain('correction-workspace');
    expect(edit).toContain('Changing entity type may unlink this entity');
    expect(split).toContain('admin-page--workspace');
    expect(split).toContain('correction-workspace');
    expect(split).toContain('Nothing moves unless selected');
  });

  it('uses table-row expansion for phrase target promotion instead of clipped dropdown menus', () => {
    const source = read('views/admin/sentiment-phrase-targets.ejs');

    expect(source).toContain('phrase-target-expansion-row');
    expect(source).toContain('phrase-target-action-grid');
    expect(source).not.toContain('toolbar-details-menu');
  });
});
