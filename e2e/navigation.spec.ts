import { test, expect } from '@playwright/test';

test('phone tabs and home stay in the linked web-app scope without document navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/dashboard/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/dashboard/api/v1', '');
    const data = path === '/session'
      ? { member: { id: 'fixture-member', householdId: 'fixture-household', displayName: 'Fixture', timezone: 'America/New_York' }, csrfToken: 'synthetic-session-token-for-browser-test' }
      : path === '/assistant/runs' || path === '/assistant/knowledge' || path === '/assistant/knowledge/proposals' ? []
      : path === '/daily-overview'
        ? { state: 'fallback', result: { summary: 'No overview yet.', items: [], questions: [], omittedRefs: [] }, items: [], generatedAt: null, coverage: [], revision: 1 }
        : path === '/daily-ai-settings'
          ? { enabled: false, consentVersion: null, revision: 1, available: false, disclosureVersion: 'daily-assistant-v1' }
      : path === '/source-policy'
        ? { excludedSenders: [], excludedLabels: [], genericAppointmentOptIn: false, revision: 1 }
        : { items: [], plans: [], reminders: [], runs: [], knowledge: [], credentials: [], subscriptions: [], connected: false, enabled: false };
    await route.fulfill({ json: { data } });
  });
  await page.goto('/dashboard/');
  const manifestLink = page.locator('link[rel="manifest"]');
  await expect(manifestLink).toHaveAttribute('href', '/pwa/manifest.webmanifest');
  const response = await page.request.get(await manifestLink.getAttribute('href') as string);
  expect(response.ok()).toBeTruthy();
  const manifest = await response.json() as { scope: string; start_url: string; display: string; short_name: string; icons: { src: string; purpose: string }[] };
  expect(manifest.display).toBe('standalone');
  expect(manifest.short_name).toBe('Fridgedoor');
  expect(manifest.icons.map((icon) => icon.purpose).sort()).toEqual(['any', 'any', 'maskable']);
  const appleIcon = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href') as string;
  for (const src of [...manifest.icons.map((icon) => icon.src), appleIcon]) {
    const icon = await page.request.get(src);
    expect(icon.ok(), src).toBeTruthy();
    expect((await icon.body()).subarray(1, 4).toString()).toBe('PNG');
  }
  expect(manifest.start_url.startsWith(manifest.scope)).toBeTruthy();
  const navigation = page.getByRole('navigation', { name: 'Primary' });
  await expect(navigation).toBeVisible();
  const documents: string[] = [];
  page.on('request', (request) => { if (request.isNavigationRequest()) documents.push(request.url()); });
  for (const tab of ['To do', 'Groceries', 'More', 'Home']) {
    const link = navigation.getByRole('link', { name: tab, exact: true });
    const href = await link.getAttribute('href');
    expect(href?.startsWith(manifest.scope)).toBeTruthy();
    await link.click();
    await expect(link).toHaveAttribute('aria-current', 'page');
    expect(new URL(page.url()).pathname).toBe(href);
  }
  await page.getByRole('link', { name: 'Fridgedoor', exact: true }).click();
  expect(new URL(page.url()).pathname).toBe(manifest.start_url);
  expect(documents).toEqual([]);
});
