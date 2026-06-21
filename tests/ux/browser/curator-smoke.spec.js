'use strict';

const { test, expect } = require('@playwright/test');

const USERNAME = 'playwrightadmin';
const PASSWORD = 'pw-abcdefgh99!';
const BOOTSTRAP_TOKEN = process.env.BOOTSTRAP_ADMIN_TOKEN || 'playwright-bootstrap-token';

let sharedPage;
let consoleErrors = [];

function watchConsole(page) {
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(error.message);
  });
}

async function ensureAdmin(page) {
  await page.goto('/setup');
  if (page.url().includes('/setup')) {
    const username = page.getByLabel('Username');
    if (await username.count()) {
      await username.fill(USERNAME);
      await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
      await page.getByLabel('Confirm Password', { exact: true }).fill(PASSWORD);
      await page.locator('#bootstrap_token').fill(BOOTSTRAP_TOKEN);
      await page.getByRole('button', { name: 'Create Administrator' }).click();
      await page.waitForURL(/\/login/);
    }
  }

  await page.goto('/login');
  if (page.url().includes('/login')) {
    const username = page.getByLabel('Username', { exact: true });
    if (!(await username.isVisible({ timeout: 5000 }).catch(() => false))) return;
    await username.fill(USERNAME);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.startsWith('/login')),
      page.getByRole('button', { name: /sign in/i }).click()
    ]);
  }
}

async function seedReviewFixture(request) {
  const res = await request.post('/admin/knowledge/curator-ui-test-seed');
  if (res.status() !== 404) {
    expect(res.ok()).toBeTruthy();
  }
}

test.beforeAll(async ({ browser }) => {
  sharedPage = await browser.newPage();
  watchConsole(sharedPage);
  await ensureAdmin(sharedPage);
});

test.beforeEach(() => {
  consoleErrors = [];
});

test.afterEach(() => {
  expect(consoleErrors).toEqual([]);
});

test.afterAll(async () => {
  if (sharedPage) await sharedPage.close();
});

test('Knowledge workbench is visible and usable', async () => {
  const page = sharedPage;
  await page.goto('/admin/knowledge');

  await expect(page.getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Knowledge workbench' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Entity Evidence Review' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Vocabularies' })).toBeVisible();
});

test('review page exposes stable filter and bulk-selection controls', async () => {
  const page = sharedPage;
  await page.goto('/admin/knowledge/review-extractions');

  await expect(page.getByRole('heading', { name: /Pending review|Approved evidence|Rejected evidence|All evidence states/ })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Extraction review status' })).toBeVisible();
  await expect(page.getByLabel(/Sort review queue/)).toBeVisible();

  const rowCheckbox = page.locator('.review-row-cb').first();
  if (await rowCheckbox.count()) {
    await rowCheckbox.check();
    await expect(page.locator('#review-bulk-bar')).toBeVisible();
    await expect(page.locator('#review-selection-count')).toContainText('1 selected');
  }
});

test('review preview modal has sane focus and close behavior when evidence preview exists', async () => {
  const page = sharedPage;
  await page.goto('/admin/knowledge/review-extractions');

  const trigger = page.locator('[data-review-preview-trigger]').first();
  test.skip(await trigger.count() === 0, 'No previewable review evidence is present in the current fixture.');

  await trigger.click();
  const modal = page.locator('#review-preview-modal');
  await expect(modal).toBeVisible();
  await expect(modal).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('anonymous readers can load world-public document graph tabs', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  watchConsole(page);

  await page.goto('/collections/1');
  await page.getByRole('link', { name: 'Playwright Public Reader Document' }).click();
  await page.getByRole('button', { name: 'Graph' }).click();

  await expect(page.locator('#document-knowledge-graph')).toBeVisible();
  await expect(page.locator('#document-knowledge-graph').getByText('Playwright Public Ada').first()).toBeVisible();
  await expect(page.getByText(/No approved knowledge graph evidence|waiting for approval/)).toHaveCount(0);

  await context.close();
});

test('anonymous readers can use world-public collection graph navigation', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  watchConsole(page);

  await page.goto('/collections/1');
  await expect(page.getByRole('link', { name: 'Graph' })).toBeVisible();
  await page.getByRole('link', { name: 'Graph' }).click();

  await expect(page).toHaveURL(/\/collections\/\d+\/graph/);
  await expect(page.locator('#graph-visual-title')).toBeVisible();
  await expect(page.locator('#graph-entity-list').getByText('Playwright Public Ada').first()).toBeVisible();

  await context.close();
});

test('anonymous private collection graph access redirects instead of serving a blank graph', async ({ request }) => {
  const res = await request.get('/collections/2/graph', { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers().location).toContain('/login');
});
