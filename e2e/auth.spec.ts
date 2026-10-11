import { test, expect } from '@playwright/test';

test('dashboard deep link sends a signed-out visitor to sign-in without private data', async ({ page }) => {
  await page.route('**/dashboard/api/v1/session', async (route) => route.fulfill({ status: 401, contentType: 'text/html', body: '<html>Proxy login</html>' }));
  await page.route('**/dashboard/api/v1/auth/status', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { setupRequired: false, accessMode: false, publicUrl: 'http://127.0.0.1:4173' } }) }));
  await page.goto('/dashboard/plans');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard\/login$/);
  await expect(page.getByText(/Proxy login/)).not.toBeVisible();
});

test('a fresh server without the setup link explains where to find it', async ({ page }) => {
  await page.route('**/dashboard/api/v1/session', async (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Sign in required', requestId: 'r' } }) }));
  await page.route('**/dashboard/api/v1/auth/status', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { setupRequired: true, accessMode: false, publicUrl: 'http://127.0.0.1:4173' } }) }));
  await page.goto('/dashboard/');
  await expect(page.getByRole('heading', { name: 'Open your setup link' })).toBeVisible();
  await expect(page.getByText('fridgedoor setup-link')).toBeVisible();
});
