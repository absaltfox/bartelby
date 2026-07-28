'use strict';

/**
 * The document page used to load the ~89KB graph bundle unconditionally, and
 * the bundle self-initializes by fetching /graph/documents/:id/entities — for
 * a tab that starts hidden. Both are now deferred to first activation of the
 * Graph tab.
 *
 * Motivated by the 2026-07-27 front-end performance review
 * (docs/reviews/2026-07-27-front-end-performance-review.md, finding P18).
 */

const { test, expect } = require('@playwright/test');

const PUBLIC_DOCUMENT_TITLE = 'Playwright Public Reader Document';

/** Finds the world-public seeded document without needing its id up front. */
async function gotoPublicDocument(page) {
  await page.goto('/');
  const link = page.getByRole('link', { name: new RegExp(PUBLIC_DOCUMENT_TITLE, 'i') }).first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.locator('#document-detail')).toBeVisible();
}

test('the graph bundle and its request are deferred to first Graph-tab activation', async ({ page }) => {
  const graphRequests = [];
  const bundleRequests = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/\/graph\/documents\/\d+\/entities/.test(url)) graphRequests.push(url);
    if (/\/js\/graph-explorer\.js/.test(url)) bundleRequests.push(url);
  });

  await gotoPublicDocument(page);
  await page.waitForLoadState('networkidle');

  expect(bundleRequests).toHaveLength(0);
  expect(graphRequests).toHaveLength(0);

  const graphTab = page.locator('.doc-tab[data-tab="knowledge"]');
  await expect(graphTab).toBeVisible();
  await graphTab.click();

  await expect.poll(() => graphRequests.length, { timeout: 10_000 }).toBe(1);
  expect(bundleRequests).toHaveLength(1);
  await expect(page.locator('#tab-knowledge')).toHaveClass(/active/);

  // Switching away and back must not re-inject the bundle or refetch.
  await page.locator('.doc-tab[data-tab="info"]').click();
  await graphTab.click();
  await page.waitForTimeout(500);

  expect(bundleRequests).toHaveLength(1);
  expect(graphRequests).toHaveLength(1);
});
