'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('Curator UX remediation markup', () => {
  const templates = [
    'views/partials/knowledge-nav.ejs',
    'views/partials/document-create-entity-link.ejs',
    'views/partials/document-info-panel.ejs',
    'views/partials/collection-hero.ejs',
    'views/admin/authority-backfill.ejs',
    'views/admin/entity-detail.ejs',
    'views/admin/entity-edit.ejs',
    'views/admin/entity-split.ejs',
    'views/admin/review-extractions.ejs',
    'views/admin/sentiment-clusters.ejs',
    'views/admin/sentiment-review.ejs',
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

  it('groups every knowledge route exactly once in the workbench rail', () => {
    const source = read('views/partials/knowledge-nav.ejs');
    const hrefs = [
      '/admin/knowledge',
      '/admin/knowledge/review-extractions',
      '/admin/knowledge/authorities/suggestions',
      '/admin/knowledge/sentiment/review',
      '/admin/knowledge/entities',
      '/admin/knowledge/entities/merge',
      '/admin/knowledge/authorities',
      '/admin/knowledge/sentiment/phrase-targets',
      '/admin/knowledge/authorities/generic-terms',
      '/admin/knowledge/sentiment/clusters',
      '/admin/knowledge/vocabularies/relationship-types',
      '/admin/knowledge/authorities/backfill'
    ];

    ['Overview', 'Review', 'Correct', 'Reconcile', 'Maintain'].forEach((label) => {
      expect(source).toContain(`label: '${label}'`);
    });

    hrefs.forEach((href) => {
      const needle = `href: '${href}'`;
      const matches = source.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || [];
      expect(matches).toHaveLength(1);
    });

    expect(source).not.toMatch(/<h2 class="knowledge-workbench-group-title"/);
    expect(source).toMatch(/<p class="knowledge-workbench-group-title"/);
    expect(source).toMatch(/aria-labelledby="knowledge-workbench-/);
  });

  it('keeps curator consequences next to high-impact actions', () => {
    const review = read('views/admin/review-extractions.ejs');
    const entity = read('views/admin/entity-detail.ejs');

    expect(review).toContain('Makes this evidence eligible for visible graph views.');
    expect(review).toContain('Hides evidence from graph views but keeps review history.');
    expect(review).toContain('Removes the citation evidence record.');
    expect(entity).toContain('Edit preserves evidence; split moves only selected evidence; merge consolidates records.');
    expect(entity).toContain('curator-action-toolbar');
    expect(entity).toContain('Navigate');
    expect(entity).toContain('Correct');
    expect(entity).toContain('Author');
    expect(entity).toMatch(/<section class="curator-action-group[^"]*" aria-labelledby="curator-action-navigate"/);
    expect(entity).toMatch(/<section class="curator-action-group[^"]*" aria-labelledby="curator-action-correct"/);
    expect(entity).toMatch(/<section class="curator-action-group[^"]*" aria-labelledby="curator-action-author"/);
    expect(entity).toMatch(/<p class="curator-action-group-label" id="curator-action-navigate">/);
    expect(entity).toMatch(/<p class="curator-action-group-label" id="curator-action-correct">/);
    expect(entity).toMatch(/<p class="curator-action-group-label" id="curator-action-author">/);
  });

  it('renders document metadata via a single shared partial in both layout branches', () => {
    const panel = read('views/partials/document-info-panel.ejs');
    const includes = panel.match(/include\('document-metadata-section'/g) || [];
    expect(includes.length).toBe(2);
    expect(panel).not.toMatch(/id="metadata-edit-form"/);
    expect(panel).not.toMatch(/id="doc-info-edit"/);
    expect(panel).not.toMatch(/id="doc-info-view"/);

    const partial = read('views/partials/document-metadata-section.ejs');
    expect(partial).toMatch(/id="metadata-edit-form"/);
    expect(partial).toMatch(/id="doc-info-edit"/);
    expect(partial).toMatch(/id="doc-info-view"/);
  });

  it('uses text-first document and compact transcript action patterns', () => {
    const documentPanel = read('views/partials/document-info-panel.ejs');
    const createLink = read('views/partials/document-create-entity-link.ejs');
    const collectionHero = read('views/partials/collection-hero.ejs');

    expect(documentPanel).toContain('side-by-side--text-first');
    expect(documentPanel).toContain('document-text-first-metadata');
    expect(createLink).toContain('document-create-action-group');
    expect(createLink).toContain("No passage selected; you'll choose evidence on the next page.");
    expect(collectionHero).not.toContain('No description yet.');
  });

  it('renders aria-current as a real attribute, not an escaped string', () => {
    const source = read('views/partials/knowledge-nav.ejs');
    expect(source).not.toMatch(/<%=\s*activeKnowledgePage === item\.key \? 'aria-current="page"'/);
    expect(source).toMatch(/<% if \(activeKnowledgePage === item\.key\) \{ %>aria-current="page"<% \} %>/);
  });

  it('mounts the knowledge workbench rail as a direct child of .admin-page--workspace', () => {
    const adminDir = path.join(ROOT, 'views', 'admin');
    const files = fs.readdirSync(adminDir).filter((name) => name.endsWith('.ejs'));
    const offenders = [];

    files.forEach((name) => {
      const source = fs.readFileSync(path.join(adminDir, name), 'utf8');
      const includeRe = /<%[-=]\s*include\(\s*'\.\.\/partials\/knowledge-nav'/;
      const match = source.match(includeRe);
      if (!match) return;

      const includeOffset = match.index;
      const before = source.slice(0, includeOffset);
      const lastWorkspaceOpen = before.lastIndexOf('admin-page--workspace');
      if (lastWorkspaceOpen === -1) {
        offenders.push(`${name}: knowledge-nav include has no .admin-page--workspace wrapper before it`);
        return;
      }
      const between = before.slice(lastWorkspaceOpen);
      const openTagEnd = between.indexOf('>');
      const inside = between.slice(openTagEnd + 1);
      const opens = (inside.match(/<div\b/g) || []).length;
      const closes = (inside.match(/<\/div>/g) || []).length;
      if (closes > opens) {
        offenders.push(`${name}: knowledge-nav include is outside the admin-page--workspace wrapper`);
      }
    });

    expect(offenders).toEqual([]);
  });
});
