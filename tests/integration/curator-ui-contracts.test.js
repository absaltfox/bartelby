'use strict';

const {
  bootCuratorApp,
  createAdminAgent,
  createStandardUserAgent,
  fetchParsed,
  seedCuratorGraphFixture,
  expectAdminNavigationDominates,
  expectCuratorConsequences,
  expectKnowledgeWorkbenchRail
} = require('../helpers/curator-ui');

describe('agent-agnostic curator UI contracts', () => {
  let app;
  let db;
  let adminAgent;
  let viewerAgent;
  let fixture;

  beforeAll(async () => {
    ({ app, db } = await bootCuratorApp());
    adminAgent = await createAdminAgent(app);
    viewerAgent = await createStandardUserAgent(app, db);
    fixture = await seedCuratorGraphFixture(db);
  }, 60_000);

  it('renders the Knowledge workbench by curator job without hiding the admin hierarchy', async () => {
    const { $ } = await fetchParsed(adminAgent, '/admin/knowledge');

    expect($('h1').first().text()).toContain('Knowledge');
    expectAdminNavigationDominates($);
    expectKnowledgeWorkbenchRail($);
    expect($('.knowledge-workbench-link[aria-current="page"]').text()).toContain('Overview');
  });

  it('renders review evidence with context, CSRF, concrete consequences, and bulk semantics', async () => {
    const { $ } = await fetchParsed(adminAgent, '/admin/knowledge/review-extractions');

    const card = $(`[data-review-card][data-citation-id="${fixture.citationId}"]`);
    expect(card.length).toBe(1);
    expect(card.text()).toContain('Ada Lovelace appears in the curator UX evidence passage');
    expect(card.find('[data-review-action-form][data-review-action="approve"] input[name="_csrf"]').length).toBe(1);
    expect(card.find('[data-review-action-form][data-review-action="reject"] input[name="_csrf"]').length).toBe(1);
    expect(card.find('[data-review-action-form][data-review-action="delete"] input[name="_csrf"]').length).toBe(1);
    expectCuratorConsequences($);

    expect($('#review-bulk-bar').length).toBe(1);
    expect($('#review-bulk-consequence').text()).toContain('Approve makes evidence eligible for graph views');
    expect($('#review-extractions-config').html()).toContain('/admin/knowledge/review-extractions/bulk/approve');
  });

  it('keeps correction and manual authoring workflows reachable without relying on LLM output', async () => {
    const detail = await fetchParsed(adminAgent, `/admin/knowledge/entities/${fixture.entityId}`);
    // entity-detail was redesigned: actions live in the end-of-record cluster
    // (entity-detail__record-actions). See docs/ui-template-standards.md
    // § Entity detail — actions after context.
    expect(detail.$('[aria-labelledby="entity-record-actions-correct"]').text()).toContain('Edit entity');
    expect(detail.$('[aria-labelledby="entity-record-actions-author"]').text()).toContain('Add relationship');
    expect(detail.$('.entity-detail__record-actions-note').text()).toContain('Edit preserves evidence');

    const edit = await fetchParsed(adminAgent, `/admin/knowledge/entities/${fixture.entityId}/edit`);
    expect(edit.$('.correction-workspace').length).toBeGreaterThan(0);
    expect(edit.$('form[action$="/edit"] input[name="_csrf"]').length).toBe(1);

    const split = await fetchParsed(adminAgent, `/admin/knowledge/entities/${fixture.entityId}/split`);
    expect(split.$('.correction-workspace').length).toBeGreaterThan(0);
    expect(split.$.text()).toContain('Nothing moves unless selected');

    const entityNew = await fetchParsed(adminAgent, '/admin/knowledge/entities/new');
    expect(entityNew.$('form.entity-new-form').length).toBe(1);
    expect(entityNew.$.text()).toContain('Author an entity from scratch with a transcript citation.');

    const relationshipNew = await fetchParsed(adminAgent, `/admin/knowledge/relationships/new?sourceEntityId=${fixture.entityId}`);
    expect(relationshipNew.$('form.relationship-new-form').length).toBe(1);
    expect(relationshipNew.$.text()).toContain('Source entity');
  });

  it('exposes enough authority and vocabulary context for curator judgment', async () => {
    const suggestions = await fetchParsed(adminAgent, '/admin/knowledge/authorities/suggestions');
    expect(suggestions.$('.authority-disambiguation-group').length).toBeGreaterThan(0);
    expect(suggestions.$.text()).toContain('Disambiguation required');
    expect(suggestions.$.text()).toContain('candidate authorities');
    expect(suggestions.$.text()).toContain('Approve selected (cascade-rejects siblings)');

    const vocabulary = await fetchParsed(adminAgent, '/admin/knowledge/vocabularies/relationship-types');
    expect(vocabulary.$('h1').text()).toContain('Relationship Vocabulary');
    expect(vocabulary.$('datalist#rel-categories').length).toBe(1);
    expect(vocabulary.$('form[action="/admin/knowledge/vocabularies/relationship-types"] input[name="_csrf"]').length).toBe(1);
    expect(vocabulary.$.text()).toContain('Curator-managed controlled vocabulary');
  });

  it('does not expose curator-only Knowledge affordances to non-admin users', async () => {
    const res = await viewerAgent.get('/admin/knowledge');
    expect(res.status).toBe(403);

    const $ = require('../helpers/curator-ui').parseHtml(res.text);
    expect($.text()).toContain('Admin access required.');
    expect($('.knowledge-workbench-rail').length).toBe(0);
    expect($('[data-review-action-form]').length).toBe(0);
  });
});
