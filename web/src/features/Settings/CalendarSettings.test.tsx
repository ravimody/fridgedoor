import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../../api/client.js';
import { CalendarSettings } from './CalendarSettings.js';
vi.mock('../../api/client.js', () => ({ apiFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('saves sources before the chosen destination and restores both on reopening', async () => {
  let calendars = [{ id: 'family', name: 'Family', selected: false, classification: 'household', accessRole: 'owner' }, { id: 'other', name: 'Other', selected: false, classification: 'personal', accessRole: 'reader' }];
  let destination: { id: string; name: string; active: boolean; ownCalendarSelectionId: string } | null = null;
  const writes: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'PUT') {
      writes.push(path);
      const input = JSON.parse(init.body as string);
      if (path === '/source-calendars') {
        expect(input.selections.map((item: { selected: boolean }) => item.selected)).toEqual([true, false]);
        calendars = calendars.map((calendar, index) => ({ ...calendar, ...input.selections[index] }));
      } else {
        expect(calendars[0]!.selected).toBe(true);
        expect(input).toEqual({ ownCalendarSelectionId: 'family', expectedRevision: 1 });
        destination = { id: 'binding', name: 'Family', active: true, ownCalendarSelectionId: 'family' };
      }
    }
    return { data: path === '/source-calendars' ? calendars : destination };
  });
  const revision = vi.fn();
  const first = render(<CalendarSettings status="active" revision={1} onRevisionChange={revision} />);
  fireEvent.click(await screen.findByRole('checkbox', { name: /Family/ }));
  expect(screen.getByRole('checkbox', { name: /Family/ })).toHaveAccessibleName('Family Can edit');
  expect(screen.getByRole('checkbox', { name: /Other/ })).toHaveAccessibleName('Other Read only');
  fireEvent.change(screen.getByLabelText('Write reviewed plans to'), { target: { value: 'family' } });
  expect(screen.getByLabelText('Write reviewed plans to')).toHaveValue('family');
  expect(writes).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Save calendar choices' }));
  expect(await screen.findByText('Calendar choices saved.')).toBeVisible();
  expect(writes).toEqual(['/source-calendars', '/destination']);
  expect(revision).toHaveBeenCalledWith(2);
  first.unmount();
  render(<CalendarSettings status="active" revision={2} onRevisionChange={revision} />);
  expect(await screen.findByRole('checkbox', { name: /Family/ })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Other/ })).not.toBeChecked();
  expect(screen.getByLabelText('Write reviewed plans to')).toHaveValue('family');
});

it('reports partial saves honestly when the destination write fails', async () => {
  const calendar = { id: 'family', name: 'Family', selected: true, classification: 'household', accessRole: 'owner' };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/destination' && init?.method === 'PUT') throw new Error('STALE_REVISION');
    return { data: path === '/source-calendars' ? [calendar] : null };
  });
  render(<CalendarSettings status="active" revision={1} onRevisionChange={vi.fn()} />);
  await screen.findByRole('checkbox', { name: /Family/ });
  fireEvent.change(screen.getByLabelText('Write reviewed plans to'), { target: { value: 'family' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save calendar choices' }));
  expect(await screen.findByText(/Sources saved, but the destination could not be saved/)).toBeVisible();
});

it('says who can change the household calendar when it belongs to another member', async () => {
  const calendar = { id: 'family', name: 'Family', selected: true, classification: 'household', accessRole: 'owner' };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/destination' && init?.method === 'PUT') throw new Error('DESTINATION_OWNER_ONLY');
    return { data: path === '/source-calendars' ? [calendar] : null };
  });
  render(<CalendarSettings status="active" revision={1} onRevisionChange={vi.fn()} />);
  await screen.findByRole('checkbox', { name: /Family/ });
  fireEvent.change(screen.getByLabelText('Write reviewed plans to'), { target: { value: 'family' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save calendar choices' }));
  expect(await screen.findByText(/belongs to another member; only they or the household owner can change it/)).toBeVisible();
});

it('explains empty calendars and refreshes status without discarding unsaved choices', async () => {
  const calendar = { id: 'family', name: 'Family', selected: true, classification: 'household', accessRole: 'owner', sync: { lastSuccessAt: '2026-09-13T20:00:00Z', imported: 2, upcoming: 0, stale: true, error: null } };
  vi.mocked(apiFetch).mockImplementation(async (path) => ({ data: path === '/source-calendars' ? [calendar] : null }));
  render(<CalendarSettings status="active" revision={1} onRevisionChange={vi.fn()} />);
  const checkbox = await screen.findByRole('checkbox', { name: /Family/ });
  expect(screen.getByText('2 imported events · 0 in the next seven days')).toBeVisible();
  expect(screen.getByText(/Sync is overdue/)).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Calendars to read' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Calendar for new events' })).toBeVisible();
  fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh sync status' }));
  await screen.findByText('Sync status refreshed. Unsaved choices are unchanged.');
  expect(checkbox).not.toBeChecked();
});
