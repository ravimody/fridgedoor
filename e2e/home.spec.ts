import { test, expect, type Page } from '@playwright/test';
function fixture() {
  const item = { kind: 'event', title: 'Synthetic school fair', quantity: null, start: '2026-09-14T10:00:00-04:00', end: '2026-09-14T12:00:00-04:00', location: 'Example school', notes: 'Bring water' };
  const run = { id: 'run-1', text: 'school fair', state: 'succeeded', createdAt: '2026-09-12T12:00:00Z', captureId: null, result: { reply: 'A school fair is ready.', items: [item], knowledge: [], assumptions: [], followups: ['Would you like a parking reminder?'], sources: ['https://', 'https://example.org/fair', 'javascript:alert(1)'] }, applied: false, planIds: [], reviews: [] as { target: string; state: string; planId: string }[], metrics: null, feedback: null, errorCode: null };
  const data = { reminders: [] as Record<string, unknown>[], runs: [run], plans: [] as Record<string, unknown>[], knowledge: [{ key: 'dietary_preference', value: 'Vegan', revision: 1, provenance: 'legacy', confirmation: 'unconfirmed', validFrom: null, validUntil: null, relationKey: null, archivedAt: null }], knowledgeHistory: [] as Record<string, unknown>[], knowledgeProposals: [] as Record<string, unknown>[], items: [{ id: 'beans', kind: 'grocery', title: 'Beans', completedAt: null as string | null, revision: 1, createdAt: '2026-09-12T12:00:00Z' }], dailySettings: { enabled: true, consentVersion: 'daily-assistant-v1', revision: 1, available: true, disclosureVersion: 'daily-assistant-v1' }, dailyOverview: { state: 'ready', result: { summary: 'Synthetic daily context.', items: [], questions: [], omittedRefs: [] }, items: [{ refs: ['candidate-1'], category: 'today', headline: 'Synthetic school fair', detail: 'Bring water.', priority: 'important', title: 'Synthetic school fair', normalizedTime: null, sourceRefs: ['source-1'], href: null }], generatedAt: '2026-09-14T11:00:00Z', coverage: [], revision: 1 }, clarifications: [] as Record<string, unknown>[], writes: [] as { path: string; body: Record<string, unknown> }[], connected: true, failSubmission: true };
  return data;
}
async function mock(page: Page, data: ReturnType<typeof fixture>) {
  await page.route('**/dashboard/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.split('/v1')[1]!;
    const body = route.request().headers()['content-type']?.includes('application/json') ? route.request().postDataJSON() as Record<string, unknown> | null : null;
    if (route.request().method() !== 'GET' && path !== '/session') data.writes.push({ path, body: body ?? {} });
    if (path.endsWith('/review')) {
      const kept = body?.choice === 'keep';
      data.runs[0]!.reviews = [{ target: 'item:0', state: kept ? 'kept' : 'calendar', planId: 'plan-1' }];
      data.plans = [{ id: 'plan-1', revision: 1, visibility: kept ? 'private' : 'shared', status: kept ? 'proposed' : 'accepted', savedInPlanner: kept, calendarAction: kept ? null : { actionId: 'action-1', state: 'pending' }, facts: { title: data.runs[0]!.result.items[0]!.title, time: { kind: 'timed', start: '2026-09-14T10:00:00-04:00', end: '2026-09-14T12:00:00-04:00', timezone: 'America/New_York' }, unresolvedFields: [] } }];
    }
    if (path === '/reminders' && route.request().method() === 'POST') data.reminders = [{ ...body, id: 'reminder-fixture', revision: 1, state: 'active', title: 'Beans' }];
    if (path === '/reminders/reminder-fixture' && body?.canceled) data.reminders = [];
    if (path === '/captures') return route.fulfill({ status: 202, json: { data: { captureId: 'capture-fixture' } } });
    if (path === '/assistant/runs' && route.request().method() === 'POST') return data.failSubmission ? route.fulfill({ status: 503, json: { error: { code: 'NETWORK' } } }) : route.fulfill({ status: 202, json: { data: { id: 'submitted-run' } } });
    if (path === '/assistant/knowledge' && route.request().method() === 'POST') data.knowledge = [{ ...data.knowledge[0], key: String(body!.key), value: String(body!.value), revision: Number(body?.expectedRevision ?? 0) + 1, provenance: 'user', confirmation: 'confirmed' }];
    if (path.match(/^\/assistant\/knowledge\/proposals\/[^/]+\/(accept|dismiss)$/) && route.request().method() === 'POST') data.knowledgeProposals = [];
    if (path === '/clarifications/clarification-1/answer' && route.request().method() === 'POST') data.clarifications = [{ ...data.clarifications[0], state: 'answered', answer: body?.text, revision: 2 }];
    if (path === '/list-items/beans') data.items[0]!.completedAt = body?.completed ? '2026-09-12T12:00:00Z' : null;
    const value = path === '/session' ? { member: { id: 'fixture', householdId: 'fixture-household', displayName: 'Fixture', timezone: 'America/New_York' }, csrfToken: 'synthetic-session-token-for-phone-test' }
      : path === '/assistant/settings' ? { enabled: true, consent: true }
      : path === '/assistant/runs' ? data.runs
      : path === '/assistant/knowledge' ? data.knowledge
      : path === '/assistant/knowledge/history' ? data.knowledgeHistory
      : path === '/assistant/knowledge/proposals' ? data.knowledgeProposals
      : path === '/plans' ? { plans: data.plans }
      : path === '/reminders' ? { reminders: data.reminders }
      : path === '/connection' ? { status: data.connected ? 'active' : 'disconnected' }
      : path === '/destination' ? data.connected ? { name: 'Household', ownCalendarSelectionId: 'calendar-fixture' } : null
      : path === '/daily-ai-settings' ? data.dailySettings
      : path === '/daily-overview' ? data.dailyOverview
      : path === '/clarifications' ? data.clarifications
      : path === '/list-items/beans' ? data.items[0]
      : { items: path === '/lists/grocery' ? data.items : [] };
    await route.fulfill({ json: { data: value } });
  });
}
test.use({ viewport: { width: 390, height: 844 } });
test('opens the morning overview, answers a durable question, and keeps the answer after reload', async ({ page }) => {
  const data = fixture(); data.runs = []; data.clarifications = [{ id: 'clarification-1', question: 'Who will bring the form?', reason: 'The source does not identify an owner.', sourceRefs: ['source-1'], state: 'open', answer: null, revision: 1, createdAt: '2026-09-14T11:00:00Z', expiresAt: '2026-10-14T11:00:00Z' }];
  await mock(page, data); await page.goto('/dashboard/');
  await expect(page.getByRole('heading', { name: 'Today’s rhythm' })).toBeVisible();
  await expect(page.getByText('Synthetic school fair')).toBeVisible();
  await page.getByLabel('Answer').fill('I will bring it.'); await page.getByRole('button', { name: 'Save answer' }).click();
  await expect(page.getByLabel('Answer')).toHaveCount(0);
  await page.reload(); await expect(page.getByLabel('Answer')).toHaveCount(0);
  expect(data.clarifications[0]).toMatchObject({state:'answered',answer:'I will bring it.'});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
test('approves once without a reminder follow-up, distinguishes pending from confirmed Google changes, and preserves a failed input across tabs', async ({ page }) => {
  const data = fixture(); await mock(page, data);
  await page.goto('/dashboard/');
  await page.getByRole('link',{name:'More',exact:true}).click();
  await page.getByRole('link',{name:'Saved plans & suggestions'}).click();
  const pending = page.locator('.decisions');
  await pending.locator('summary').first().click();
  await pending.locator('.request-card > summary').first().click();
  await pending.getByRole('button', { name: 'Add to household calendar' }).click();
  await expect(pending.getByRole('article').getByRole('status')).toHaveText('Waiting for Google Calendar');
  expect(data.writes.filter((write) => write.path.endsWith('/review'))).toHaveLength(1);
  data.plans[0]!.calendarAction = { actionId: 'action-1', state: 'succeeded' };
  await expect(page.getByText('Nothing waiting right now.')).toBeVisible({ timeout: 10000 });
  await page.getByRole('link',{name:'More',exact:true}).click();
  await page.getByRole('link',{name:'Conversation history',exact:true}).click();
  await page.locator('details > summary').filter({hasText:'Conversation history'}).click();
  await page.locator('.request-card').last().locator('summary').first().click();
  await expect(page.locator('.request-card').last().getByRole('article').getByRole('status')).toHaveText('Added to Google Calendar');
  await page.getByRole('button', { name: 'Ask, add, or share…' }).click();
  await page.getByLabel('Message or recipe link').fill('Do not lose this text');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('did not complete');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('navigation').getByRole('link', { name: 'Groceries' }).click();
  await page.getByRole('checkbox', { name: 'Beans' }).click();
  await expect(page.getByRole('checkbox', { name: 'Beans' })).toHaveCount(0);
  await page.locator('.completed-list > summary').click();
  await expect(page.locator('.completed-list').getByText('Beans', { exact: true })).toBeVisible();
  await page.getByRole('link',{name:'More',exact:true}).click();
  await page.getByRole('link',{name:'Household knowledge',exact:true}).click();
  await page.getByLabel('Search knowledge').fill('vegan');
  await expect(page.getByText('Vegan', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Details', exact: true }).fill('Vegan; no dairy');
  await page.getByRole('button', { name: 'Save fact' }).click();
  await expect(page.getByText('Vegan; no dairy', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Ask, add, or share…' }).click();
  await expect(page.getByLabel('Message or recipe link')).toHaveValue('Do not lose this text');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
test('keeps a plan without Google and keeps a large pending collection compact and reachable', async ({ page }) => {
  const data = fixture(); data.connected = false;
  data.runs = Array.from({ length: 35 }, (_, index) => ({ ...data.runs[0]!, id: `run-${index}`, result: { ...data.runs[0]!.result, items: [{ ...data.runs[0]!.result.items[0]!, title: `Synthetic fair ${index}` }] } }));
  await mock(page, data); await page.goto('/dashboard/');
  await page.getByRole('link',{name:'More',exact:true}).click();
  await page.getByRole('link',{name:'Saved plans & suggestions'}).click();
  await page.locator('.decisions > summary').click();
  await expect(page.locator('.decisions > .request-card')).toHaveCount(5);
  await page.getByRole('button', { name: 'Show all 35' }).click();
  await expect(page.locator('.decisions > .request-card')).toHaveCount(35);
  await page.locator('.decisions > .request-card > summary').first().click();
  await expect(page.locator('.decisions').getByRole('link', { name: 'Connect Google' })).toBeVisible();
  await page.locator('.decisions').getByRole('button', { name: 'Keep in planner' }).click();
  expect(data.plans[0]!.savedInPlanner).toBe(true);
  expect(data.plans[0]!.visibility).toBe('private');
  expect(data.writes.some((write) => write.body.choice === 'calendar')).toBe(false);
  await page.getByRole('button', { name: 'Show fewer' }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/tmp/planner-home-phone.png', fullPage: false });
});

test('uploads a photo through the same persistent input and submits its capture reference', async ({ page }) => {
  const data = fixture(); data.failSubmission = false; await mock(page, data);
  await page.goto('/dashboard/lists');
  await page.getByRole('button', { name: 'Ask, add, or share…' }).click();
  await page.getByLabel('Photo or PDF').setInputFiles({ name: 'synthetic-poster.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=', 'base64') });
  await page.getByLabel('Message or recipe link').fill('Add this school poster');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(data.writes.find((write) => write.path === '/assistant/runs')?.body).toMatchObject({ text: 'Add this school poster', captureId: 'capture-fixture' });
  expect(new URL(page.url()).pathname).toBe('/dashboard/');
});

test('creates a reminder from a list and cancels it from saved plans', async ({ page }) => {
  const data = fixture(); await mock(page, data); await page.goto('/dashboard/lists');
  await page.getByText('Remind me', { exact: true }).click();
  await page.getByLabel('Reminder time').fill('2030-01-01T09:00');
  await page.getByRole('button', { name: 'Save reminder' }).click();
  await expect(page.getByText(/Reminder saved for you/)).toBeVisible();
  expect(data.writes.find((write) => write.path === '/reminders')?.body.parentId).toBe('beans');
  await page.getByRole('navigation').getByRole('link', { name: 'Home' }).click();
  await page.getByRole('link',{name:'More',exact:true}).click();
  await page.getByRole('link',{name:'Saved plans & suggestions'}).click();
  await page.getByRole('button', { name: 'Cancel reminder' }).click();
  await expect(page.getByRole('button', { name: 'Cancel reminder' })).not.toBeVisible();
});
test('uses browser dictation fallback, sends at speech end, and links to the submitted request', async ({ page }) => {
  const data = fixture(); data.failSubmission = false;
  data.runs[0]!.id = 'submitted-run'; data.runs[0]!.text = 'Add apples';
  await page.addInitScript(() => {
    // Explicitly exercise the fallback; local audio recording has separate tests.
    Object.defineProperty(window, 'MediaRecorder', { value: undefined, configurable: true });
    class Speech {
      onresult?: (event: unknown) => void; onend?: () => void; onspeechend?: () => void;
      start() { (window as unknown as { testSpeech: Speech }).testSpeech = this; }
      stop() { this.onresult?.({ results: [{ isFinal: true, 0: { transcript: 'Add apples' } }] }); this.onend?.(); }
      abort() {}
    }
    (window as unknown as { SpeechRecognition: typeof Speech }).SpeechRecognition = Speech;
  });
  await mock(page, data); await page.goto('/dashboard/');
  await page.getByRole('button', { name: 'Ask, add, or share…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/planner-voice-idle.png' });
  await dialog.getByRole('button', { name: 'Record voice' }).click();
  await expect(dialog.getByRole('button', { name: 'Finish recording' })).toBeVisible();
  await page.screenshot({ path: '/tmp/planner-voice-listening.png' });
  await page.evaluate(() => (window as unknown as { testSpeech: { onspeechend: () => void } }).testSpeech.onspeechend());
  await page.getByRole('link', { name: 'View request' }).click();
  await expect(page).toHaveURL(/\/requests\/submitted-run$/);
  await expect(page.getByRole('heading', { name: 'Your request' })).toBeVisible();
  await expect(page.locator('main > .preserve-lines')).toHaveText('Add apples');
  expect(data.writes.filter((entry) => entry.path === '/assistant/runs')).toEqual([{ path: '/assistant/runs', body: { clientId: expect.any(String), text: 'Add apples' } }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('shows kept deadlines on their local day without offering a calendar write', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-18T12:00:00Z'));
  const data = fixture(); data.runs = [];
  data.plans = [{ id: 'deadline-1', revision: 1, visibility: 'private', status: 'proposed', savedInPlanner: true, facts: { title: 'Permission slip due', category: 'school', participants: [], time: { kind: 'deadline', at: '2026-09-18T17:00:00-04:00', timezone: 'America/New_York' }, preparationTasks: [], unresolvedFields: [] } }];
  await mock(page, data); await page.goto('/dashboard/');
  await expect(page.getByRole('link', { name: 'Permission slip due' })).toBeVisible();
  await expect(page.getByText('Due Fri, Sep 18 · 5:00 PM')).toBeVisible();
  expect(data.writes.filter(write => write.path !== '/assistant/presence')).toHaveLength(0);
  expect(data.writes.some(write => write.path === '/assistant/presence' && write.body.visible === true)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: '/tmp/planner-deadline-phone.png', fullPage: false });
});

test('reviews a useful maintained knowledge suggestion inline', async ({ page }) => {
  const data = fixture(); data.knowledgeProposals = [{ id: 'proposal-1', operation: 'add', targetKeys: ['favorite_food'], baseRevisions: [0], proposedValue: 'Pasta', provenanceRefs: ['source-1'], reason: 'The source states this preference.', status: 'pending', createdAt: '2026-09-14T11:00:00Z', expiresAt: '2026-10-14T11:00:00Z' }];
  await mock(page, data); await page.goto('/dashboard/household');
  await expect(page.getByRole('heading', { name: 'Suggested knowledge updates' })).toBeVisible();
  await expect(page.getByText('Nothing → Pasta')).toBeVisible();
  await expect(page.getByText('The source states this preference.')).toBeVisible();
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByRole('heading', { name: 'Suggested knowledge updates' })).not.toBeVisible();
  expect(data.writes.some((write) => write.path === '/assistant/knowledge/proposals/proposal-1/accept')).toBe(true);
});
